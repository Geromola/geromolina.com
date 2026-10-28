/**
 * WebGL2 board renderer. The whole board lives in two R8 textures: `shade` (see engine.ts)
 * and an overlay (1 = birth next generation, 2 = death next generation, 3 = stamp ghost).
 * Only the changed rectangle is uploaded each frame. One full-screen fragment shader draws
 * round cyan cells that flash white when born, short amber trails, a soft glow from the
 * eight neighbours, faint grid lines when zoomed in, and the keyboard cursor.
 */
import type { LifeBoard, Rect } from './engine';
import { DOT_SCALE, type Camera } from './view';

export type RGB = [number, number, number];

export interface Palette {
  /** Live cells (`--cyan`). */
  live: RGB;
  /** Newborn cells (`--hot`). */
  hot: RGB;
  /** Trails and deaths (`--amber`). */
  trail: RGB;
  /** The board (`--bg`). */
  bg: RGB;
  /** Grid lines and the area outside the board (`--muted`). */
  grid: RGB;
}

export interface Frame {
  camera: Camera;
  /** Keyboard cursor cell, or null. */
  cursor: [number, number] | null;
}

export interface LifeRenderer {
  readonly kind: 'webgl' | 'canvas';
  resize(width: number, height: number, dpr: number): void;
  /** Uploads `board.dirty()` and marks the board clean. */
  upload(board: LifeBoard): void;
  /** Uploads `rect` of the overlay buffer (same size as the board). */
  uploadOverlay(overlay: Uint8Array, rect: Rect): void;
  draw(frame: Frame): void;
}

const VERT = /* glsl */ `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_shade;
uniform sampler2D u_over;
uniform vec2 u_res;
uniform vec2 u_cam;
uniform float u_scale;
uniform ivec2 u_board;
uniform vec3 u_live;
uniform vec3 u_hot;
uniform vec3 u_trail;
uniform vec3 u_bg;
uniform vec3 u_grid;
uniform vec3 u_cursor; // x, y, on
uniform float u_dotScale;
out vec4 o;

float shadeAt(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= u_board.x || c.y >= u_board.y) return 0.0;
  return floor(texelFetch(u_shade, c, 0).r * 255.0 + 0.5);
}

// Colour and strength of a cell's own light: live cells cool from hot to cyan in ~3 gens.
vec4 light(float v) {
  if (v >= 128.0) {
    float young = clamp(1.0 - (v - 128.0) / 3.0, 0.0, 1.0);
    return vec4(mix(u_live, u_hot, young), 1.0);
  }
  if (v > 0.0) return vec4(u_trail, v / 6.0 * 0.55);
  return vec4(0.0);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec2 cell = u_cam + (px - 0.5 * u_res) / u_scale;
  ivec2 ci = ivec2(floor(cell));
  if (ci.x < 0 || ci.y < 0 || ci.x >= u_board.x || ci.y >= u_board.y) {
    o = vec4(mix(u_bg, u_grid, 0.04), 1.0);
    return;
  }
  vec2 f = fract(cell) - 0.5;
  float aa = 1.0 / u_scale; // one device pixel, in cells
  vec3 col = u_bg;
  float ov = floor(texelFetch(u_over, ci, 0).r * 255.0 + 0.5);

  if (u_scale < u_dotScale) {
    // Zoomed out: flat cells. Below ~1.5 px a pixel can cover two cells, so take the brightest.
    float v = shadeAt(ci);
    if (u_scale < 1.5) {
      vec2 c2 = u_cam + (px + 0.75 - 0.5 * u_res) / u_scale;
      v = max(v, shadeAt(ivec2(floor(c2))));
    }
    vec4 l = light(v);
    col = mix(col, l.rgb, l.a);
    if (ov == 3.0) col = mix(col, u_live, 0.45);
    else if (ov == 1.0) col = mix(col, u_hot, 0.35);
    else if (ov == 2.0) col = mix(col, u_trail, 0.45);
    o = vec4(col, 1.0);
    return;
  }

  // Grid lines, fading in as cells grow.
  vec2 g = abs(fract(cell) - 0.5);
  float edge = 0.5 - max(g.x, g.y);
  float gridA = (1.0 - smoothstep(0.0, aa * 1.2, edge)) * smoothstep(u_dotScale, u_dotScale * 2.5, u_scale) * 0.07;
  col = mix(col, u_grid, gridA);

  // Glow from this cell and its eight neighbours.
  vec3 glow = vec3(0.0);
  for (int dy = -1; dy <= 1; dy++)
    for (int dx = -1; dx <= 1; dx++) {
      vec4 l = light(shadeAt(ci + ivec2(dx, dy)));
      if (l.a <= 0.0) continue;
      vec2 d = f - vec2(dx, dy);
      glow += l.rgb * l.a * exp(-dot(d, d) * 4.0) * 0.16;
    }
  col += glow;

  // The cell itself: a round dot (trails shrink as they fade).
  vec4 me = light(shadeAt(ci));
  float r = me.a >= 1.0 ? 0.36 : 0.2 + 0.16 * me.a;
  float d = length(f);
  float disc = 1.0 - smoothstep(r - aa, r + aa, d);
  col = mix(col, me.rgb, disc * me.a);

  // Overlay: births as hot rings, deaths as amber rings, the stamp ghost as a soft disc.
  float ring = 1.0 - smoothstep(aa, aa * 2.0, abs(d - 0.3));
  if (ov == 1.0) col = mix(col, u_hot, ring * 0.75);
  else if (ov == 2.0) col = mix(col, u_trail, ring * 0.9);
  else if (ov == 3.0) col = mix(col, u_live, (1.0 - smoothstep(0.34 - aa, 0.34 + aa, d)) * 0.5);

  // Keyboard cursor: a square outline round the cell.
  if (u_cursor.z > 0.5 && ci == ivec2(u_cursor.xy)) {
    float box = 1.0 - smoothstep(aa, aa * 2.0, abs(max(g.x, g.y) - 0.46));
    col = mix(col, u_live, box);
  }
  o = vec4(col, 1.0);
}`;

