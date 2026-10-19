import type { GridSim } from './sim';
import type { Lattice } from './layout';

export interface Renderer {
  readonly kind: 'webgl' | 'canvas';
  resize(width: number, height: number, dpr: number, lat: Lattice): void;
  draw(sim: GridSim, dt: number): void;
}

const TRAIL = 3; // trail samples behind each head
const TRAIL_SECONDS = 0.028; // spacing between samples, in seconds of travel
const TRAIL_MAX = 0.4; // lattice units

/** Shared trail bookkeeping: velocity from frame-to-frame motion, so AC jiggle streaks too. */
class Trails {
  prevX = new Float32Array(0);
  prevY = new Float32Array(0);
  vx = new Float32Array(0);
  vy = new Float32Array(0);

  update(sim: GridSim, dt: number) {
    if (this.prevX.length !== sim.count) {
      this.prevX = Float32Array.from(sim.x);
      this.prevY = Float32Array.from(sim.y);
      this.vx = new Float32Array(sim.count);
      this.vy = new Float32Array(sim.count);
    }
    const inv = dt > 0 ? 1 / dt : 0;
    for (let i = 0; i < sim.count; i++) {
      const dx = sim.x[i] - this.prevX[i];
      const dy = sim.y[i] - this.prevY[i];
      if (dx * dx + dy * dy > 0.25) {
        this.vx[i] = this.vy[i] = 0; // respawned: no streak across the screen
      } else {
        // light smoothing keeps streaks steady between frames
        this.vx[i] += (dx * inv - this.vx[i]) * 0.5;
        this.vy[i] += (dy * inv - this.vy[i]) * 0.5;
      }
      this.prevX[i] = sim.x[i];
      this.prevY[i] = sim.y[i];
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

const VERT = `#version 300 es
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

const FRAG = `#version 300 es
precision mediump float;
in float v_bright;
in float v_hue;
out vec4 o;
const vec3 CYAN = vec3(0.37, 0.89, 1.0);
const vec3 HOT = vec3(0.93, 0.97, 1.0);
const vec3 AMBER = vec3(1.0, 0.66, 0.24);
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 10.0);
  float halo = exp(-r2 * 3.0) * 0.3;
  vec3 col = v_hue >= 0.0 ? mix(CYAN, HOT, v_hue) : mix(CYAN, AMBER, -v_hue);
  float a = (core + halo) * v_bright;
  o = vec4(col * a, a);
}`;

const STRIDE = 5; // x, y, bright, hue, size

export class WebGLRenderer implements Renderer {
  readonly kind = 'webgl' as const;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private data = new Float32Array(0);
  private trails = new Trails();
  private uRes: WebGLUniformLocation | null;
  private uLat: WebGLUniformLocation | null;
  private uDpr: WebGLUniformLocation | null;

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
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link');
    this.program = program;
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
    };
    attr('a_pos', 2, 0);
    attr('a_bright', 1, 2);
    attr('a_hue', 1, 3);
    attr('a_size', 1, 4);
    this.uRes = gl.getUniformLocation(program, 'u_res');
    this.uLat = gl.getUniformLocation(program, 'u_lat');
    this.uDpr = gl.getUniformLocation(program, 'u_dpr');
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
  }

  resize(width: number, height: number, dpr: number, lat: Lattice) {
    const { gl } = this;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.uniform2f(this.uRes, width, height);
    gl.uniform3f(this.uLat, lat.ox, lat.oy, lat.spacing);
    gl.uniform1f(this.uDpr, dpr);
  }

  draw(sim: GridSim, dt: number) {
    const { gl } = this;
    this.trails.update(sim, dt);
    const verts = sim.count * (TRAIL + 1);
    if (this.data.length !== verts * STRIDE) this.data = new Float32Array(verts * STRIDE);
    const d = this.data;
    let o = 0;
    for (let i = 0; i < sim.count; i++) {
      const head = sim.ambient[i] ? 5 : 7;
      for (let j = TRAIL; j >= 0; j--) {
        const [ox, oy] = this.trails.offset(i, j);
        d[o++] = sim.x[i] - ox;
        d[o++] = sim.y[i] - oy;
        d[o++] = sim.bright[i] * (j === 0 ? 1 : 0.42 / j);
        d[o++] = sim.hue[i];
        d[o++] = head * (1 - j * 0.16);
      }
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.POINTS, 0, verts);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'compile');
  return shader;
}

/** Canvas 2D fallback: pre-rendered glow sprites with additive compositing. */
export class CanvasRenderer implements Renderer {
  readonly kind = 'canvas' as const;
  private ctx: CanvasRenderingContext2D;
  private sprites: HTMLCanvasElement[];
  private trails = new Trails();
  private lat: Lattice = { cols: 0, rows: 0, spacing: 1, ox: 0, oy: 0 };
  private width = 0;
  private height = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    // amber · cyan · white-hot
    this.sprites = [
      [255, 168, 61],
      [95, 227, 255],
      [237, 247, 255],
    ].map(([r, g, b]) => sprite(r, g, b));
  }

  resize(width: number, height: number, dpr: number, lat: Lattice) {
    this.width = width;
    this.height = height;
    this.lat = lat;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(sim: GridSim, dt: number) {
    const { ctx, lat } = this;
    this.trails.update(sim, dt);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < sim.count; i++) {
      const h = sim.hue[i];
      const img = this.sprites[h < -0.33 ? 0 : h > 0.33 ? 2 : 1];
      const size = sim.ambient[i] ? 7 : 10;
      for (let j = 2; j >= 0; j--) {
        const [ox, oy] = this.trails.offset(i, j * 1.5);
        ctx.globalAlpha = Math.min(1, sim.bright[i] * (j === 0 ? 1 : 0.35 / j));
        const x = lat.ox + (sim.x[i] - ox) * lat.spacing;
        const y = lat.oy + (sim.y[i] - oy) * lat.spacing;
        const s = size * (1 - j * 0.2);
        ctx.drawImage(img, x - s / 2, y - s / 2, s, s);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

function sprite(r: number, g: number, b: number) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
  grad.addColorStop(0.25, `rgba(${r},${g},${b},0.55)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 32, 32);
  return c;
}

/** Static conductor mesh, redrawn only on resize. */
export function drawMesh(canvas: HTMLCanvasElement, width: number, height: number, dpr: number, lat: Lattice) {
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const half = 0.5 / dpr; // crisp hairlines
  ctx.strokeStyle = 'rgba(95, 227, 255, 0.075)';
  ctx.lineWidth = 1 / dpr;
  ctx.beginPath();
  for (let c = 0; c < lat.cols; c++) {
    const x = lat.ox + c * lat.spacing + half;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let r = 0; r < lat.rows; r++) {
    const y = lat.oy + r * lat.spacing + half;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(95, 227, 255, 0.22)';
  for (let c = 0; c < lat.cols; c++) {
    for (let r = 0; r < lat.rows; r++) {
      ctx.fillRect(lat.ox + c * lat.spacing - 1, lat.oy + r * lat.spacing - 1, 2, 2);
    }
  }
}
