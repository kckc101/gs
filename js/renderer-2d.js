// Fallback compositor for browsers without WebGL2. Simpler edges, no light wrap,
// but the same inputs and the same framing math as the WebGL renderer.
import { coverScale, edgeRange } from './renderer-gl.js';

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const canvas = () => document.createElement('canvas');

export class Canvas2DRenderer {
  constructor(target) {
    this.kind = 'basic';
    this.canvas = target;
    this.ctx = target.getContext('2d', { alpha: false });
    this.fg = canvas();
    this.fgx = this.fg.getContext('2d');
    this.mk = canvas();
    this.mkx = this.mk.getContext('2d');
    this.small = canvas();
    this.smallx = this.small.getContext('2d');
    this.plateC = canvas();
    this.platex = this.plateC.getContext('2d');
    this.prev = null;
    this.imgData = null;
    this.plateSig = '';
  }

  drawSource(c, src, sw, sh, W, H, mirror) {
    const [fx, fy] = coverScale(sw / sh, W / H);
    const cw = sw * fx;
    const ch = sh * fy;
    c.save();
    if (mirror) {
      c.translate(W, 0);
      c.scale(-1, 1);
    }
    c.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, W, H);
    c.restore();
  }

  updateMask(s) {
    const { mask, maskW: w, maskH: h } = s;
    const n = w * h;
    let first = false;
    if (!this.prev || this.prev.length !== n) {
      this.prev = new Float32Array(n);
      first = true;
    }
    if (this.mk.width !== w || this.mk.height !== h) {
      this.mk.width = w;
      this.mk.height = h;
      this.imgData = null;
    }
    if (!this.imgData) this.imgData = this.mkx.createImageData(w, h);
    const [lo, hi] = edgeRange(s.choke, s.feather);
    const d = this.imgData.data;
    const prev = this.prev;
    const keep = first ? 0 : s.stability;
    for (let i = 0; i < n; i++) {
      const v = mask[i] / 255;
      const p = prev[i];
      const k = keep * (1 - smooth(0.04, 0.3, Math.abs(v - p)));
      const m = v + (p - v) * k;
      prev[i] = m;
      d[i * 4 + 3] = smooth(lo, hi, m) * 255;
    }
    this.mkx.putImageData(this.imgData, 0, 0);
  }

  ensurePlate(p, W, H, amount) {
    const blur = amount * H * 0.03;
    const sig = `${p.key}|${W}|${H}|${p.zoom}|${p.x}|${p.y}|${blur.toFixed(1)}`;
    if (sig === this.plateSig) return;
    this.plateSig = sig;
    const c = this.plateC;
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const x = this.platex;
    const [fx, fy] = coverScale(p.w / p.h, W / H);
    const cw = (p.w * fx) / p.zoom;
    const ch = (p.h * fy) / p.zoom;
    const ox = (p.w - cw) / 2 + (p.x * (p.w - cw)) / 2;
    const oy = (p.h - ch) / 2 + (p.y * (p.h - ch)) / 2;
    const canFilter = typeof x.filter === 'string' && blur >= 0.6;
    // Overdraw by the blur radius so the filter does not pull transparent pixels in at the edges.
    const m = canFilter ? blur * 2 : 0;
    x.filter = canFilter ? `blur(${blur.toFixed(1)}px)` : 'none';
    x.drawImage(p.source, ox, oy, cw, ch, -m, -m, W + 2 * m, H + 2 * m);
    x.filter = 'none';
  }

  render(s) {
    const video = s.video;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const W = s.outW;
    const H = s.outH;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const ctx = this.ctx;
    if (s.mask && s.maskFresh) this.updateMask(s);

    const composite = s.mode !== 'none' && this.prev && (s.mode === 'blur' || s.plate);
    if (!composite) {
      this.drawSource(ctx, video, vw, vh, W, H, s.mirror);
      return true;
    }

    if (this.fg.width !== W || this.fg.height !== H) {
      this.fg.width = W;
      this.fg.height = H;
    }
    const f = this.fgx;
    f.globalCompositeOperation = 'copy';
    this.drawSource(f, video, vw, vh, W, H, s.mirror);
    f.globalCompositeOperation = 'destination-in';
    f.imageSmoothingEnabled = true;
    f.imageSmoothingQuality = 'high';
    this.drawSource(f, this.mk, this.mk.width, this.mk.height, W, H, s.mirror);
    f.globalCompositeOperation = 'source-over';

    if (s.mode === 'blur') {
      const div = 6 + s.blurStrength * 18;
      const sw = Math.max(8, Math.round(W / div));
      const sh = Math.max(8, Math.round(H / div));
      if (this.small.width !== sw || this.small.height !== sh) {
        this.small.width = sw;
        this.small.height = sh;
      }
      this.smallx.imageSmoothingQuality = 'high';
      this.drawSource(this.smallx, video, vw, vh, sw, sh, s.mirror);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.small, 0, 0, W, H);
    } else {
      this.ensurePlate(s.plate, W, H, s.plateBlur);
      ctx.drawImage(this.plateC, 0, 0);
    }
    ctx.drawImage(this.fg, 0, 0);
    return true;
  }

  snapshot() {
    return this.canvas;
  }
}
