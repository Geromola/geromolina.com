import type { GridGame } from './game';
import type { Lattice } from './layout';

/**
 * Electron and heat renderers (WebGL2, with a Canvas 2D fallback), plus the
 * static conductor mesh. Colours follow the engine's `hue`: HIGH is white-hot
 * with small, tight points; LOW is cyan; depleted packets fade toward amber.
 * Heat is an amber glow along each conductor, drawn under the electrons.
 */
export interface Renderer {
  readonly kind: 'webgl' | 'canvas';
  /** Strongest heat glow drawn in the last frame, 0..1 (for the "first heat" fact). */
  readonly maxHeat: number;
  resize(width: number, height: number, dpr: number, lat: Lattice): void;
  /** `dt <= 0` draws a still frame: no trails, heat snapped to its current value. */
  draw(game: GridGame, dt: number): void;
}

// ------------------------------------------------------------------ heat

const HEAT_SMOOTH = 0.35; // s, extra low-pass on top of the engine's τ, so the glow doesn't flicker
const HEAT_REF = 0.008; // heat per counted electron that maps to full glow
const HEAT_FLOOR = 0.15; // normalised heat below this draws nothing: the idle grid stays calm
const HEAT_MAX_ALPHA = 0.85;

/** Smoothed, normalised per-edge heat. Shared by both renderers. */
class HeatField {
  smooth = new Float32Array(0);
  alpha = new Float32Array(0);
  max = 0;

  update(game: GridGame, dt: number) {
    const E = game.heat.length;
    if (this.smooth.length !== E) {
      this.smooth = Float32Array.from(game.heat);
      this.alpha = new Float32Array(E);
    }
    const k = dt > 0 ? 1 - Math.exp(-dt / HEAT_SMOOTH) : 1;
    const counted = Math.max(1, game.count * 0.65);
    const inv = 1 / (HEAT_REF * counted);
    let max = 0;
    for (let e = 0; e < E; e++) {
      const s = (this.smooth[e] += (game.heat[e] - this.smooth[e]) * k);
      const n = s * inv;
      const a = n <= HEAT_FLOOR ? 0 : Math.min(1, (n - HEAT_FLOOR) / (1 - HEAT_FLOOR)) * HEAT_MAX_ALPHA;
      this.alpha[e] = a;
      if (a > max) max = a;
    }
    this.max = max;
  }
}

// ---------------------------------------------------------------- trails

const TRAIL = 3; // trail samples behind each head
const TRAIL_SECONDS = 0.028; // spacing between samples, in seconds of travel
const TRAIL_MAX = 0.4; // lattice units

/** Shared trail bookkeeping: velocity from frame-to-frame motion. */
class Trails {
  prevX = new Float32Array(0);
  prevY = new Float32Array(0);
  vx = new Float32Array(0);
  vy = new Float32Array(0);

  update(game: GridGame, dt: number) {
    if (this.prevX.length !== game.count || dt <= 0) {
      this.prevX = Float32Array.from(game.x);
      this.prevY = Float32Array.from(game.y);
      this.vx = new Float32Array(game.count);
      this.vy = new Float32Array(game.count);
      return;
    }
    const inv = 1 / dt;
    for (let i = 0; i < game.count; i++) {
      const dx = game.x[i] - this.prevX[i];
      const dy = game.y[i] - this.prevY[i];
      if (dx * dx + dy * dy > 0.25) {
        this.vx[i] = this.vy[i] = 0; // respawned: no streak across the screen
      } else {
        this.vx[i] += (dx * inv - this.vx[i]) * 0.5;
        this.vy[i] += (dy * inv - this.vy[i]) * 0.5;
      }
      this.prevX[i] = game.x[i];
      this.prevY[i] = game.y[i];
    }
  }

