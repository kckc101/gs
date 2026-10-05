// Background plates: built-in scenes drawn in code (so they fit any aspect ratio),
// and decoding of the user's own photos into a safe, upright, size-capped image.

const HEIC2ANY = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
const MAX_SIDE = 2560;

function rng(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

let grainTile = null;
function grain(ctx, w, h, alpha) {
  if (!grainTile) {
    grainTile = makeCanvas(128, 128);
    const g = grainTile.getContext('2d');
    const img = g.createImageData(128, 128);
    const r = rng(7);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = r() * 255;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = ctx.createPattern(grainTile, 'repeat');
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function vignette(ctx, w, h, strength) {
  const m = Math.max(w, h);
  const v = ctx.createRadialGradient(w / 2, h / 2, m * 0.3, w / 2, h / 2, m * 0.75);
  v.addColorStop(0, 'rgba(8, 8, 12, 0)');
  v.addColorStop(1, `rgba(8, 8, 12, ${strength})`);
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}

function drawStudio(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#3f434b');
  g.addColorStop(0.58, '#6f737c');
  g.addColorStop(0.7, '#7f838b');
  g.addColorStop(1, '#5b5e66');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const m = Math.max(w, h);
  const spot = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.45, m * 0.55);
  spot.addColorStop(0, 'rgba(255, 238, 214, 0.42)');
  spot.addColorStop(0.5, 'rgba(255, 238, 214, 0.12)');
  spot.addColorStop(1, 'rgba(255, 238, 214, 0)');
  ctx.fillStyle = spot;
  ctx.fillRect(0, 0, w, h);
  vignette(ctx, w, h, 0.5);
  grain(ctx, w, h, 0.05);
}

function ridge(ctx, w, h, base, amp, color, seed) {
  const r = rng(seed);
  const p1 = r() * 6;
  const p2 = r() * 6;
  const f1 = 1.5 + r() * 2;
  const f2 = 4 + r() * 4;
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i <= 96; i++) {
    const t = i / 96;
    const y = h * (base - amp * (0.6 * Math.sin(t * f1 * Math.PI + p1) + 0.4 * Math.sin(t * f2 * Math.PI + p2)));
    ctx.lineTo(t * w, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawDusk(ctx, w, h) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#121a38');
  sky.addColorStop(0.32, '#2e2f5e');
  sky.addColorStop(0.55, '#7b5079');
  sky.addColorStop(0.7, '#d9806a');
  sky.addColorStop(0.8, '#f2b178');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  const m = Math.max(w, h);
  const r = rng(11);
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = `rgba(255, 255, 255, ${0.2 + r() * 0.5})`;
    ctx.beginPath();
    ctx.arc(r() * w, r() * h * 0.38, (0.6 + r() * 1.2) * (m / 1920), 0, Math.PI * 2);
    ctx.fill();
  }
  const sun = ctx.createRadialGradient(w * 0.66, h * 0.78, 0, w * 0.66, h * 0.78, m * 0.42);
  sun.addColorStop(0, 'rgba(255, 196, 130, 0.6)');
  sun.addColorStop(1, 'rgba(255, 196, 130, 0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, h);
  ridge(ctx, w, h, 0.74, 0.035, '#3a2c4a', 3);
  ridge(ctx, w, h, 0.8, 0.05, '#251c33', 5);
  ridge(ctx, w, h, 0.88, 0.04, '#17121f', 9);
  grain(ctx, w, h, 0.04);
}

function drawBokeh(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#100d14');
  g.addColorStop(1, '#1d1420');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const r = rng(23);
  const m = Math.max(w, h);
  const hues = ['255,178,96', '255,126,112', '126,196,214', '255,220,160', '196,150,255'];
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 70; i++) {
    const x = r() * w;
    const y = (0.08 + r() * 0.84) * h;
    const rad = m * (0.015 + Math.pow(r(), 2.2) * 0.07);
    const a = 0.06 + r() * 0.2;
    const c = hues[Math.floor(r() * hues.length)];
    const gr = ctx.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `rgba(${c}, ${a * 0.7})`);
    gr.addColorStop(0.82, `rgba(${c}, ${a})`);
    gr.addColorStop(0.93, `rgba(${c}, ${a * 1.25})`);
    gr.addColorStop(1, `rgba(${c}, 0)`);
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  vignette(ctx, w, h, 0.55);
  grain(ctx, w, h, 0.035);
}

function drawChroma(ctx, w, h) {
  ctx.fillStyle = '#00b140';
  ctx.fillRect(0, 0, w, h);
}

export const BUILTINS = [
  { id: 'b:studio', name: 'Studio', draw: drawStudio },
  { id: 'b:dusk', name: 'Dusk', draw: drawDusk },
  { id: 'b:bokeh', name: 'Night bokeh', draw: drawBokeh },
  { id: 'b:chroma', name: 'Green screen', draw: drawChroma, chroma: true },
];

export function renderBuiltin(builtin, w, h) {
  const c = makeCanvas(w, h);
  builtin.draw(c.getContext('2d'), w, h);
  return c;
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode'));
    };
    img.src = url;
  });
}

