import { Segmenter, MODELS } from './segmenter.js';
import { GLRenderer } from './renderer-gl.js';
import { Canvas2DRenderer } from './renderer-2d.js';
import { BUILTINS, renderBuiltin, normalizeImageFile, sourceFromBlob, looksLikeImage } from './plates.js';
import { plateStore } from './store.js';

const $ = (id) => document.getElementById(id);
const ui = {
  stage: $('stage'),
  cam: $('cam'),
  out: $('out'),
  pipVideo: $('pip-video'),
  flash: $('flash'),
  readout: $('readout'),
  readoutText: $('readout-text'),
  btnPip: $('btn-pip'),
  btnFocus: $('btn-focus'),
  exitFocus: $('exit-focus'),
  controls: $('controls'),
  btnFlip: $('btn-flip'),
  btnShot: $('btn-shot'),
  btnRec: $('btn-rec'),
  recTime: $('rec-time'),
  gate: $('gate'),
  gateStart: $('gate-start'),
  gateBusy: $('gate-busy'),
  gateError: $('gate-error'),
  btnStart: $('btn-start'),
  engineLine: $('engine-line'),
  engineBar: $('engine-bar'),
  gateWarn: $('gate-warn'),
  btnCopyLink: $('btn-copy-link'),
  busyText: $('busy-text'),
  errTitle: $('err-title'),
  errBody: $('err-body'),
  btnRetry: $('btn-retry'),
  tiles: $('tiles'),
  file: $('file'),
  framing: $('framing'),
  zoom: $('s-zoom'),
  blurControls: $('blur-controls'),
  btnResetFraming: $('btn-reset-framing'),
  btnResetMatte: $('btn-reset-matte'),
  matteFields: $('matte-fields'),
  matteOffNote: $('matte-off-note'),
  selCamera: $('sel-camera'),
  selRes: $('sel-res'),
  selDelegate: $('sel-delegate'),
  basicNote: $('basic-note'),
  capture: $('capture'),
  capMedia: $('capture-media'),
  capName: $('capture-name'),
  capSave: $('capture-save'),
  capShare: $('capture-share'),
  capClose: $('capture-close'),
  toast: $('toast'),
  toastText: $('toast-text'),
  toastAction: $('toast-action'),
  install: $('btn-install'),
};

// ---------------------------------------------------------------- environment

const ua = navigator.userAgent;
const env = {
  ios: /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  android: /Android/i.test(ua),
  mac: /Macintosh/.test(ua),
  inApp: /FBAN|FBAV|FB_IAB|Instagram|Line\/|TikTok|musical_ly|Snapchat|MicroMessenger|Pinterest|LinkedInApp|; wv\)/i.test(ua),
  coarse: matchMedia('(pointer: coarse)').matches,
};
env.phone = env.coarse && Math.min(screen.width, screen.height) < 820;
// Best is the default; only clearly low-end devices start on Fast. Slow devices also
// fall back automatically at runtime (see adapt()).
const weakDevice = (navigator.deviceMemory || 8) <= 2 || (navigator.hardwareConcurrency || 8) <= 2;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---------------------------------------------------------------- settings

const STORAGE_KEY = 'backdrop.settings.v1';
const MATTE_DEFAULTS = { choke: 0.1, feather: 0.35, wrap: 0.3, match: 0.2, stability: 0.55 };
const DEFAULTS = {
  plate: 'b:studio',
  model: weakDevice ? 'fast' : 'best',
  delegate: 'auto',
  resolution: '720',
  facing: 'user',
  deviceId: '',
  mirror: true,
  recordAudio: true,
  plateBlur: 0.08,
  blurStrength: 0.55,
  framing: {},
  ...MATTE_DEFAULTS,
};
const RESOLUTIONS = { 480: [854, 480], 720: [1280, 720], 1080: [1920, 1080] };

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    saved = {};
  }
  const s = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in saved)) continue;
    if (typeof DEFAULTS[key] === typeof saved[key]) s[key] = saved[key];
  }
  if (!(s.model in MODELS)) s.model = DEFAULTS.model;
  if (!['auto', 'GPU', 'CPU'].includes(s.delegate)) s.delegate = 'auto';
  if (!(s.resolution in RESOLUTIONS)) s.resolution = '720';
  if (!s.framing || typeof s.framing !== 'object') s.framing = {};
  return s;
}

const settings = loadSettings();
let saveTimer = 0;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage blocked: settings last for this visit only.
    }
  }, 250);
}

// ---------------------------------------------------------------- runtime state

const rt = {
  renderer: null,
  seg: new Segmenter(),
  segState: 'idle',
  segProgress: 0,
  segHalted: false,
  engineToken: 0,
  camState: 'idle',
  camToken: 0,
  stream: null,
  track: null,
  devices: [],
  targetFps: 30,
  loopToken: 0,
  lastFrameAt: 0,
  frameNo: 0,
  segEvery: 1,
  segMs: 0,
  fps: 0,
  fpsFrames: 0,
  fpsT0: 0,
  slowSeconds: 0,
  slowWarned: false,
  outW: 0,
  outH: 0,
  plate: null,
  plateToken: 0,
  plateSerial: 0,
  snapshotPending: false,
  recorder: null,
  recStart: 0,
  recTimer: 0,
  lockedSize: null,
  pipStream: null,
  wakeLock: null,
  captureUrl: null,
  retry: null,
};

const plates = new Map();

// ---------------------------------------------------------------- helpers

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const modeOf = (id) => (id === 'off' ? 'none' : id === 'blur' ? 'blur' : 'image');
const camLive = () => rt.camState === 'live';

let toastTimer = 0;
function toast(text, { action, onAction, ms = 4500 } = {}) {
  ui.toastText.textContent = text;
  ui.toastAction.hidden = !action;
  if (action) {
    ui.toastAction.textContent = action;
    ui.toastAction.onclick = () => {
      hideToast();
      onAction?.();
    };
  }
  ui.toast.hidden = false;
  requestAnimationFrame(() => ui.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? Math.max(ms, 7000) : ms);
}

