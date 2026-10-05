// WebGL2 compositor.
// Pipeline per frame: camera upload -> temporal mask smoothing -> edge-aware matte refine
// (joint bilateral upsample guided by the camera image) -> background plate -> composite
// with edge decontamination, light wrap and lighting match.

export function coverScale(srcAspect, dstAspect) {
  // Fraction of the source visible when it covers the destination.
  return srcAspect > dstAspect ? [dstAspect / srcAspect, 1] : [1, srcAspect / dstAspect];
}

export function edgeRange(choke, feather) {
  const center = 0.5 + choke * 0.25;
  const width = 0.06 + feather * 0.5;
  return [Math.max(0.001, center - width / 2), Math.min(0.999, center + width / 2)];
}

const VS = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform float uFlip;
out vec2 vUv;
void main() {
  vUv = aPos;
  float y = aPos.y * 2.0 - 1.0;
  gl_Position = vec4(aPos.x * 2.0 - 1.0, uFlip > 0.5 ? -y : y, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
`;

const FS = {
  // Keeps the previous mask where the change is small (flicker), follows it where it is large (motion).
  temporal: `${HEAD}
uniform sampler2D uNew;
uniform sampler2D uPrev;
uniform float uKeep;
void main() {
  float n = texture(uNew, vUv).r;
  float p = texture(uPrev, vUv).r;
  float keep = uKeep * (1.0 - smoothstep(0.04, 0.3, abs(n - p)));
  outColor = vec4(mix(n, p, keep), 0.0, 0.0, 1.0);
}`,

  // Joint bilateral upsample: mask samples count more when their camera colour matches this pixel,
  // which snaps the coarse model edge onto the real edge in the image.
  refine: `${HEAD}
uniform sampler2D uMask;
uniform sampler2D uCam;
uniform vec2 uStep;
uniform float uLodC;
uniform float uLodN;
uniform float uInvSigR2;
void main() {
  vec3 c0 = textureLod(uCam, vUv, uLodC).rgb;
  float acc = 0.0;
  float wsum = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 off = vec2(float(i), float(j));
      vec2 uv = vUv + off * uStep;
      vec3 d = textureLod(uCam, uv, uLodN).rgb - c0;
      float w = exp(-dot(off, off) * 0.18 - dot(d, d) * uInvSigR2);
      acc += textureLod(uMask, uv, 0.0).r * w;
      wsum += w;
    }
  }
  outColor = vec4(acc / max(wsum, 1e-5), 0.0, 0.0, 1.0);
}`,

  plate: `${HEAD}
uniform sampler2D uImg;
uniform vec2 uScale;
uniform vec2 uOffset;
void main() {
  vec2 uv = (vUv - 0.5) * uScale + 0.5 + uOffset;
  outColor = vec4(texture(uImg, uv).rgb, 1.0);
}`,

  // Premultiplied camera with the person removed, so blurring the room never smears the person into it.
  masked: `${HEAD}
uniform sampler2D uCam;
uniform sampler2D uMatte;
uniform float uLod;
void main() {
  float m = textureLod(uMatte, vUv, 1.0).r;
  float a = max(1.0 - smoothstep(0.15, 0.55, m), 0.01);
  outColor = vec4(textureLod(uCam, vUv, uLod).rgb * a, a);
}`,

  blur: `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uDir;
void main() {
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  vec4 s = texture(uSrc, vUv) * 0.2270270270;
  s += (texture(uSrc, vUv + o1) + texture(uSrc, vUv - o1)) * 0.3162162162;
  s += (texture(uSrc, vUv + o2) + texture(uSrc, vUv - o2)) * 0.0702702703;
  outColor = s;
}`,

  composite: `${HEAD}
uniform sampler2D uCam;
uniform sampler2D uMatte;
uniform sampler2D uPlate;
uniform float uMirror;
uniform vec2 uCamScale;
uniform float uComposite;
uniform float uPlateCam;
uniform float uPremul;
uniform vec2 uEdge;
uniform float uWrap;
uniform float uMatch;
uniform float uDecon;
uniform vec2 uCamPx;
uniform vec2 uMattePx;
uniform float uPlateTop;
uniform float uCamTop;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 plateAt(vec2 uv, float lod) {
  vec4 p = textureLod(uPlate, uv, lod);
  return uPremul > 0.5 ? p.rgb / max(p.a, 0.004) : p.rgb;
}

