/**
 * WebGL2 Jones agents (SPEC "Physarum"): the same model as agents.ts, on the GPU.
 * - Agent state (x, y, heading, moved) lives in an RGBA32F texture, ping-ponged by a
 *   fragment shader that senses, turns and moves every agent.
 * - Agents deposit as one-pixel points (texelFetch by gl_VertexID), additively blended into
 *   an R16F trail.
 * - A pass diffuses (3 × 3 mean), decays, adds the attractant field and clears lit cells.
 * - The display pass maps the trail over the dish: agar → ochre → chrome yellow → a pale glow at
 *   the densest veins, with a darker rim and a faint grain, so the board reads as a petri dish.
 * Needs EXT_color_buffer_float (float render targets); `create` returns null without it.
 */
import { DEPOSIT_SHARE, type AgentParams } from './agents';

export type RGB = [number, number, number];

export interface Palette {
  /** The mold (`--phys-plasm`, chrome yellow). */
  mold: RGB;
  /** Its thin and old parts (`--phys-ochre`). */
  deep: RGB;
  /** Its densest veins (`--phys-glow`). */
  hot: RGB;
  /** The agar (`--phys-dish`). */
  board: RGB;
}

export interface BoardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AgentRenderer {
  readonly kind: 'webgl' | 'canvas';
  readonly gw: number;
  readonly gh: number;
  resize(width: number, height: number, dpr: number): void;
  setParams(p: AgentParams): void;
  /** Lit cells of the grid (1 = lit). */
  setLight(lit: Uint8Array): void;
  /** Attractant added to the trail every step (see agents.ts attractField). */
  setAttract(field: Float32Array): void;
  /** Scatters the agents over the dark cells and clears the trail. */
  respawn(lit: Uint8Array, seed: number): void;
  /** Clears the trail along segments [x0, y0, x1, y1, …] in grid cells. */
  erase(segments: number[], radius: number): void;
  step(n: number): void;
  /** Draws the board; `mold` false draws the empty board only. */
  draw(rect: BoardRect, mold: boolean): void;
}

const QUAD_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const UPDATE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_agents;
uniform sampler2D u_trail;
uniform sampler2D u_light;
uniform ivec2 u_grid;
uniform float u_sa;
uniform float u_so;
uniform float u_turn;
uniform float u_step;
uniform uint u_frame;
uniform int u_width;
out vec4 o;

uint hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float rand(uint i, uint salt) { return float(hash(i * 2654435761u ^ hash(u_frame * 0x9e3779b9u + salt))) / 4294967295.0; }

bool lit(ivec2 c) {
  return c.x < 0 || c.y < 0 || c.x >= u_grid.x || c.y >= u_grid.y || texelFetch(u_light, c, 0).r > 0.5;
}
float sense(vec2 p) {
  ivec2 c = ivec2(floor(p));
  return lit(c) ? -1000.0 : texelFetch(u_trail, c, 0).r;
}

void main() {
  ivec2 me = ivec2(gl_FragCoord.xy);
  uint id = uint(me.y * u_width + me.x);
  vec4 ag = texelFetch(u_agents, me, 0);
  vec2 p = ag.xy;
  float h = ag.z;
  float f = sense(p + vec2(cos(h), sin(h)) * u_so);
  float l = sense(p + vec2(cos(h - u_sa), sin(h - u_sa)) * u_so);
  float r = sense(p + vec2(cos(h + u_sa), sin(h + u_sa)) * u_so);
  if (f > l && f > r) {
  } else if (f < l && f < r) h += (rand(id, 1u) < 0.5 ? -1.0 : 1.0) * u_turn;
  else if (l > r) h -= u_turn;
  else if (r > l) h += u_turn;
  vec2 n = p + vec2(cos(h), sin(h)) * u_step;
  if (lit(ivec2(floor(n)))) {
    o = vec4(p, rand(id, 2u) * 6.2831853, 0.0);
  } else {
    o = vec4(n, mod(h, 6.2831853), 1.0);
  }
}`;

const DEPOSIT_VS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_agents;
uniform sampler2D u_attract;
uniform int u_width;
uniform vec2 u_grid;
uniform float u_full; // attractant at which the deposit is full (DEPOSIT_SHARE × tubes)
out float v_w;
void main() {
  vec4 ag = texelFetch(u_agents, ivec2(gl_VertexID % u_width, gl_VertexID / u_width), 0);
  v_w = clamp(texelFetch(u_attract, ivec2(floor(ag.xy)), 0).r / u_full, 0.0, 1.0);
  gl_PointSize = 1.0;
  gl_Position = ag.w > 0.5 ? vec4((floor(ag.xy) + 0.5) / u_grid * 2.0 - 1.0, 0.0, 1.0) : vec4(2.0, 2.0, 0.0, 1.0);
}`;