function hideToast() {
  clearTimeout(toastTimer);
  ui.toast.classList.remove('show');
  toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, 250);
}

function showGate(which, info = {}) {
  ui.gate.hidden = which === 'none';
  ui.gateStart.hidden = which !== 'start';
  ui.gateBusy.hidden = which !== 'busy';
  ui.gateError.hidden = which !== 'error';
  ui.controls.hidden = which !== 'none';
  if (which === 'busy') ui.busyText.textContent = info.text || 'Starting camera…';
  if (which === 'error') {
    ui.errTitle.textContent = info.title || 'Something went wrong';
    ui.errBody.textContent = info.body || '';
    ui.btnRetry.hidden = !info.retry;
    ui.btnRetry.textContent = info.retryLabel || 'Try again';
    rt.retry = info.retry || null;
  }
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------- renderer

function makeRenderer() {
  const gl = GLRenderer.create(ui.out);
  if (gl) return gl;
  // A canvas that already tried WebGL cannot switch to 2D, so swap in a fresh one.
  const fresh = document.createElement('canvas');
  fresh.id = 'out';
  fresh.className = ui.out.className;
  fresh.setAttribute('role', 'img');
  fresh.setAttribute('aria-label', ui.out.getAttribute('aria-label') || 'Live camera preview');
  ui.out.replaceWith(fresh);
  ui.out = fresh;
  return new Canvas2DRenderer(fresh);
}

// ---------------------------------------------------------------- readout

let readoutQueued = false;
function renderReadoutSoon() {
  if (readoutQueued) return;
  readoutQueued = true;
  requestAnimationFrame(() => {
    readoutQueued = false;
    renderReadout();
  });
}

function renderReadout() {
  let text;
  let state;
  const pct = Math.round(rt.segProgress * 100);
  if (rt.segState === 'loading') {
    text = `Loading cutout ${pct}%`;
    state = 'busy';
  } else if (rt.segState === 'error') {
    text = 'Cutout unavailable';
    state = 'error';
  } else if (camLive()) {
    const v = ui.cam;
    const parts = [`${Math.min(v.videoWidth, v.videoHeight)}p`];
    if (rt.fps) parts.push(`${rt.fps} fps`);
    if (rt.seg.ready) parts.push(rt.seg.delegate, MODELS[rt.seg.model].name);
    if (rt.renderer?.kind === 'basic') parts.push('Basic');
    text = parts.join(' · ');
    state = 'live';
  } else {
    text = rt.segState === 'ready' ? 'Ready' : 'Starting';
    state = 'idle';
  }
  if (rt.recorder) state = 'rec';
  ui.readoutText.textContent = text;
  ui.readout.dataset.state = state;

  ui.engineLine.textContent =
    rt.segState === 'ready'
      ? 'Cutout engine ready'
      : rt.segState === 'error'
        ? 'Cutout engine failed to load'
        : `Loading cutout engine · ${pct}%`;
  ui.engineBar.style.transform = `scaleX(${rt.segState === 'ready' ? 1 : rt.segProgress})`;
}

// ---------------------------------------------------------------- cutout engine

async function loadEngine(model = settings.model, delegate = settings.delegate) {
  const token = ++rt.engineToken;
  rt.segState = 'loading';
  rt.segProgress = 0;
  renderReadout();
  try {
    await rt.seg.load(model, delegate, (p) => {
      if (token !== rt.engineToken) return;
      rt.segProgress = p;
      renderReadoutSoon();
    });
    if (token !== rt.engineToken) return;
    rt.segState = 'ready';
    rt.segHalted = false;
    rt.segEvery = 1;
    rt.segMs = 0;
    rt.slowSeconds = 0;
  } catch (err) {
    if (token !== rt.engineToken || err?.name === 'Superseded') return;
    console.error('Cutout engine failed', err);
    if (model === 'best') {
      settings.model = 'fast';
      saveSettings();
      syncControls();
      toast('The Best cutout could not start on this device, so Backdrop switched to Fast.');
      return loadEngine('fast', delegate);
    }
    rt.segState = 'error';
    toast('The cutout engine could not load. Check your connection, then reload.', {
      action: 'Reload',
      onAction: () => location.reload(),
    });
  }
  renderReadout();
}

function onSegmentError(err) {
  console.error('Segmentation failed', err);
  if (rt.segHalted) return;
  // Stop feeding the failing engine; frames show the plain camera until a replacement is ready.
  rt.segHalted = true;
  if (rt.seg.delegate === 'GPU' && settings.delegate !== 'GPU') {
    toast('The graphics chip could not run the cutout, so Backdrop switched to the processor.');
    loadEngine(settings.model, 'CPU');
  } else {
    rt.segState = 'error';
    renderReadout();
    toast('The cutout stopped working.', { action: 'Reload', onAction: () => location.reload() });
  }
}

function setModel(model) {
  if (!(model in MODELS) || model === settings.model) return;
  settings.model = model;
  saveSettings();
  syncControls();
  loadEngine();
}

// ---------------------------------------------------------------- camera

function permissionHelp() {
  if (env.ios) {
    return 'Open the Settings app, find your browser (Safari, Chrome…), set Camera to Allow, then reload this page.';
  }
  if (env.android) {
    return 'Tap the icon at the left of the address bar, open Permissions, allow Camera, then reload this page.';
  }
  if (env.mac) {
    return 'Click the camera icon in the address bar and allow it. Also check System Settings › Privacy & Security › Camera for your browser, then reload.';
  }
  return 'Click the camera or lock icon in the address bar and allow the camera. On Windows, also check Settings › Privacy & security › Camera, then reload.';
}

function cameraError(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return { title: 'Camera access is blocked', body: permissionHelp(), retry: () => startCamera() };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return {
      title: 'No camera found',
      body: 'Connect a camera or turn it on, then try again.',
      retry: () => startCamera(),
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return {
      title: 'Your camera is busy',
      body: 'Another app is using the camera. Close Zoom, Teams, OBS or any other camera app, then try again.',
      retry: () => startCamera(),
    };
  }
  return {
    title: 'The camera could not start',
    body: err?.message || 'Try again, or reload the page.',
    retry: () => startCamera(),
  };
}

function environmentProblem() {
  if (!window.isSecureContext) {
    return {
      title: 'Open Backdrop from a secure address',
      body: 'Browsers only allow the camera on https:// pages and on localhost. Open the https:// link, or start Backdrop with the included server on this computer.',
    };
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return {
      title: 'This browser cannot use the camera',
      body: env.inApp
        ? 'You opened this inside another app. Open the link in Safari or Chrome instead.'
        : 'Open Backdrop in a current version of Chrome, Edge, Safari or Firefox.',
    };
  }
  if (typeof WebAssembly !== 'object') {
    return {
      title: 'This browser is too old',
      body: 'Backdrop needs WebAssembly. Update your browser, or open Backdrop in Chrome, Edge, Safari or Firefox.',
    };
  }
  return null;
}

function stopCamera() {
  rt.loopToken++;
  if (rt.stream) for (const t of rt.stream.getTracks()) t.stop();
  rt.stream = null;
  rt.track = null;
  ui.cam.srcObject = null;
  releaseWakeLock();
}

function waitForVideo(v, timeout = 6000) {
  return new Promise((resolve) => {
    if (v.videoWidth && v.readyState >= 2) return resolve(true);
    const done = (ok) => {
      clearTimeout(timer);
      v.removeEventListener('loadeddata', check);
      v.removeEventListener('resize', check);
      resolve(ok);
    };
    const check = () => {
      if (v.videoWidth && v.readyState >= 2) done(true);
    };
    const timer = setTimeout(() => done(!!v.videoWidth), timeout);
    v.addEventListener('loadeddata', check);
    v.addEventListener('resize', check);
  });
}

async function startCamera() {
  const problem = environmentProblem();
  if (problem) {
    showGate('error', problem);
    return;
  }
  const token = ++rt.camToken;
  stopCamera();
  rt.camState = 'starting';
  showGate('busy', { text: 'Starting camera…' });

  const [w, h] = RESOLUTIONS[settings.resolution];
  const want = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30, max: 30 } };
  const pick = settings.deviceId ? { deviceId: { exact: settings.deviceId } } : { facingMode: settings.facing };
  // Each fallback asks for less, so odd cameras and strict browsers still open.
  const attempts = [{ ...want, ...pick }, pick, { ...want }, true];
  let stream = null;
  let lastError = null;
  for (const video of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      break;
    } catch (err) {
      lastError = err;
      if (['NotAllowedError', 'SecurityError', 'PermissionDeniedError'].includes(err?.name)) break;
    }
  }
  if (token !== rt.camToken) {
    stream?.getTracks().forEach((t) => t.stop());
    return;
  }
  if (!stream) {
    rt.camState = 'error';
    showGate('error', cameraError(lastError));
    return;
  }

  rt.stream = stream;
  rt.track = stream.getVideoTracks()[0];
  rt.track.addEventListener('ended', onTrackEnded);
  const fr = rt.track.getSettings?.().frameRate;
  rt.targetFps = clamp(Math.round(fr || 30), 10, 30);

  const v = ui.cam;
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  try {
    await v.play();
  } catch {
    // Some browsers still need a tap to start video; the gate button below covers it.
  }
  const ok = await waitForVideo(v);
  if (token !== rt.camToken) return;
  if (!ok || v.paused) {
    rt.camState = 'error';
    showGate('error', {
      title: 'Tap to start the video',
      body: 'Your browser paused the camera preview until you tap.',
      retry: async () => {
        try {
          await v.play();
        } catch {
          // Ignore; we retry below.
        }
        if (v.videoWidth) goLive();
        else startCamera();
      },
      retryLabel: 'Start video',
    });
    return;
  }
  goLive();
  refreshDevices();
}