  offset(i: number, j: number): [number, number] {
    let ox = this.vx[i] * TRAIL_SECONDS * j;
    let oy = this.vy[i] * TRAIL_SECONDS * j;
    const len = Math.hypot(ox, oy);
    const max = (TRAIL_MAX * j) / TRAIL;
    if (len > max) {
      ox *= max / len;
      oy *= max / len;
    }
    return [ox, oy];
  }
}

/** Head size in css px: ambient dim and small, LOW cyan, HIGH small and tight. */
function headSize(ambient: number, hue: number) {
  if (ambient) return 5;
  return hue > 0 ? 7 - 2.5 * hue : 7;
}

// ----------------------------------------------------------------- WebGL

const POINT_VERT = `#version 300 es
in vec2 a_pos;
in float a_bright;
in float a_hue;
in float a_size;
uniform vec2 u_res;
uniform vec3 u_lat;
uniform float u_dpr;
out float v_bright;
out float v_hue;
void main() {
  vec2 px = u_lat.xy + a_pos * u_lat.z;
  vec2 clip = px / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = a_size * u_dpr;
  v_bright = a_bright;
  v_hue = a_hue;
}`;

// CYAN = --cyan #5fe3ff, HOT = --hot #eef7ff, AMBER = --amber #ffb547
const POINT_FRAG = `#version 300 es
precision mediump float;
in float v_bright;
in float v_hue;
out vec4 o;
const vec3 CYAN = vec3(0.373, 0.890, 1.0);
const vec3 HOT = vec3(0.933, 0.969, 1.0);
const vec3 AMBER = vec3(1.0, 0.710, 0.278);
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float hot = max(v_hue, 0.0);
  float core = exp(-r2 * (10.0 + 14.0 * hot));
  float halo = exp(-r2 * 3.0) * 0.3 * (1.0 - 0.6 * hot);
  vec3 col = v_hue >= 0.0 ? mix(CYAN, HOT, v_hue) : mix(CYAN, AMBER, -v_hue);
  float a = (core + halo) * v_bright;
  o = vec4(col * a, a);
}`;

/** Heat: one instanced quad per hot edge, a soft amber band across the conductor. */
const HEAT_VERT = `#version 300 es
in vec2 a_corner;
in vec4 a_seg;
in float a_alpha;
uniform vec2 u_res;
uniform vec3 u_lat;
uniform float u_half;
out float v_alpha;
out float v_across;
void main() {
  vec2 a = u_lat.xy + a_seg.xy * u_lat.z;
  vec2 b = u_lat.xy + a_seg.zw * u_lat.z;
  vec2 d = normalize(b - a);
  vec2 n = vec2(-d.y, d.x);
  vec2 px = mix(a, b, a_corner.x) + n * a_corner.y * u_half;
  vec2 clip = px / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_alpha = a_alpha;
  v_across = a_corner.y;
}`;

const HEAT_FRAG = `#version 300 es
precision mediump float;
in float v_alpha;
in float v_across;
out vec4 o;
const vec3 AMBER = vec3(1.0, 0.710, 0.278);
void main() {
  float x2 = v_across * v_across;
  float a = v_alpha * (exp(-x2 * 4.0) * 0.45 + exp(-x2 * 60.0) * 0.55);
  o = vec4(AMBER * a, a);
}`;

const STRIDE = 5; // x, y, bright, hue, size
const HEAT_STRIDE = 5; // c0, r0, c1, r1, alpha
const HEAT_HALF = 7; // css px, half-width of the glow band

export class WebGLRenderer implements Renderer {
  readonly kind = 'webgl' as const;
  private gl: WebGL2RenderingContext;
  private points: WebGLProgram;
  private heatProg: WebGLProgram;
  private pointVao: WebGLVertexArrayObject;
  private heatVao: WebGLVertexArrayObject;
  private pointBuf: WebGLBuffer;
  private heatBuf: WebGLBuffer;
  private data = new Float32Array(0);
  private heatData = new Float32Array(0);
  private trails = new Trails();
  private heatField = new HeatField();
  private u: Record<string, WebGLUniformLocation | null> = {};

  get maxHeat() {
    return this.heatField.max;
  }