export class GLLifeRenderer implements LifeRenderer {
  readonly kind = 'webgl' as const;
  private dpr = 1;
  private shadeTex: WebGLTexture;
  private overTex: WebGLTexture;
  private loc: Record<string, WebGLUniformLocation | null> = {};

  static create(canvas: HTMLCanvasElement, board: LifeBoard, palette: Palette): GLLifeRenderer | null {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false });
    if (!gl) return null;
    try {
      return new GLLifeRenderer(gl, board, palette);
    } catch {
      return null;
    }
  }

  private constructor(
    private gl: WebGL2RenderingContext,
    private board: LifeBoard,
    private palette: Palette,
  ) {
    const prog = gl.createProgram()!;
    for (const [type, src] of [
      [gl.VERTEX_SHADER, VERT],
      [gl.FRAGMENT_SHADER, FRAG],
    ] as const) {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['u_shade', 'u_over', 'u_res', 'u_cam', 'u_scale', 'u_board', 'u_live', 'u_hot', 'u_trail', 'u_bg', 'u_grid', 'u_cursor', 'u_dotScale'])
      this.loc[n] = gl.getUniformLocation(prog, n);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.shadeTex = this.texture(0, board.shade);
    this.overTex = this.texture(1, new Uint8Array(board.w * board.h));
    gl.uniform1i(this.loc.u_shade, 0);
    gl.uniform1i(this.loc.u_over, 1);
    gl.uniform2i(this.loc.u_board, board.w, board.h);
    gl.uniform1f(this.loc.u_dotScale, DOT_SCALE);
    const p = this.palette;
    gl.uniform3fv(this.loc.u_live, p.live);
    gl.uniform3fv(this.loc.u_hot, p.hot);
    gl.uniform3fv(this.loc.u_trail, p.trail);
    gl.uniform3fv(this.loc.u_bg, p.bg);
    gl.uniform3fv(this.loc.u_grid, p.grid);
    board.clean();
  }

  private texture(unit: number, data: Uint8Array): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.board.w, this.board.h, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    return t;
  }

  private sub(unit: number, tex: WebGLTexture, data: Uint8Array, r: Rect) {
    const gl = this.gl;
    const w = r.x1 - r.x0,
      h = r.y1 - r.y0;
    if (w <= 0 || h <= 0) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.board.w);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x0, r.y0, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  }

  resize(width: number, height: number, dpr: number) {
    this.dpr = dpr;
    const c = this.gl.canvas as HTMLCanvasElement;
    c.width = Math.max(1, Math.round(width * dpr));
    c.height = Math.max(1, Math.round(height * dpr));
    this.gl.viewport(0, 0, c.width, c.height);
  }

  upload(board: LifeBoard) {
    const r = board.dirty();
    if (r) this.sub(0, this.shadeTex, board.shade, r);
    board.clean();
  }

  uploadOverlay(overlay: Uint8Array, rect: Rect) {
    this.sub(1, this.overTex, overlay, rect);
  }

  draw({ camera, cursor }: Frame) {
    const gl = this.gl;
    const c = gl.canvas as HTMLCanvasElement;
    gl.uniform2f(this.loc.u_res, c.width, c.height);
    gl.uniform2f(this.loc.u_cam, camera.cx, camera.cy);
    gl.uniform1f(this.loc.u_scale, camera.scale * this.dpr);
    gl.uniform1f(this.loc.u_dotScale, DOT_SCALE * this.dpr);
    gl.uniform3f(this.loc.u_cursor, cursor?.[0] ?? 0, cursor?.[1] ?? 0, cursor ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