function goLive() {
  rt.camState = 'live';
  rt.fps = 0;
  rt.fpsFrames = 0;
  rt.fpsT0 = 0;
  showGate('none');
  requestWakeLock();
  startLoop();
  renderReadout();
}

function onTrackEnded() {
  if (rt.camState !== 'live') return;
  rt.camState = 'error';
  rt.loopToken++;
  if (document.hidden) {
    rt.restartOnReturn = true;
    return;
  }
  showGate('error', {
    title: 'The camera disconnected',
    body: 'It was unplugged, switched off, or taken by another app.',
    retry: () => startCamera(),
    retryLabel: 'Reconnect',
  });
}

async function refreshDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    rt.devices = all.filter((d) => d.kind === 'videoinput');
  } catch {
    rt.devices = [];
  }
  const current = settings.deviceId;
  const options = [new Option('Default camera', '')];
  rt.devices.forEach((d, i) => options.push(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  ui.selCamera.replaceChildren(...options);
  ui.selCamera.value = rt.devices.some((d) => d.deviceId === current) ? current : '';
  ui.btnFlip.hidden = rt.devices.length < 2;
}

function flipCamera() {
  if (env.coarse || rt.devices.length < 2) {
    settings.facing = settings.facing === 'user' ? 'environment' : 'user';
    settings.deviceId = '';
    settings.mirror = settings.facing === 'user';
  } else {
    // Desktop cameras rarely report a facing mode, so step through the list instead.
    const ids = rt.devices.map((d) => d.deviceId);
    const now = rt.track?.getSettings?.().deviceId || settings.deviceId;
    settings.deviceId = ids[(ids.indexOf(now) + 1) % ids.length] || '';
  }
  saveSettings();
  syncControls();
  startCamera();
}

// ---------------------------------------------------------------- wake lock

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || rt.wakeLock || document.visibilityState !== 'visible') return;
  try {
    rt.wakeLock = await navigator.wakeLock.request('screen');
    rt.wakeLock.addEventListener('release', () => {
      rt.wakeLock = null;
    });
  } catch {
    // Not granted (battery saver, unsupported). The screen may dim; that's all.
  }
}