  static create(canvas: HTMLCanvasElement): WebGLRenderer | null {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false, alpha: true });
    if (!gl) return null;
    try {
      return new WebGLRenderer(canvas, gl);
    } catch {
      return null;
    }
  }

  private constructor(
    private canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
  ) {
    this.gl = gl;
    this.points = link(gl, POINT_VERT, POINT_FRAG);
    this.heatProg = link(gl, HEAT_VERT, HEAT_FRAG);

    // Electrons: one buffer of points.
    this.pointVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.pointVao);
    this.pointBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
    const attr = (prog: WebGLProgram, name: string, size: number, stride: number, offset: number, divisor = 0) => {
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
      gl.vertexAttribDivisor(loc, divisor);
    };
    attr(this.points, 'a_pos', 2, STRIDE, 0);
    attr(this.points, 'a_bright', 1, STRIDE, 2);
    attr(this.points, 'a_hue', 1, STRIDE, 3);
    attr(this.points, 'a_size', 1, STRIDE, 4);

    // Heat: a static unit quad (triangle strip) plus one instance per hot edge.
    this.heatVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.heatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()!);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
    attr(this.heatProg, 'a_corner', 2, 2, 0);
    this.heatBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.heatBuf);
    attr(this.heatProg, 'a_seg', 4, HEAT_STRIDE, 0, 1);
    attr(this.heatProg, 'a_alpha', 1, HEAT_STRIDE, 4, 1);
    gl.bindVertexArray(null);

    for (const n of ['u_res', 'u_lat', 'u_dpr']) this.u[`p.${n}`] = gl.getUniformLocation(this.points, n);
    for (const n of ['u_res', 'u_lat', 'u_half']) this.u[`h.${n}`] = gl.getUniformLocation(this.heatProg, n);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
  }

  resize(width: number, height: number, dpr: number, lat: Lattice) {
    const { gl, u } = this;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.points);
    gl.uniform2f(u['p.u_res'], width, height);
    gl.uniform3f(u['p.u_lat'], lat.ox, lat.oy, lat.spacing);
    gl.uniform1f(u['p.u_dpr'], dpr);
    gl.useProgram(this.heatProg);
    gl.uniform2f(u['h.u_res'], width, height);
    gl.uniform3f(u['h.u_lat'], lat.ox, lat.oy, lat.spacing);
    gl.uniform1f(u['h.u_half'], HEAT_HALF);
  }

  draw(game: GridGame, dt: number) {
    const { gl } = this;
    this.trails.update(game, dt);
    this.heatField.update(game, dt);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Heat first, under the electrons.
    const { alpha } = this.heatField;
    const { edgeA, edgeB, cols } = game.board;
    if (this.heatData.length !== alpha.length * HEAT_STRIDE) this.heatData = new Float32Array(alpha.length * HEAT_STRIDE);
    const h = this.heatData;
    let n = 0;
    for (let e = 0; e < alpha.length; e++) {
      if (alpha[e] <= 0) continue;
      const a = edgeA[e];
      const b = edgeB[e];
      const o = n++ * HEAT_STRIDE;
      h[o] = a % cols;
      h[o + 1] = Math.floor(a / cols);
      h[o + 2] = b % cols;
      h[o + 3] = Math.floor(b / cols);
      h[o + 4] = alpha[e];
    }
    if (n > 0) {
      gl.useProgram(this.heatProg);
      gl.bindVertexArray(this.heatVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.heatBuf);
      gl.bufferData(gl.ARRAY_BUFFER, h.subarray(0, n * HEAT_STRIDE), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    }

    // Electrons.
    const verts = game.count * (TRAIL + 1);
    if (this.data.length !== verts * STRIDE) this.data = new Float32Array(verts * STRIDE);
    const d = this.data;
    let o = 0;
    for (let i = 0; i < game.count; i++) {
      const head = headSize(game.ambient[i], game.hue[i]);
      for (let j = TRAIL; j >= 0; j--) {
        const [ox, oy] = this.trails.offset(i, j);
        d[o++] = game.x[i] - ox;
        d[o++] = game.y[i] - oy;
        d[o++] = game.bright[i] * (j === 0 ? 1 : 0.42 / j);
        d[o++] = game.hue[i];
        d[o++] = head * (1 - j * 0.16);
      }
    }
    gl.useProgram(this.points);
    gl.bindVertexArray(this.pointVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.POINTS, 0, verts);
    gl.bindVertexArray(null);
  }
}

