// Person segmentation with MediaPipe Tasks Vision, served from this app's own folder
// so it keeps working offline and is never blocked by a third-party CDN.
import { FilesetResolver, ImageSegmenter } from '../vendor/mediapipe/vision_bundle.mjs';

export const MODELS = {
  // selfie_segmenter has one label ("selfie"): channel 0 is the person.
  fast: { file: '../models/selfie_segmenter.tflite', name: 'Fast', size: 249537, inverted: false },
  // selfie_multiclass has six labels and channel 0 is "background", so person = 1 - channel 0.
  best: { file: '../models/selfie_multiclass_256x256.tflite', name: 'Best', size: 16371837, inverted: true },
};

const WASM = {
  simd: { name: 'vision_wasm_internal', size: 11756954 },
  nosimd: { name: 'vision_wasm_nosimd_internal', size: 10960242 },
};

class Superseded extends Error {
  constructor() {
    super('A newer engine load replaced this one');
    this.name = 'Superseded';
  }
}

async function download(url, expected, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url.split('/').pop()}`);
  const total = Number(res.headers.get('content-length')) || expected;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const bytes = new Uint8Array(await res.arrayBuffer());
    onProgress?.(1);
    return bytes;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(Math.min(received / total, 0.99));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress?.(1);
  return bytes;
}

let filesetPromise = null;
let filesetReady = false;

// Downloads the wasm binary ourselves so the loading bar can show real progress,
// then hands MediaPipe a blob URL so the 11 MB file is fetched only once.
function getFileset(onProgress) {
  if (!filesetPromise) {
    filesetPromise = (async () => {
      const simd = await FilesetResolver.isSimdSupported().catch(() => false);
      const spec = simd ? WASM.simd : WASM.nosimd;
      const base = new URL('../vendor/mediapipe/wasm/', import.meta.url);
      const loader = new URL(`${spec.name}.js`, base).href;
      const binary = new URL(`${spec.name}.wasm`, base).href;
      let fileset;
      try {
        const bytes = await download(binary, spec.size, onProgress);
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
        fileset = { wasmLoaderPath: loader, wasmBinaryPath: blobUrl };
      } catch (err) {
        console.warn('Loading the wasm binary directly instead', err);
        fileset = { wasmLoaderPath: loader, wasmBinaryPath: binary };
      }
      filesetReady = true;
      return fileset;
    })().catch((err) => {
      filesetPromise = null;
      throw err;
    });
  }
  return filesetPromise;
}

export class Segmenter {
  constructor() {
    this.task = null;
    this.model = null;
    this.delegate = null;
    this.spec = null;
    this.loadId = 0;
    this.lastTs = 0;
    this.mask = null;
    this.maskW = 0;
    this.maskH = 0;
    // Frames are shrunk before segmentation: the models work at 256 px anyway,
    // and a small input keeps the mask read-back cheap on phones.
    this.input = document.createElement('canvas');
    this.inputCtx = this.input.getContext('2d', { alpha: false });
  }

  get ready() {
    return !!this.task;
  }

  async load(modelKey, preference = 'auto', onProgress) {
    const id = ++this.loadId;
    const spec = MODELS[modelKey] || MODELS.fast;
    const needWasm = !filesetReady;
    const parts = { wasm: needWasm ? 0 : 1, model: 0 };
    const weight = { wasm: needWasm ? WASM.simd.size : 0, model: spec.size };
    const report = () =>
      onProgress?.((parts.wasm * weight.wasm + parts.model * weight.model) / (weight.wasm + weight.model));

    const [fileset, buffer] = await Promise.all([
      getFileset((p) => {
        parts.wasm = p;
        report();
      }),
      download(new URL(spec.file, import.meta.url).href, spec.size, (p) => {
        parts.model = p;
        report();
      }),
    ]);
    if (id !== this.loadId) throw new Superseded();

    const order = preference === 'CPU' ? ['CPU'] : preference === 'GPU' ? ['GPU'] : ['GPU', 'CPU'];
    let lastError = null;
    for (const delegate of order) {
      try {
        const task = await ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: buffer.slice(), delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
        if (id !== this.loadId) {
          task.close();
          throw new Superseded();
        }
        this.close();
        this.task = task;
        this.model = modelKey in MODELS ? modelKey : 'fast';
        this.delegate = delegate;
        this.spec = spec;
        this.lastTs = 0;
        return { model: this.model, delegate };
      } catch (err) {
        if (err instanceof Superseded) throw err;
        console.warn(`Segmenter could not start on ${delegate}`, err);
        lastError = err;
      }
    }
    throw lastError || new Error('The matte engine could not start');
  }

  // Runs one frame. Returns true when this.mask holds a new person mask (0-255).
  segment(video, now) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!this.task || !vw || !vh || video.readyState < 2) return false;

    let scale = 256 / Math.min(vw, vh);
    if (Math.max(vw, vh) * scale > 512) scale = 512 / Math.max(vw, vh);
    scale = Math.min(1, scale);
    const w = Math.max(16, Math.round(vw * scale));
    const h = Math.max(16, Math.round(vh * scale));
    if (this.input.width !== w || this.input.height !== h) {
      this.input.width = w;
      this.input.height = h;
    }
    this.inputCtx.drawImage(video, 0, 0, w, h);

    // VIDEO mode demands strictly increasing timestamps.
    const ts = Math.max(Math.round(now), this.lastTs + 1);
    this.lastTs = ts;

    let fresh = false;
    this.task.segmentForVideo(this.input, ts, (result) => {
      const masks = result.confidenceMasks;
      if (!masks || !masks.length) return;
      const m = masks[0];
      const src = m.getAsFloat32Array();
      const n = src.length;
      if (!this.mask || this.mask.length !== n) this.mask = new Uint8ClampedArray(n);
      const dst = this.mask;
      if (this.spec.inverted) {
        for (let i = 0; i < n; i++) dst[i] = (1 - src[i]) * 255;
      } else {
        for (let i = 0; i < n; i++) dst[i] = src[i] * 255;
      }
      this.maskW = m.width;
      this.maskH = m.height;
      fresh = true;
    });
    return fresh;
  }

  close() {
    if (this.task) {
      try {
        this.task.close();
      } catch {
        // Already torn down.
      }
    }
    this.task = null;
  }
}