function releaseWakeLock() {
  rt.wakeLock?.release().catch(() => {});
  rt.wakeLock = null;
}

// ---------------------------------------------------------------- render loop

// Hidden tabs throttle requestAnimationFrame to zero. While the preview is popped out
// or recording, a worker timer keeps frames flowing.
const ticker = (() => {
  let worker = null;
  let pending = null;
  try {
    const src = 'onmessage = (e) => { setTimeout(() => postMessage(0), e.data); };';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = () => {
      const fn = pending;
      pending = null;
      fn?.();
    };
  } catch {
    worker = null;
  }
  return {
    once(ms, fn) {
      if (worker) {
        pending = fn;
        worker.postMessage(ms);
      } else {
        setTimeout(fn, ms);
      }
    },
  };
})();

const keepAlive = () => !!rt.recorder || !!document.pictureInPictureElement;

function startLoop() {
  const token = ++rt.loopToken;
  const step = (now) => {
    if (token !== rt.loopToken) return;
    try {
      frame(typeof now === 'number' ? now : performance.now());
    } catch (err) {
      console.error('Frame failed', err);
    }
    schedule();
  };
  const schedule = () => {
    if (token !== rt.loopToken || !camLive()) return;
    if (!document.hidden) requestAnimationFrame(step);
    else if (keepAlive()) ticker.once(1000 / rt.targetFps, step);
    // Otherwise the loop rests until the page is visible again.
  };
  schedule();
}

function outputSize(vw, vh) {
  if (rt.lockedSize) return rt.lockedSize;
  const s = Math.min(1, 1920 / Math.max(vw, vh));
  return [Math.max(2, Math.round(vw * s) & ~1), Math.max(2, Math.round(vh * s) & ~1)];
}

function framingFor(id) {
  const f = settings.framing[id];
  if (!f) return { z: 1, x: 0, y: 0 };
  return { z: clamp(Number(f.z) || 1, 1, 3), x: clamp(Number(f.x) || 0, -1, 1), y: clamp(Number(f.y) || 0, -1, 1) };
}

function plateForFrame(W, H) {
  const p = rt.plate;
  if (!p) return null;
  if (p.builtin) {
    // Built-in scenes are redrawn to match the output orientation instead of being cropped.
    const portrait = H > W;
    if (p.portrait !== portrait) {
      const src = renderBuiltin(p.builtin, portrait ? 1080 : 1920, portrait ? 1920 : 1080);
      p.source = src;
      p.w = src.width;
      p.h = src.height;
      p.portrait = portrait;
      p.key = `${p.id}#${++rt.plateSerial}`;
    }
  }
  const f = framingFor(p.id);
  return { key: p.key, source: p.source, w: p.w, h: p.h, zoom: f.z, x: f.x, y: f.y };
}

function frame(now) {
  const v = ui.cam;
  if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) return;
  if (v.paused) v.play().catch(() => {});
  if (now - rt.lastFrameAt < 1000 / rt.targetFps - 4) return;
  rt.lastFrameAt = now;

  let mode = modeOf(settings.plate);
  if (mode === 'image' && !rt.plate) mode = 'none';

  // While a different model downloads, the current one keeps running (it is swapped only once the new one is ready).
  if (rt.segHalted) mode = 'none';
  let fresh = false;
  if (mode !== 'none' && rt.seg.ready) {
    if (rt.frameNo % rt.segEvery === 0) {
      const t0 = performance.now();
      try {
        fresh = rt.seg.segment(v, now);
      } catch (err) {
        onSegmentError(err);
      }
      const dt = performance.now() - t0;
      rt.segMs = rt.segMs ? rt.segMs * 0.9 + dt * 0.1 : dt;
    }
  }
  rt.frameNo++;

  const [W, H] = outputSize(v.videoWidth, v.videoHeight);
  rt.outW = W;
  rt.outH = H;
  const chroma = mode === 'image' && rt.plate?.chroma;
  rt.renderer.render({
    video: v,
    outW: W,
    outH: H,
    mode,
    mirror: settings.mirror,
    mask: fresh ? rt.seg.mask : null,
    maskW: rt.seg.maskW,
    maskH: rt.seg.maskH,
    maskFresh: fresh,
    plate: mode === 'image' ? plateForFrame(W, H) : null,
    choke: settings.choke,
    feather: chroma ? Math.min(settings.feather, 0.25) : settings.feather,
    wrap: chroma ? 0 : settings.wrap,
    match: chroma ? 0 : settings.match,
    plateBlur: chroma ? 0 : settings.plateBlur,
    blurStrength: settings.blurStrength,
    stability: settings.stability,
    refineMax: env.phone ? 720 : 960,
  });

  if (rt.snapshotPending) {
    rt.snapshotPending = false;
    finishSnapshot();
  }
  tallyFps(now);
}

function tallyFps(now) {
  rt.fpsFrames++;
  if (!rt.fpsT0) rt.fpsT0 = now;
  const dt = now - rt.fpsT0;
  if (dt < 1000) return;
  rt.fps = Math.round((rt.fpsFrames * 1000) / dt);
  rt.fpsFrames = 0;
  rt.fpsT0 = now;
  adapt();
  renderReadout();
}