function link(gl: WebGL2RenderingContext, vert: string, frag: string) {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link');
  return program;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'compile');
  return shader;
}

// ---------------------------------------------------------------- Canvas

const HEAT_BUCKETS = 8; // heat strokes are batched by quantised alpha

/** Canvas 2D fallback: pre-rendered glow sprites and heat strokes, additive. */
export class CanvasRenderer implements Renderer {
  readonly kind = 'canvas' as const;
  private ctx: CanvasRenderingContext2D;
  private sprites: { amber: HTMLCanvasElement; cyan: HTMLCanvasElement; hot: HTMLCanvasElement };
  private trails = new Trails();
  private heatField = new HeatField();
  private lat: Lattice = { cols: 0, rows: 0, spacing: 1, ox: 0, oy: 0 };
  private width = 0;
  private height = 0;

  get maxHeat() {
    return this.heatField.max;
  }

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    // --amber, --cyan, --hot (the hot sprite has a tighter core)
    this.sprites = {
      amber: sprite(255, 181, 71, 0.25),
      cyan: sprite(95, 227, 255, 0.25),
      hot: sprite(238, 247, 255, 0.12),
    };
  }

  resize(width: number, height: number, dpr: number, lat: Lattice) {
    this.width = width;
    this.height = height;
    this.lat = lat;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(game: GridGame, dt: number) {
    const { ctx, lat } = this;
    this.trails.update(game, dt);
    this.heatField.update(game, dt);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'butt';

    // Heat, batched into a few alpha buckets: a wide soft stroke and a thin core.
    const { alpha } = this.heatField;
    const { edgeA, edgeB, cols } = game.board;
    const s = lat.spacing;
    for (let k = 1; k <= HEAT_BUCKETS; k++) {
      const lo = ((k - 1) / HEAT_BUCKETS) * HEAT_MAX_ALPHA;
      const hi = (k / HEAT_BUCKETS) * HEAT_MAX_ALPHA;
      ctx.beginPath();
      let any = false;
      for (let e = 0; e < alpha.length; e++) {
        const a = alpha[e];
        if (a <= lo || a > hi + 1e-6) continue;
        any = true;
        const va = edgeA[e];
        const vb = edgeB[e];
        ctx.moveTo(lat.ox + (va % cols) * s, lat.oy + Math.floor(va / cols) * s);
        ctx.lineTo(lat.ox + (vb % cols) * s, lat.oy + Math.floor(vb / cols) * s);
      }
      if (!any) continue;
      const a = (lo + hi) / 2;
      ctx.strokeStyle = `rgba(255, 181, 71, ${(a * 0.22).toFixed(3)})`;
      ctx.lineWidth = HEAT_HALF * 2;
      ctx.stroke();
      ctx.strokeStyle = `rgba(255, 181, 71, ${(a * 0.6).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    for (let i = 0; i < game.count; i++) {
      const h = game.hue[i];
      const img = h < -0.5 ? this.sprites.amber : h > 0.5 ? this.sprites.hot : this.sprites.cyan;
      const size = headSize(game.ambient[i], h) * 1.45;
      for (let j = 2; j >= 0; j--) {
        const [ox, oy] = this.trails.offset(i, j * 1.5);
        ctx.globalAlpha = Math.min(1, game.bright[i] * (j === 0 ? 1 : 0.35 / j));
        const x = lat.ox + (game.x[i] - ox) * s;
        const y = lat.oy + (game.y[i] - oy) * s;
        const z = size * (1 - j * 0.2);
        ctx.drawImage(img, x - z / 2, y - z / 2, z, z);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

function sprite(r: number, g: number, b: number, mid: number) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
  grad.addColorStop(mid, `rgba(${r},${g},${b},0.55)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 32, 32);
  return c;
}

// ------------------------------------------------------------------ mesh

/**
 * Static conductor mesh, redrawn on resize and level change. Faulted edges
 * (`faulted`, indexed like `Board`: horizontal edges first, then vertical)
 * are drawn as a broken, dashed amber-dim line with a tiny spark mark.
 */
export function drawMesh(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  dpr: number,
  lat: Lattice,
  faulted?: Uint8Array,
) {
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const { cols, rows, spacing: s, ox, oy } = lat;
  const H = (cols - 1) * rows;
  const hCut = (c: number, r: number) => !!faulted && faulted[r * (cols - 1) + c] === 1;
  const vCut = (c: number, r: number) => !!faulted && faulted[H + r * cols + c] === 1;
  const half = 0.5 / dpr; // crisp hairlines

  ctx.strokeStyle = 'rgba(95, 227, 255, 0.075)';
  ctx.lineWidth = 1 / dpr;
  ctx.beginPath();
  for (let r = 0; r < rows; r++) {
    const y = oy + r * s + half;
    ctx.moveTo(0, y);
    for (let c = 0; c < cols - 1; c++) {
      if (!hCut(c, r)) continue;
      ctx.lineTo(ox + c * s, y);
      ctx.moveTo(ox + (c + 1) * s, y);
    }
    ctx.lineTo(width, y);
  }
  for (let c = 0; c < cols; c++) {
    const x = ox + c * s + half;
    ctx.moveTo(x, 0);
    for (let r = 0; r < rows - 1; r++) {
      if (!vCut(c, r)) continue;
      ctx.lineTo(x, oy + r * s);
      ctx.moveTo(x, oy + (r + 1) * s);
    }
    ctx.lineTo(x, height);
  }
  ctx.stroke();

  if (faulted) {
    const cuts: [number, number, number, number][] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols - 1; c++) if (hCut(c, r)) cuts.push([c, r, c + 1, r]);
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols; c++) if (vCut(c, r)) cuts.push([c, r, c, r + 1]);
    const gap = 5; // px either side of the break
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 181, 71, 0.32)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (const [c0, r0, c1, r1] of cuts) {
      const ax = ox + c0 * s;
      const ay = oy + r0 * s;
      const bx = ox + c1 * s;
      const by = oy + r1 * s;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const dx = Math.sign(bx - ax);
      const dy = Math.sign(by - ay);
      ctx.moveTo(ax, ay);
      ctx.lineTo(mx - dx * gap, my - dy * gap);
      ctx.moveTo(bx, by);
      ctx.lineTo(mx + dx * gap, my + dy * gap);
    }
    ctx.stroke();
    // Spark: a tiny zigzag across the break.
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255, 181, 71, 0.8)';
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const [c0, r0, c1, r1] of cuts) {
      const mx = ox + ((c0 + c1) / 2) * s;
      const my = oy + ((r0 + r1) / 2) * s;
      // along (ux, uy), across (nx, ny)
      const ux = c1 - c0;
      const uy = r1 - r0;
      const nx = -uy;
      const ny = ux;
      const p = (a: number, b: number) => [mx + ux * a + nx * b, my + uy * a + ny * b] as const;
      ctx.moveTo(...p(-1.5, -4));
      ctx.lineTo(...p(1.5, -0.5));
      ctx.lineTo(...p(-1.5, 0.5));
      ctx.lineTo(...p(1.5, 4));
    }
    ctx.stroke();
    ctx.restore();
  }

  ctx.fillStyle = 'rgba(95, 227, 255, 0.22)';
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      ctx.fillRect(ox + c * s - 1, oy + r * s - 1, 2, 2);
    }
  }
}