const DEPOSIT_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float u_deposit;
in float v_w;
out vec4 o;
void main() { o = vec4(u_deposit * v_w); }`;

const DIFFUSE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_trail;
uniform sampler2D u_light;
uniform sampler2D u_attract;
uniform ivec2 u_grid;
uniform float u_keep;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (texelFetch(u_light, c, 0).r > 0.5) { o = vec4(0.0); return; }
  float s = 0.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++)
      s += texelFetch(u_trail, clamp(c + ivec2(i, j), ivec2(0), u_grid - 1), 0).r;
  o = vec4(s / 9.0 * u_keep + texelFetch(u_attract, c, 0).r);
}`;

const ERASE_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
uniform vec2 u_grid;
void main() { gl_Position = vec4(a_pos / u_grid * 2.0 - 1.0, 0.0, 1.0); }`;

const ERASE_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(0.0); }`;

const SHOW_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_trail;
uniform vec4 u_rect; // board rect in device px: x, y (from the bottom), w, h
uniform vec3 u_mold;
uniform vec3 u_deep;
uniform vec3 u_hot;
uniform vec3 u_board;
uniform float u_show;
out vec4 o;
void main() {
  vec2 uv = (gl_FragCoord.xy - u_rect.xy) / u_rect.zw;
  uv.y = 1.0 - uv.y;
  float v = texture(u_trail, uv).r * u_show;
  float a = v / (v + 14.0);
  // The dish: darker toward the rim, with a faint grain in the agar.
  float rim = 1.0 - 0.38 * smoothstep(0.3, 0.78, length(uv - 0.5));
  float grain = fract(sin(dot(floor(gl_FragCoord.xy * 0.5), vec2(12.9898, 78.233))) * 43758.5453) * 0.02 - 0.01;
  vec3 c = u_board * rim + grain;
  // Thin plasmodium is a translucent ochre film; thick veins are chrome yellow with a pale core.
  c = mix(c, u_deep, smoothstep(0.0, 0.5, a) * 0.85);
  c = mix(c, u_mold, smoothstep(0.32, 0.86, a));
  c = mix(c, u_hot, smoothstep(0.82, 1.0, a) * 0.5);
  o = vec4(c, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn(gl.getShaderInfoLog(sh));
      return null;
    }
    gl.attachShader(prog, sh);
  }
  gl.bindAttribLocation(prog, 0, 'a_pos');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn(gl.getProgramInfoLog(prog));
    return null;
  }
  return prog;
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export class GLAgentRenderer implements AgentRenderer {
  readonly kind = 'webgl' as const;
  readonly gw: number;
  readonly gh: number;
  private dpr = 1;
  private frame = 0;
  private cur = 0;
  private params!: AgentParams;
  private agents: [Target, Target];
  private trail: [Target, Target];
  private light: WebGLTexture;
  private attract: WebGLTexture;
  private quad: WebGLVertexArrayObject;
  private eraseVao: WebGLVertexArrayObject;
  private eraseBuf: WebGLBuffer;
  private empty: WebGLVertexArrayObject;
  private u = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  static create(canvas: HTMLCanvasElement, gw: number, gh: number, aw: number, ah: number, palette: Palette): GLAgentRenderer | null {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
    const progs = [
      compile(gl, QUAD_VS, UPDATE_FS),
      compile(gl, DEPOSIT_VS, DEPOSIT_FS),
      compile(gl, QUAD_VS, DIFFUSE_FS),
      compile(gl, ERASE_VS, ERASE_FS),
      compile(gl, QUAD_VS, SHOW_FS),
    ];
    if (progs.some((p) => !p)) return null;
    try {
      return new GLAgentRenderer(gl, progs as WebGLProgram[], gw, gh, aw, ah, palette);
    } catch (err) {
      console.warn(err);
      return null;
    }
  }

  private constructor(
    private gl: WebGL2RenderingContext,
    private progs: WebGLProgram[],
    gw: number,
    gh: number,
    private aw: number,
    private ah: number,
    private palette: Palette,
  ) {
    this.gw = gw;
    this.gh = gh;
    const target = (w: number, h: number, internal: number, format: number, type: number, filter: number): Target => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Physarum: float target incomplete');
      return { tex, fbo };
    };
    this.agents = [0, 1].map(() => target(aw, ah, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST)) as [Target, Target];
    this.trail = [0, 1].map(() => target(gw, gh, gl.R16F, gl.RED, gl.FLOAT, gl.LINEAR)) as [Target, Target];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const plain = (internal: number, format: number, type: number, data: ArrayBufferView) => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, gw, gh, 0, format, type, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return tex;
    };
    this.light = plain(gl.R8, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(gw * gh));
    this.attract = plain(gl.R16F, gl.RED, gl.FLOAT, new Float32Array(gw * gh));
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.eraseVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.eraseVao);
    this.eraseBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.eraseBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.empty = gl.createVertexArray()!;
    gl.bindVertexArray(null);
  }

  private loc(prog: WebGLProgram, name: string) {
    let m = this.u.get(prog);
    if (!m) this.u.set(prog, (m = new Map()));
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(prog, name));
    return m.get(name)!;
  }

  private bindTex(prog: WebGLProgram, name: string, unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.loc(prog, name), unit);
  }

  resize(width: number, height: number, dpr: number): void {
    this.dpr = dpr;
    const c = this.gl.canvas as HTMLCanvasElement;
    c.width = Math.max(1, Math.round(width * dpr));
    c.height = Math.max(1, Math.round(height * dpr));
  }

  setParams(p: AgentParams): void {
    this.params = p;
  }

  setLight(lit: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.light);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.gw, this.gh, gl.RED, gl.UNSIGNED_BYTE, lit.map((v) => (v ? 255 : 0)));
  }

  setAttract(field: Float32Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.attract);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.gw, this.gh, gl.RED, gl.FLOAT, field);
  }

  respawn(lit: Uint8Array, seed: number): void {
    const gl = this.gl;
    const n = this.aw * this.ah;
    const data = new Float32Array(n * 4);
    let s = seed >>> 0 || 1;
    const rnd = () => {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
    for (let k = 0; k < n; k++) {
      let x = 0, y = 0;
      for (let tries = 0; tries < 20; tries++) {
        x = rnd() * this.gw;
        y = rnd() * this.gh;
        if (!lit[Math.floor(y) * this.gw + Math.floor(x)]) break;
      }
      data.set([x, y, rnd() * Math.PI * 2, 0], k * 4);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.agents[this.cur].tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.aw, this.ah, gl.RGBA, gl.FLOAT, data);
    for (const t of this.trail) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  erase(segments: number[], radius: number): void {
    if (segments.length < 4) return;
    const gl = this.gl;
    const tris: number[] = [];
    for (let i = 0; i + 3 < segments.length; i += 4) {
      const [x0, y0, x1, y1] = segments.slice(i, i + 4);
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = (-(y1 - y0) / len) * radius, ny = ((x1 - x0) / len) * radius;
      const ex = ((x1 - x0) / len) * radius, ey = ((y1 - y0) / len) * radius;
      const a = [x0 - ex + nx, y0 - ey + ny], b = [x0 - ex - nx, y0 - ey - ny];
      const c = [x1 + ex + nx, y1 + ey + ny], d = [x1 + ex - nx, y1 + ey - ny];
      tris.push(...a, ...b, ...c, ...b, ...d, ...c);
    }
    const prog = this.progs[3];
    gl.useProgram(prog);
    gl.uniform2f(this.loc(prog, 'u_grid'), this.gw, this.gh);
    gl.bindVertexArray(this.eraseVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.eraseBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tris), gl.STREAM_DRAW);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, this.gw, this.gh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trail[0].fbo);
    gl.drawArrays(gl.TRIANGLES, 0, tris.length / 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trail[1].fbo);
    gl.drawArrays(gl.TRIANGLES, 0, tris.length / 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  step(n: number): void {
    const gl = this.gl;
    const p = this.params;
    const [update, deposit, diffuse] = this.progs;
    for (let s = 0; s < n; s++) {
      const a = this.agents[this.cur], aNext = this.agents[1 - this.cur];
      const t = this.trail[this.cur], tNext = this.trail[1 - this.cur];
      this.frame++;
      // 1. Sense, turn and move.
      gl.disable(gl.BLEND);
      gl.useProgram(update);
      gl.bindFramebuffer(gl.FRAMEBUFFER, aNext.fbo);
      gl.viewport(0, 0, this.aw, this.ah);
      this.bindTex(update, 'u_agents', 0, a.tex);
      this.bindTex(update, 'u_trail', 1, t.tex);
      this.bindTex(update, 'u_light', 2, this.light);
      gl.uniform2i(this.loc(update, 'u_grid'), this.gw, this.gh);
      gl.uniform1f(this.loc(update, 'u_sa'), p.sensorAngle);
      gl.uniform1f(this.loc(update, 'u_so'), p.sensorOffset);
      gl.uniform1f(this.loc(update, 'u_turn'), p.turn);
      gl.uniform1f(this.loc(update, 'u_step'), p.stepSize);
      gl.uniform1ui(this.loc(update, 'u_frame'), this.frame);
      gl.uniform1i(this.loc(update, 'u_width'), this.aw);
      gl.bindVertexArray(this.quad);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // 2. Deposit where they moved.
      gl.useProgram(deposit);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.viewport(0, 0, this.gw, this.gh);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.bindTex(deposit, 'u_agents', 0, aNext.tex);
      this.bindTex(deposit, 'u_attract', 1, this.attract);
      gl.uniform1f(this.loc(deposit, 'u_full'), DEPOSIT_SHARE * p.tubes);
      gl.uniform1i(this.loc(deposit, 'u_width'), this.aw);
      gl.uniform2f(this.loc(deposit, 'u_grid'), this.gw, this.gh);
      gl.uniform1f(this.loc(deposit, 'u_deposit'), p.deposit);
      gl.bindVertexArray(this.empty);
      gl.drawArrays(gl.POINTS, 0, this.aw * this.ah);
      gl.disable(gl.BLEND);
      // 3. Diffuse, decay, attract.
      gl.useProgram(diffuse);
      gl.bindFramebuffer(gl.FRAMEBUFFER, tNext.fbo);
      this.bindTex(diffuse, 'u_trail', 0, t.tex);
      this.bindTex(diffuse, 'u_light', 1, this.light);
      this.bindTex(diffuse, 'u_attract', 2, this.attract);
      gl.uniform2i(this.loc(diffuse, 'u_grid'), this.gw, this.gh);
      gl.uniform1f(this.loc(diffuse, 'u_keep'), 1 - p.decay);
      gl.bindVertexArray(this.quad);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.cur = 1 - this.cur;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  draw(rect: BoardRect, mold: boolean): void {
    const gl = this.gl;
    const d = this.dpr;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const x = Math.round(rect.x * d), w = Math.round(rect.w * d), h = Math.round(rect.h * d);
    const y = gl.drawingBufferHeight - Math.round(rect.y * d) - h;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, w, h);
    const show = this.progs[4];
    gl.useProgram(show);
    this.bindTex(show, 'u_trail', 0, this.trail[this.cur].tex);
    gl.uniform4f(this.loc(show, 'u_rect'), x, y, w, h);
    gl.uniform3fv(this.loc(show, 'u_mold'), this.palette.mold);
    gl.uniform3fv(this.loc(show, 'u_deep'), this.palette.deep);
    gl.uniform3fv(this.loc(show, 'u_hot'), this.palette.hot);
    gl.uniform3fv(this.loc(show, 'u_board'), this.palette.board);
    gl.uniform1f(this.loc(show, 'u_show'), mold ? 1 : 0);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
  }
}