function toBlob(c, type, quality) {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('This photo could not be saved.'))), type, quality);
  });
}

function looksHeic(file) {
  return /hei[cf]/i.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || '');
}

export function looksLikeImage(file) {
  return (
    (file.type || '').startsWith('image/') || /\.(jpe?g|png|webp|avif|gif|bmp|heic|heif|svg)$/i.test(file.name || '')
  );
}

let heicLoader = null;
function loadHeicConverter() {
  if (window.heic2any) return Promise.resolve(window.heic2any);
  heicLoader ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = HEIC2ANY;
    s.async = true;
    s.onload = () => (window.heic2any ? resolve(window.heic2any) : reject(new Error('converter missing')));
    s.onerror = () => reject(new Error('converter blocked'));
    document.head.append(s);
  }).catch((err) => {
    heicLoader = null;
    throw err;
  });
  return heicLoader;
}

// Decodes any photo the browser can open (HEIC is converted when the browser can't),
// applies EXIF rotation, caps the size for phone GPUs, and re-encodes it as JPEG.
export async function normalizeImageFile(file) {
  let img;
  try {
    img = await loadImage(file);
  } catch {
    if (!looksHeic(file)) {
      throw new Error(`${file.name || 'That file'} could not be opened. Try a JPG, PNG or WebP photo.`);
    }
    try {
      const convert = await loadHeicConverter();
      const out = await convert({ blob: file, toType: 'image/jpeg', quality: 0.92 });
      img = await loadImage(Array.isArray(out) ? out[0] : out);
    } catch {
      throw new Error('This HEIC photo could not be converted. Export it as JPG and try again.');
    }
  }
  const iw = img.naturalWidth || img.width || 1920;
  const ih = img.naturalHeight || img.height || 1080;
  const s = Math.min(1, MAX_SIDE / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * s));
  const h = Math.max(1, Math.round(ih * s));

  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; // transparent PNGs get a white backing instead of black
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await toBlob(c, 'image/jpeg', 0.92);

  const ts = Math.min(1, 360 / Math.max(w, h));
  const t = makeCanvas(Math.max(1, Math.round(w * ts)), Math.max(1, Math.round(h * ts)));
  const tctx = t.getContext('2d');
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(c, 0, 0, t.width, t.height);
  const thumb = await toBlob(t, 'image/jpeg', 0.82);

  // Release canvas memory right away; iOS caps the total canvas memory per page.
  c.width = 0;
  c.height = 0;
  t.width = 0;
  t.height = 0;
  return { blob, thumb, w, h };
}

export async function sourceFromBlob(blob) {
  const img = await loadImage(blob);
  const c = makeCanvas(img.naturalWidth || 1, img.naturalHeight || 1);
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}