void main() {
  vec2 m = vec2(uMirror > 0.5 ? 1.0 - vUv.x : vUv.x, vUv.y);
  vec2 cuv = (m - 0.5) * uCamScale + 0.5;
  vec3 cam = textureLod(uCam, cuv, 0.0).rgb;
  if (uComposite < 0.5) {
    outColor = vec4(cam, 1.0);
    return;
  }

  float matte = textureLod(uMatte, cuv, 0.0).r;
  float a = smoothstep(uEdge.x, uEdge.y, matte);
  vec2 puv = uPlateCam > 0.5 ? cuv : vUv;
  vec3 bg = plateAt(puv, 0.0);
  vec3 fg = cam;

  // Edge decontamination: in the soft edge, borrow colour from just inside the person
  // so the old room does not show as a halo.
  if (uDecon > 0.0 && a > 0.002 && a < 0.998) {
    vec2 t = uMattePx * 1.5;
    vec2 g = vec2(
      textureLod(uMatte, cuv + vec2(t.x, 0.0), 0.0).r - textureLod(uMatte, cuv - vec2(t.x, 0.0), 0.0).r,
      textureLod(uMatte, cuv + vec2(0.0, t.y), 0.0).r - textureLod(uMatte, cuv - vec2(0.0, t.y), 0.0).r);
    float len = length(g);
    if (len > 1e-4) {
      vec3 inner = textureLod(uCam, cuv + (g / len) * uCamPx * uDecon, 0.0).rgb;
      fg = mix(fg, inner, (1.0 - a) * 0.9);
    }
  }

  if (uMatch > 0.0) {
    vec3 bm = plateAt(vec2(0.5), uPlateTop);
    vec3 fm = textureLod(uCam, vec2(0.5), uCamTop).rgb;
    float lb = max(luma(bm), 0.02);
    float lf = max(luma(fm), 0.02);
    vec3 tint = clamp((bm / lb) / max(fm / lf, vec3(0.02)), vec3(0.7), vec3(1.4));
    fg *= mix(vec3(1.0), tint, 0.35 * uMatch);
    fg *= mix(1.0, clamp(sqrt(lb / lf), 0.7, 1.3), 0.6 * uMatch);
  }

  if (uWrap > 0.0) {
    float soft = textureLod(uMatte, cuv, 3.5).r;
    float zone = a * clamp((1.0 - soft) * 2.2, 0.0, 1.0);
    vec3 glow = plateAt(puv, 4.0);
    fg = 1.0 - (1.0 - fg) * (1.0 - glow * zone * uWrap);
  }

  outColor = vec4(mix(bg, clamp(fg, 0.0, 1.0), a), 1.0);
}`,
};

export class GLRenderer {
  static create(canvas) {
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      });
    } catch {
      gl = null;
    }
    if (!gl) return null;
    try {
      return new GLRenderer(canvas, gl);
    } catch (err) {
      console.warn('WebGL2 renderer failed; using the basic renderer', err);
      return null;
    }
  }

  constructor(canvas, gl) {
    this.kind = 'webgl';
    this.canvas = canvas;
    this.gl = gl;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      try {
        this.setup();
        this.lost = false;
      } catch (err) {
        console.error('Could not restore the WebGL context', err);
      }
    });
    this.setup();
  }

  setup() {
    const gl = this.gl;
    this.halfFloat = !!gl.getExtension('EXT_color_buffer_float');
    this.progs = {};
    for (const [name, src] of Object.entries(FS)) this.progs[name] = this.program(src);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    this.camTex = this.texture(true);
    this.rawMask = this.texture(false);
    this.imgTex = this.texture(true);
    this.blank = this.texture(false);
    this.targets = {};
    this.mask = { w: 0, h: 0, frames: 0, cur: null, flip: false };
    this.imgKey = null;
    this.plateSig = '';
    this.plate = null;
  }

  program(fsSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        throw new Error(gl.getShaderInfoLog(s) || 'Shader failed to compile');
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(gl.getProgramInfoLog(p) || 'Shader program failed to link');
    }
    const u = {};
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  texture(mip) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  }

  target(name, w, h, fmt = 'rgba8', mip = false) {
    const gl = this.gl;
    let t = this.targets[name];
    if (t && t.w === w && t.h === h && t.req === fmt) return t;
    if (t) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    const make = (actual) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const spec =
        actual === 'r8'
          ? [gl.R8, gl.RED, gl.UNSIGNED_BYTE]
          : actual === 'rgba16f'
            ? [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT]
            : [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
      gl.texImage2D(gl.TEXTURE_2D, 0, spec[0], w, h, 0, spec[1], spec[2], null);
      if (mip) gl.generateMipmap(gl.TEXTURE_2D);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok) {
        gl.deleteFramebuffer(fb);
        gl.deleteTexture(tex);
        return null;
      }
      return { tex, fb };
    };
    // Some phones cannot render to half-float or single-channel targets; fall back to RGBA8.
    let made = make(fmt);
    if (!made && fmt !== 'rgba8') {
      if (fmt === 'rgba16f') this.halfFloat = false;
      made = make('rgba8');
    }
    if (!made) throw new Error('This device could not create a render target');
    t = { ...made, w, h, req: fmt, mip, isNew: true };
    this.targets[name] = t;
    return t;
  }

  draw(prog, target, uniforms, textures) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.canvas.width, target ? target.h : this.canvas.height);
    gl.useProgram(prog.p);
    if (prog.u.uFlip) gl.uniform1f(prog.u.uFlip, target ? 0 : 1);
    let unit = 0;
    for (const name in textures) {
      const loc = prog.u[name];
      if (!loc) continue;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, textures[name]);
      gl.uniform1i(loc, unit);
      unit++;
    }
    for (const name in uniforms) {
      const loc = prog.u[name];
      if (!loc) continue;
      const v = uniforms[name];
      if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else gl.uniform3f(loc, v[0], v[1], v[2]);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (target && target.mip) {
      gl.bindTexture(gl.TEXTURE_2D, target.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  }

  pushMask(data, w, h, keep) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.rawMask);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    const a = this.target('maskA', w, h, 'r8');
    const b = this.target('maskB', w, h, 'r8');
    const ms = this.mask;
    if (a.isNew || b.isNew) {
      a.isNew = false;
      b.isNew = false;
      ms.frames = 0;
    }
    const prev = ms.flip ? a : b;
    const next = ms.flip ? b : a;
    this.draw(this.progs.temporal, next, { uKeep: ms.frames > 0 ? keep : 0 }, { uNew: this.rawMask, uPrev: prev.tex });
    ms.flip = !ms.flip;
    ms.frames++;
    ms.cur = next;
    ms.w = w;
    ms.h = h;
  }

  blurChain(prefix, W, H, sigma, fmt, fill) {
    const ds = Math.min(16, Math.max(1, sigma / 2.4));
    const w = Math.max(8, Math.round(W / ds));
    const h = Math.max(8, Math.round(H / ds));
    const k = Math.min(2.5, sigma / (ds * 2.39));
    const X = this.target(`${prefix}X`, w, h, fmt);
    const Y = this.target(`${prefix}Y`, w, h, fmt);
    const F = this.target(`${prefix}F`, w, h, fmt, true);
    fill(X);
    const b = this.progs.blur;
    this.draw(b, Y, { uDir: [k / w, 0] }, { uSrc: X.tex });
    this.draw(b, X, { uDir: [0, k / h] }, { uSrc: Y.tex });
    this.draw(b, Y, { uDir: [k / w, 0] }, { uSrc: X.tex });
    this.draw(b, F, { uDir: [0, k / h] }, { uSrc: Y.tex });
    return F;
  }

  imagePlate(p, W, H, amount) {
    const gl = this.gl;
    if (this.imgKey !== p.key) {
      gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, p.source);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.imgKey = p.key;
      this.plateSig = '';
    }
    const sigma = amount * H * 0.03;
    const sig = `${p.key}|${W}|${H}|${p.zoom}|${p.x}|${p.y}|${sigma.toFixed(2)}`;
    if (sig === this.plateSig && this.plate) return this.plate;

    const cover = coverScale(p.w / p.h, W / H);
    const scale = [cover[0] / p.zoom, cover[1] / p.zoom];
    const offset = [(p.x * (1 - scale[0])) / 2, (p.y * (1 - scale[1])) / 2];
    const fill = (t) => this.draw(this.progs.plate, t, { uScale: scale, uOffset: offset }, { uImg: this.imgTex });
    let out;
    if (sigma < 0.6) {
      out = this.target('plate', W, H, 'rgba8', true);
      fill(out);
    } else {
      out = this.blurChain('plate', W, H, sigma, 'rgba8', fill);
    }
    this.plateSig = sig;
    this.plate = out;
    return out;
  }

  blurPlate(s, vw, vh, matte) {
    const sigma = 2 + s.blurStrength * Math.min(vw, vh) * 0.045;
    const fmt = this.halfFloat ? 'rgba16f' : 'rgba8';
    return this.blurChain('bg', vw, vh, sigma, fmt, (t) =>
      this.draw(
        this.progs.masked,
        t,
        { uLod: Math.max(0, Math.log2(vw / t.w) - 0.5) },
        { uCam: this.camTex, uMatte: matte.tex },
      ),
    );
  }

  render(s) {
    const gl = this.gl;
    if (this.lost || gl.isContextLost()) return false;
    const video = s.video;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const W = s.outW;
    const H = s.outH;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.camTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.generateMipmap(gl.TEXTURE_2D);

    if (s.mask && s.maskFresh) this.pushMask(s.mask, s.maskW, s.maskH, s.stability);

    const ms = this.mask;
    let composite = s.mode !== 'none' && !!ms.cur;
    let matte = null;
    let plate = null;
    let plateCam = 0;
    let premul = 0;
    if (composite) {
      const rs = Math.min(1, s.refineMax / Math.max(vw, vh));
      const rw = Math.max(16, Math.round(vw * rs));
      const rh = Math.max(16, Math.round(vh * rs));
      matte = this.target('matte', rw, rh, 'r8', true);
      this.draw(
        this.progs.refine,
        matte,
        {
          uStep: [1 / ms.w, 1 / ms.h],
          uLodC: Math.max(0, Math.log2(vw / rw)),
          uLodN: Math.max(0, Math.log2(vw / ms.w) - 0.5),
          uInvSigR2: 1 / (2 * 0.12 * 0.12),
        },
        { uMask: ms.cur.tex, uCam: this.camTex },
      );
      if (s.mode === 'blur') {
        plate = this.blurPlate(s, vw, vh, matte);
        plateCam = 1;
        premul = 1;
      } else if (s.plate) {
        plate = this.imagePlate(s.plate, W, H, s.plateBlur);
      }
      if (!plate) composite = false;
    }

    const pw = plate ? plate.w : 1;
    const ph = plate ? plate.h : 1;
    this.draw(
      this.progs.composite,
      null,
      {
        uMirror: s.mirror ? 1 : 0,
        uCamScale: coverScale(vw / vh, W / H),
        uComposite: composite ? 1 : 0,
        uPlateCam: plateCam,
        uPremul: premul,
        uEdge: edgeRange(s.choke, s.feather),
        uWrap: s.wrap,
        uMatch: s.match,
        uDecon: 3.5 * Math.max(1, vh / 720),
        uCamPx: [1 / vw, 1 / vh],
        uMattePx: matte ? [1 / matte.w, 1 / matte.h] : [0, 0],
        uPlateTop: Math.floor(Math.log2(Math.max(pw, ph))),
        uCamTop: Math.floor(Math.log2(Math.max(vw, vh))),
      },
      { uCam: this.camTex, uMatte: matte ? matte.tex : this.blank, uPlate: plate ? plate.tex : this.blank },
    );
    return true;
  }

  // Must run in the same task as render(): the drawing buffer is cleared once the frame is shown.
  snapshot() {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    ctx.putImageData(img, 0, 0);
    return out;
  }
}