// Skips segmentation on some frames when the device can't keep up; the smoothed mask fills the gap.
function adapt() {
  const budget = 1000 / rt.targetFps;
  if (rt.segMs > budget * 0.55 && rt.segEvery < 3) rt.segEvery++;
  else if (rt.segMs < budget * 0.25 && rt.segEvery > 1) rt.segEvery--;
  if (document.hidden || rt.segState !== 'ready') return;
  if (settings.model === 'best' && rt.fps && rt.fps < rt.targetFps * 0.5) rt.slowSeconds++;
  else rt.slowSeconds = 0;
  if (rt.slowSeconds >= 6 && !rt.slowWarned) {
    rt.slowWarned = true;
    setModel('fast');
    toast('Switched to the Fast cutout to keep your video smooth on this device.', {
      action: 'Keep Best',
      onAction: () => setModel('best'),
    });
  }
}

// ---------------------------------------------------------------- backgrounds

function tileArt(kind, src) {
  const span = document.createElement('span');
  span.className = `tile-art tile-${kind}`;
  if (src) {
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.src = src;
    span.append(img);
  }
  if (kind === 'off' || kind === 'blur') {
    span.insertAdjacentHTML('beforeend', '<svg class="ico" aria-hidden="true"><use href="#i-person"/></svg>');
  }
  if (kind === 'add') {
    span.insertAdjacentHTML('beforeend', '<svg class="ico" aria-hidden="true"><use href="#i-plus"/></svg>');
  }
  return span;
}

function renderTiles() {
  const frag = document.createDocumentFragment();
  const add = (id, name, art, removable) => {
    const wrap = document.createElement('div');
    wrap.className = 'tile-wrap';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tile';
    b.dataset.id = id;
    if (id !== 'add') b.setAttribute('aria-pressed', String(settings.plate === id));
    const label = document.createElement('span');
    label.className = 'tile-name';
    label.textContent = name;
    b.append(art, label);
    wrap.append(b);
    if (removable) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'tile-remove';
      x.dataset.remove = id;
      x.setAttribute('aria-label', `Remove ${name}`);
      x.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-x"/></svg>';
      wrap.append(x);
    }
    frag.append(wrap);
  };
  add('off', 'Off', tileArt('off'), false);
  add('blur', 'Blur', tileArt('blur'), false);
  for (const p of plates.values()) add(p.id, p.name, tileArt('photo', p.thumbUrl), p.kind === 'user');
  add('add', 'Add photo', tileArt('add'), false);
  ui.tiles.replaceChildren(frag);
}

function updateTilePressed() {
  for (const b of ui.tiles.querySelectorAll('.tile[aria-pressed]')) {
    b.setAttribute('aria-pressed', String(b.dataset.id === settings.plate));
  }
}

function userPlateEntry(rec) {
  return {
    id: rec.id,
    name: rec.name,
    kind: 'user',
    blob: rec.blob,
    thumb: rec.thumb,
    thumbUrl: URL.createObjectURL(rec.thumb),
    w: rec.w,
    h: rec.h,
    added: rec.added,
  };
}

async function initPlates() {
  for (const b of BUILTINS) {
    plates.set(b.id, {
      id: b.id,
      name: b.name,
      kind: 'builtin',
      builtin: b,
      chroma: !!b.chroma,
      thumbUrl: renderBuiltin(b, 320, 200).toDataURL('image/jpeg', 0.85),
    });
  }
  const recs = await plateStore.all();
  recs.sort((a, b) => (a.added || 0) - (b.added || 0));
  for (const rec of recs) {
    if (rec && rec.id && rec.blob && rec.thumb) plates.set(rec.id, userPlateEntry(rec));
  }
  renderTiles();
}

async function selectPlate(id) {
  if (id !== 'off' && id !== 'blur' && !plates.has(id)) id = DEFAULTS.plate;
  settings.plate = id;
  saveSettings();
  updateTilePressed();
  syncPanels();
  const token = ++rt.plateToken;
  if (id === 'off' || id === 'blur') {
    updateGateBackdrop();
    return;
  }
  const p = plates.get(id);
  updateGateBackdrop();
  if (p.kind === 'builtin') {
    rt.plate = { id, builtin: p.builtin, chroma: p.chroma, portrait: null, source: null, w: 1, h: 1, key: '' };
    return;
  }
  try {
    const source = await sourceFromBlob(p.blob);
    if (token !== rt.plateToken) return;
    rt.plate = { id, source, w: source.width, h: source.height, chroma: false, key: `${id}#${++rt.plateSerial}` };
  } catch {
    if (token !== rt.plateToken) return;
    toast('That photo could not be opened. Pick another one.');
    selectPlate(DEFAULTS.plate);
  }
}

function updateGateBackdrop() {
  const p = plates.get(settings.plate) || plates.get(DEFAULTS.plate);
  if (p) ui.gate.style.setProperty('--gate-img', `url("${p.thumbUrl}")`);
}

