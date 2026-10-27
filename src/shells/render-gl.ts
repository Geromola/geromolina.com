/**
 * WebGL2 shell renderer: one lit, double-sided surface. Growth lines (cyan, across the tube
 * at fixed turns) and faint spiral ribs come from the mesh's uv; the growing edge is amber;
 * the inside of the tube is darker. Fragments past `grow` are cut, which is how the shell
 * grows from its tip.
 */
import { INDEX_COUNT, MIRROR_Y, IDENTITY, type Camera, type ShellMesh } from './mesh';

export type RGB = [number, number, number];

export interface Palette {
  /** Shell surface (`--hot`). */
  base: RGB;
  /** Growth lines and rim light (`--cyan`). */
  line: RGB;
  /** The growing edge and the inside (`--amber`). */
  edge: RGB;
}

export interface Frame {
  camera: Camera;
  /** 0..1 along the tube: how much of the shell has grown. */
  grow: number;
  /** Width of the amber growing edge, in the same units as `grow`. */
  edge: number;
  /** Draw the mirrored valve as well. */
  paired: boolean;
}

export interface ShellRenderer {
  readonly kind: 'webgl' | 'canvas';
  resize(width: number, height: number, dpr: number): void;
  /** Re-upload geometry after `mesh.build`. */
  upload(mesh: ShellMesh): void;
  draw(frame: Frame): void;
}

const VERT = /* glsl */ `#version 300 es
in vec3 a_pos;
in vec3 a_nrm;
in vec3 a_uv;
uniform mat4 u_proj;
uniform mat4 u_view;
uniform mat4 u_model;
out vec3 v_pos;
out vec3 v_nrm;
out vec3 v_uv;
void main() {
  vec4 world = u_model * vec4(a_pos, 1.0);
  v_pos = world.xyz;
  v_nrm = mat3(u_model) * a_nrm;
  v_uv = a_uv;
  gl_Position = u_proj * u_view * world;
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_pos;
in vec3 v_nrm;
in vec3 v_uv;
uniform vec3 u_eye;
uniform vec3 u_light;
uniform vec3 u_base;
uniform vec3 u_line;
uniform vec3 u_edge;
uniform float u_grow;
uniform float u_edgeW;
uniform float u_mirror;
out vec4 o;

float lines(float t, float strength) {
  float w = fwidth(t);
  float f = fract(t);
  float d = min(f, 1.0 - f);
  float l = 1.0 - smoothstep(0.0, w * 1.25, d);
  // Fade out where lines crowd into less than a few pixels.
  return l * (1.0 - smoothstep(0.12, 0.4, w)) * strength;
}

void main() {
  if (v_uv.x > u_grow) discard;
  vec3 n = normalize(v_nrm);
  // A mirrored draw flips winding, so front-facing means inside there.
  bool outside = gl_FrontFacing == (u_mirror < 0.5);
  if (!outside) n = -n;
  vec3 v = normalize(u_eye - v_pos);
  float lam = max(dot(n, u_light), 0.0);
  float hemi = 0.5 + 0.5 * n.z;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  float spec = pow(max(dot(reflect(-u_light, n), v), 0.0), 28.0);

  vec3 col;
  if (outside) {
    col = u_base * (0.07 + 0.5 * lam + 0.12 * hemi) + u_base * spec * 0.25;
    col += u_line * (lines(v_uv.y * 18.0, 0.55) + lines(v_uv.z * 16.0, 0.16));
    col += u_line * rim * 0.22;
  } else {
    // Nacre: dimmer, warmer.
    col = mix(u_base, u_edge, 0.35) * (0.04 + 0.22 * lam + 0.05 * hemi);
  }
  float edge = 1.0 - smoothstep(0.0, u_edgeW, u_grow - v_uv.x);
  col = mix(col, u_edge, edge * 0.85) + u_edge * edge * 0.35;
  o = vec4(col, 1.0);
}`;

export class GLShellRenderer implements ShellRenderer {
  readonly kind = 'webgl' as const;
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private bufs: { pos: WebGLBuffer; nrm: WebGLBuffer; uv: WebGLBuffer };
  private u: Record<string, WebGLUniformLocation | null> = {};
  private indicesUploaded = false;

  static create(canvas: HTMLCanvasElement, palette: Palette): GLShellRenderer | null {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true });
    if (!gl) return null;
    try {
      return new GLShellRenderer(canvas, gl, palette);
    } catch {
      return null;
    }
  }

  private constructor(
    private canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    palette: Palette,
  ) {
    this.gl = gl;
    this.prog = link(gl, VERT, FRAG);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const attr = (name: string) => {
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const loc = gl.getAttribLocation(this.prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      return buf;
    };
    this.bufs = { pos: attr('a_pos'), nrm: attr('a_nrm'), uv: attr('a_uv') };
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()!);
    gl.bindVertexArray(null);

    for (const n of ['u_proj', 'u_view', 'u_model', 'u_eye', 'u_light', 'u_base', 'u_line', 'u_edge', 'u_grow', 'u_edgeW', 'u_mirror']) {
      this.u[n] = gl.getUniformLocation(this.prog, n);
    }
    gl.useProgram(this.prog);
    gl.uniform3fv(this.u.u_base, palette.base);
    gl.uniform3fv(this.u.u_line, palette.line);
    gl.uniform3fv(this.u.u_edge, palette.edge);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }

  resize(width: number, height: number, dpr: number) {
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  upload(mesh: ShellMesh) {
    const { gl, bufs } = this;
    gl.bindVertexArray(this.vao);
    const put = (buf: WebGLBuffer, data: Float32Array) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    };
    put(bufs.pos, mesh.positions);
    put(bufs.nrm, mesh.normals);
    put(bufs.uv, mesh.uv);
    if (!this.indicesUploaded) {
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      this.indicesUploaded = true;
    }
    gl.bindVertexArray(null);
  }

  draw({ camera, grow, edge, paired }: Frame) {
    const { gl, u } = this;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(u.u_proj, false, camera.proj);
    gl.uniformMatrix4fv(u.u_view, false, camera.view);
    gl.uniform3fv(u.u_eye, camera.eye);
    gl.uniform3fv(u.u_light, keyLight(camera));
    gl.uniform1f(u.u_grow, grow);
    gl.uniform1f(u.u_edgeW, edge);
    gl.bindVertexArray(this.vao);
    const pass = (model: Float32Array, mirror: boolean) => {
      gl.uniformMatrix4fv(u.u_model, false, model);
      gl.uniform1f(u.u_mirror, mirror ? 1 : 0);
      gl.drawElements(gl.TRIANGLES, INDEX_COUNT, gl.UNSIGNED_SHORT, 0);
    };
    pass(IDENTITY, false);
    if (paired) pass(MIRROR_Y, true);
    gl.bindVertexArray(null);
  }
}

/** A key light above and to the left of the camera, in world space. */
export function keyLight(c: Camera): [number, number, number] {
  const l = [0, 1, 2].map((k) => -0.45 * c.right[k] + 0.75 * c.up[k] + 0.55 * c.back[k]);
  const len = Math.hypot(l[0], l[1], l[2]);
  return [l[0] / len, l[1] / len, l[2] / len];
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