async function addFiles(list) {
  const files = [...(list || [])].filter(Boolean);
  if (!files.length) return;
  const images = files.filter(looksLikeImage);
  if (!images.length) {
    toast("That file isn't a photo. Choose a JPG, PNG, WebP or HEIC image.");
    return;
  }
  let lastId = null;
  toast(images.length > 1 ? `Adding ${images.length} photos…` : 'Adding photo…', { ms: 20000 });
  for (const file of images) {
    try {
      const norm = await normalizeImageFile(file);
      const rec = {
        id: `u:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        name: (file.name || 'Photo').replace(/\.[a-z0-9]+$/i, '') || 'Photo',
        blob: norm.blob,
        thumb: norm.thumb,
        w: norm.w,
        h: norm.h,
        added: Date.now(),
      };
      await plateStore.put(rec);
      plates.set(rec.id, userPlateEntry(rec));
      lastId = rec.id;
    } catch (err) {
      toast(err?.message || 'That photo could not be opened.');
    }
  }
  if (!lastId) return;
  renderTiles();
  await selectPlate(lastId);
  if (!plateStore.persistent) {
    toast('This browser is blocking storage, so your photos will be gone when you close the page.');
  } else {
    hideToast();
    if (navigator.storage?.persist && !/Firefox\//.test(ua)) navigator.storage.persist().catch(() => {});
  }
}

async function removePlate(id) {
  const p = plates.get(id);
  if (!p || p.kind !== 'user') return;
  plates.delete(id);
  await plateStore.del(id);
  renderTiles();
  if (settings.plate === id) selectPlate(DEFAULTS.plate);
  delete settings.framing[id];
  saveSettings();
  toast(`Removed ${p.name}`, {
    action: 'Undo',
    onAction: async () => {
      const rec = { id: p.id, name: p.name, blob: p.blob, thumb: p.thumb, w: p.w, h: p.h, added: p.added };
      await plateStore.put(rec);
      plates.set(rec.id, p);
      renderTiles();
      selectPlate(rec.id);
    },
  });
}

// ---------------------------------------------------------------- framing gestures

function setFraming(patch) {
  const id = settings.plate;
  if (modeOf(id) !== 'image') return;
  const f = { ...framingFor(id), ...patch };
  f.z = clamp(f.z, 1, 3);
  f.x = clamp(f.x, -1, 1);
  f.y = clamp(f.y, -1, 1);
  settings.framing[id] = f;
  saveSettings();
  if (document.activeElement !== ui.zoom) {
    ui.zoom.value = f.z;
    paintRange(ui.zoom);
  }
}

function panBy(dx, dy) {
  const p = rt.plate;
  if (!p || !rt.outW) return;
  const rect = ui.out.getBoundingClientRect();
  const ar = rt.outW / rt.outH;
  const dw = Math.min(rect.width, rect.height * ar);
  const dh = dw / ar;
  const f = framingFor(p.id);
  const cover = p.w / p.h > ar ? [ar / (p.w / p.h), 1] : [1, p.w / p.h / ar];
  const sx = cover[0] / f.z;
  const sy = cover[1] / f.z;
  const nx = sx < 0.999 ? f.x - ((dx / dw) * sx * 2) / (1 - sx) : 0;
  const ny = sy < 0.999 ? f.y - ((dy / dh) * sy * 2) / (1 - sy) : 0;
  setFraming({ x: nx, y: ny });
}

function bindGestures() {
  const pointers = new Map();
  let pinch = null;
  const canFrame = (e) =>
    camLive() && modeOf(settings.plate) === 'image' && (e.target === ui.out || e.target === ui.cam);
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  };

  ui.stage.addEventListener('pointerdown', (e) => {
    if (!canFrame(e)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      ui.stage.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety.
    }
    ui.stage.classList.add('panning');
    if (pointers.size === 2) pinch = { d: spread(), z: framingFor(settings.plate).z };
  });
  ui.stage.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const next = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, next);
    if (pointers.size === 1) panBy(next.x - prev.x, next.y - prev.y);
    else if (pinch) setFraming({ z: (pinch.z * spread()) / pinch.d });
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) ui.stage.classList.remove('panning');
  };
  ui.stage.addEventListener('pointerup', end);
  ui.stage.addEventListener('pointercancel', end);
  ui.stage.addEventListener(
    'wheel',
    (e) => {
      if (!canFrame(e)) return;
      e.preventDefault();
      setFraming({ z: framingFor(settings.plate).z * Math.exp(-e.deltaY * 0.0015) });
    },
    { passive: false },
  );
  ui.stage.addEventListener('dblclick', (e) => {
    if (canFrame(e)) setFraming({ z: 1, x: 0, y: 0 });
  });
}

// ---------------------------------------------------------------- captures

function flash() {
  if (reducedMotion.matches) return;
  ui.flash.classList.remove('on');
  void ui.flash.offsetWidth;
  ui.flash.classList.add('on');
}

function snapshot() {
  if (!camLive() || document.hidden) return;
  rt.snapshotPending = true;
  flash();
}

function finishSnapshot() {
  let canvas;
  try {
    canvas = rt.renderer.snapshot();
  } catch (err) {
    console.error(err);
    toast('The photo could not be taken. Try again.');
    return;
  }
  canvas.toBlob(
    (blob) => {
      if (blob) showCapture(blob);
      else toast('The photo could not be taken. Try again.');
    },
    'image/jpeg',
    0.95,
  );
}

function showCapture(blob) {
  const isVideo = blob.type.startsWith('video/');
  const ext = isVideo ? (blob.type.includes('mp4') ? 'mp4' : 'webm') : 'jpg';
  const name = `backdrop-${stamp()}.${ext}`;
  if (rt.captureUrl) URL.revokeObjectURL(rt.captureUrl);
  rt.captureUrl = URL.createObjectURL(blob);

  let media;
  if (isVideo) {
    media = document.createElement('video');
    media.muted = true;
    media.loop = true;
    media.playsInline = true;
    media.autoplay = true;
    media.controls = false;
  } else {
    media = document.createElement('img');
    media.alt = 'Your photo';
  }
  media.src = rt.captureUrl;
  ui.capMedia.replaceChildren(media);
  if (isVideo) media.play().catch(() => {});

  ui.capName.textContent = name;
  ui.capSave.href = rt.captureUrl;
  ui.capSave.download = name;

  const file = new File([blob], name, { type: blob.type });
  const canShare = !!navigator.canShare && (() => {
    try {
      return navigator.canShare({ files: [file] });
    } catch {
      return false;
    }
  })();
  ui.capShare.hidden = !canShare;
  ui.capShare.onclick = () => {
    navigator.share({ files: [file], title: 'Backdrop' }).catch((err) => {
      if (err?.name !== 'AbortError') toast('Sharing did not work here. Use Save instead.');
    });
  };
  ui.capture.hidden = false;
}

function closeCapture() {
  ui.capture.hidden = true;
  ui.capMedia.replaceChildren();
  if (rt.captureUrl) URL.revokeObjectURL(rt.captureUrl);
  rt.captureUrl = null;
}

function pickRecorderType() {
  const types = [
    'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return (
    types.find((t) => {
      try {
        return MediaRecorder.isTypeSupported(t);
      } catch {
        return false;
      }
    }) || ''
  );
}

function updateRecUI() {
  const on = !!rt.recorder;
  ui.btnRec.classList.toggle('on', on);
  ui.btnRec.setAttribute('aria-label', on ? 'Stop recording' : 'Start recording');
  ui.recTime.textContent = on ? formatTime(performance.now() - rt.recStart) : '0:00';
  renderReadout();
}

async function toggleRecording() {
  if (rt.recorder) {
    if (rt.recorder.state !== 'inactive') rt.recorder.stop();
    return;
  }
  if (!camLive()) return;
  if (!window.MediaRecorder || typeof ui.out.captureStream !== 'function') {
    toast('This browser cannot record video. Take photos instead, or use Chrome, Edge, Safari or Firefox.');
    return;
  }
  const type = pickRecorderType();
  const W = rt.outW;
  const H = rt.outH;
  // Lock the frame size: encoders break if the canvas changes size mid-clip (phone rotation).
  rt.lockedSize = [W, H];
  const stream = ui.out.captureStream(rt.targetFps);
  let mic = null;
  if (settings.recordAudio) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      for (const t of mic.getAudioTracks()) stream.addTrack(t);
    } catch {
      toast('Recording without sound: the microphone is not available.');
    }
  }
  let rec;
  try {
    rec = new MediaRecorder(stream, {
      ...(type ? { mimeType: type } : {}),
      videoBitsPerSecond: Math.round(W * H * rt.targetFps * 0.12),
    });
  } catch {
    try {
      rec = new MediaRecorder(stream);
    } catch (err) {
      rt.lockedSize = null;
      for (const t of stream.getTracks()) t.stop();
      mic?.getTracks().forEach((t) => t.stop());
      toast('Recording could not start in this browser.');
      console.error(err);
      return;
    }
  }
  const chunks = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  rec.onstop = () => {
    for (const t of stream.getTracks()) t.stop();
    mic?.getTracks().forEach((t) => t.stop());
    clearInterval(rt.recTimer);
    rt.recorder = null;
    rt.lockedSize = null;
    updateRecUI();
    const blob = new Blob(chunks, { type: (rec.mimeType || type || 'video/webm').split(';')[0] });
    if (blob.size) showCapture(blob);
    else toast('The recording came out empty. Try again.');
  };
  rec.onerror = (e) => {
    console.error('Recorder error', e);
    toast('Recording stopped because of an error.');
    if (rec.state !== 'inactive') rec.stop();
  };
  rec.start(1000);
  rt.recorder = rec;
  rt.recStart = performance.now();
  rt.recTimer = setInterval(updateRecUI, 250);
  updateRecUI();
}

// ---------------------------------------------------------------- pop-out and focus view

const pipSupported =
  'pictureInPictureEnabled' in document &&
  document.pictureInPictureEnabled &&
  typeof HTMLCanvasElement.prototype.captureStream === 'function';

async function togglePip() {
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return;
    }
    if (!camLive()) {
      toast('Start the camera first.');
      return;
    }
    const v = ui.pipVideo;
    rt.pipStream = ui.out.captureStream(rt.targetFps);
    v.srcObject = rt.pipStream;
    v.muted = true;
    await v.play();
    if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
    await v.requestPictureInPicture();
  } catch (err) {
    console.warn(err);
    endPip();
    toast('Pop out did not open. Use Focus view instead.');
  }
}

function endPip() {
  rt.pipStream?.getTracks().forEach((t) => t.stop());
  rt.pipStream = null;
  ui.pipVideo.srcObject = null;
}

let focusTimer = 0;
function setFocus(on) {
  document.body.classList.toggle('focus', on);
  ui.btnFocus.setAttribute('aria-pressed', String(on));
  if (on) {
    pokeFocus();
    const el = document.documentElement;
    if (el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => {});
  } else if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}

function pokeFocus() {
  if (!document.body.classList.contains('focus')) return;
  document.body.classList.add('pointer-active');
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => document.body.classList.remove('pointer-active'), 2200);
}

// ---------------------------------------------------------------- controls

function formatValue(key, v) {
  if (key === 'choke') return `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
  if (key === 'zoom') return `${v.toFixed(2)}×`;
  return `${Math.round(v * 100)}%`;
}

function paintRange(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const v = Number(input.value);
  input.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
  const out = document.querySelector(`output[for="${input.id}"]`);
  if (out) out.textContent = formatValue(input.dataset.key || 'zoom', v);
}

function syncPanels() {
  const mode = modeOf(settings.plate);
  ui.framing.hidden = mode !== 'image';
  ui.blurControls.hidden = mode !== 'blur';
  ui.matteFields.classList.toggle('muted', mode === 'none');
  ui.matteOffNote.hidden = mode !== 'none';
  if (mode === 'image') {
    ui.zoom.value = framingFor(settings.plate).z;
    paintRange(ui.zoom);
  }
}

function syncControls() {
  for (const input of document.querySelectorAll('input[type="range"][data-key]')) {
    input.value = settings[input.dataset.key];
    paintRange(input);
  }
  for (const input of document.querySelectorAll('input[type="checkbox"][data-key]')) {
    input.checked = !!settings[input.dataset.key];
  }
  for (const radio of document.querySelectorAll('input[name="model"]')) radio.checked = radio.value === settings.model;
  ui.selRes.value = settings.resolution;
  ui.selDelegate.value = settings.delegate;
  if ([...ui.selCamera.options].some((o) => o.value === settings.deviceId)) ui.selCamera.value = settings.deviceId;
  syncPanels();
}

function setTab(name) {
  const tabs = document.querySelectorAll('[data-tab]');
  if (![...tabs].some((t) => t.dataset.tab === name)) name = 'bg';
  for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const g of document.querySelectorAll('[data-group]')) g.classList.toggle('active', g.dataset.group === name);
  try {
    sessionStorage.setItem('backdrop.tab', name);
  } catch {
    // Not important.
  }
}

function bindUI() {
  ui.btnStart.addEventListener('click', () => startCamera());
  ui.btnRetry.addEventListener('click', () => rt.retry?.());
  ui.btnShot.addEventListener('click', snapshot);
  ui.btnRec.addEventListener('click', toggleRecording);
  ui.btnFlip.addEventListener('click', flipCamera);
  ui.btnFocus.addEventListener('click', () => setFocus(!document.body.classList.contains('focus')));
  ui.exitFocus.addEventListener('click', () => setFocus(false));
  ui.capClose.addEventListener('click', closeCapture);
  ui.btnPip.hidden = !pipSupported;
  ui.btnPip.addEventListener('click', togglePip);
  ui.pipVideo.addEventListener('leavepictureinpicture', () => {
    endPip();
    if (camLive() && document.hidden) startLoop();
  });

  ui.btnCopyLink.addEventListener('click', () => {
    const url = location.href;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => toast('Link copied. Paste it into Safari or Chrome.'),
        () => toast(url, { ms: 10000 }),
      );
    } else {
      toast(url, { ms: 10000 });
    }
  });

  ui.tiles.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      removePlate(remove.dataset.remove);
      return;
    }
    const tile = e.target.closest('.tile');
    if (!tile) return;
    if (tile.dataset.id === 'add') ui.file.click();
    else selectPlate(tile.dataset.id);
  });

  ui.btnResetFraming.addEventListener('click', () => setFraming({ z: 1, x: 0, y: 0 }));
  ui.btnResetMatte.addEventListener('click', () => {
    Object.assign(settings, MATTE_DEFAULTS);
    saveSettings();
    syncControls();
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('input[type="range"][data-key]')) {
      settings[t.dataset.key] = Number(t.value);
      paintRange(t);
      saveSettings();
    } else if (t === ui.zoom) {
      paintRange(t);
      setFraming({ z: Number(t.value) });
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('input[type="checkbox"][data-key]')) {
      settings[t.dataset.key] = t.checked;
      saveSettings();
    } else if (t.name === 'model') {
      setModel(t.value);
    } else if (t === ui.selRes) {
      settings.resolution = t.value;
      saveSettings();
      if (camLive()) startCamera();
    } else if (t === ui.selDelegate) {
      settings.delegate = t.value;
      saveSettings();
      loadEngine();
    } else if (t === ui.selCamera) {
      settings.deviceId = t.value;
      saveSettings();
      if (camLive()) startCamera();
    } else if (t === ui.file) {
      addFiles(t.files);
      t.value = '';
    }
  });

  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
  }

  // Drop and paste photos anywhere.
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    addFiles(e.dataTransfer.files);
  });
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter(looksLikeImage);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('input, select, textarea, button, a')) {
      if (e.key !== 'Escape') return;
    }
    const key = e.key.toLowerCase();
    if (key === 'f') setFocus(!document.body.classList.contains('focus'));
    else if (key === 'escape' && document.body.classList.contains('focus')) setFocus(false);
    else if (key === ' ' && camLive()) {
      e.preventDefault();
      snapshot();
    } else if (key === 'r' && camLive()) toggleRecording();
  });

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('focus')) setFocus(false);
  });
  for (const type of ['pointermove', 'pointerdown']) document.addEventListener(type, pokeFocus, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      releaseWakeLock();
      // The pending animation frame will never fire in a hidden tab; hand over to the worker timer
      // so a popped-out preview or a recording keeps running.
      if (camLive() && keepAlive()) startLoop();
      return;
    }
    if (rt.restartOnReturn || (rt.camState === 'live' && (!rt.track || rt.track.readyState === 'ended'))) {
      // iOS and Android stop the camera when the app is backgrounded.
      rt.restartOnReturn = false;
      startCamera();
      return;
    }
    if (camLive()) {
      ui.cam.play().catch(() => {});
      requestWakeLock();
      startLoop();
    }
  });

  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (camLive()) refreshDevices();
  });

  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    ui.install.hidden = false;
  });
  ui.install.addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    ui.install.hidden = true;
  });

  bindGestures();
}

async function maybeAutoStart() {
  try {
    const status = await navigator.permissions?.query({ name: 'camera' });
    if (status?.state === 'granted' && rt.camState === 'idle') startCamera();
  } catch {
    // Firefox and older Safari can't query camera permission; the Start button covers it.
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline support unavailable', err));
}

async function boot() {
  rt.renderer = makeRenderer();
  ui.basicNote.hidden = rt.renderer.kind !== 'basic';
  bindUI();
  syncControls();
  let tab = 'bg';
  try {
    tab = sessionStorage.getItem('backdrop.tab') || 'bg';
  } catch {
    // Default tab.
  }
  setTab(tab);
  await initPlates();
  await selectPlate(settings.plate);
  renderReadout();

  const problem = environmentProblem();
  if (problem) {
    showGate('error', problem);
    return;
  }
  showGate('start');
  ui.gateWarn.hidden = !env.inApp;
  loadEngine();
  maybeAutoStart();
  registerServiceWorker();
}

boot().catch((err) => {
  console.error(err);
  showGate('error', {
    title: 'Backdrop could not start',
    body: err?.message || String(err),
    retry: () => location.reload(),
    retryLabel: 'Reload',
  });
});
