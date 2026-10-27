/**
 * Shell surface mesh and the small bit of 4×4 maths the renderers need. Fixed topology
 * (SEG_U steps along θ × SEG_V around the generating curve), so the buffers are allocated once
 * and refilled whenever the parameters change. Column-major matrices, as WebGL expects.
 */
import { apertureRadius, centreDistance, thetaMin, type ShellParams } from './model';

export const SEG_U = 600;
export const SEG_V = 32;
export const ROWS = SEG_U + 1;
export const COLS = SEG_V + 1; // the seam is duplicated so φ runs 0..1 without wrapping
export const VERTEX_COUNT = ROWS * COLS;
export const INDEX_COUNT = SEG_U * SEG_V * 6;

const TAU = Math.PI * 2;
const COS = Float64Array.from({ length: COLS }, (_, j) => Math.cos((j / SEG_V) * TAU));
const SIN = Float64Array.from({ length: COLS }, (_, j) => Math.sin((j / SEG_V) * TAU));

export interface Bounds {
  centre: [number, number, number];
  radius: number;
}

export class ShellMesh {
  readonly positions = new Float32Array(VERTEX_COUNT * 3);
  readonly normals = new Float32Array(VERTEX_COUNT * 3);
  /** Per vertex: u (0 at the oldest tube, 1 at the aperture), turns from the aperture, φ / 2π. */
  readonly uv = new Float32Array(VERTEX_COUNT * 3);
  readonly indices = buildIndices();
  bounds: Bounds = { centre: [0, 0, 0], radius: 1 };
  /** Turns drawn behind the aperture. */
  whorls = 0;

  /** Refill every buffer for `p`. `mirrored` widens the bounds to cover the paired valve. */
  build(p: ShellParams, mirrored = false) {
    const { positions: P, normals: N, uv } = this;
    const t0 = thetaMin(p.W);
    this.whorls = -t0 / TAU;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < ROWS; i++) {
      const u = i / SEG_U;
      const theta = t0 * (1 - u);
      const a = apertureRadius(p.W, theta);
      const rc = centreDistance(a, p.D);
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      const zc = -p.T * rc;
      for (let j = 0; j < COLS; j++) {
        const k = (i * COLS + j) * 3;
        const r = rc + a * COS[j];
        const x = r * ct;
        const y = r * st;
        const z = zc + a * SIN[j];
        P[k] = x;
        P[k + 1] = y;
        P[k + 2] = z;
        uv[k] = u;
        uv[k + 1] = theta / TAU;
        uv[k + 2] = j / SEG_V;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }

    // Normals: cross(∂P/∂θ, ∂P/∂φ) by central differences on the grid, which points outward.
    for (let i = 0; i < ROWS; i++) {
      const i0 = Math.max(0, i - 1) * COLS;
      const i1 = Math.min(SEG_U, i + 1) * COLS;
      for (let j = 0; j < COLS; j++) {
        const j0 = j === 0 ? SEG_V - 1 : j - 1;
        const j1 = j === SEG_V ? 1 : j + 1;
        const a0 = (i0 + j) * 3, a1 = (i1 + j) * 3;
        const b0 = (i * COLS + j0) * 3, b1 = (i * COLS + j1) * 3;
        const ux = P[a1] - P[a0], uy = P[a1 + 1] - P[a0 + 1], uz = P[a1 + 2] - P[a0 + 2];
        const vx = P[b1] - P[b0], vy = P[b1 + 1] - P[b0 + 1], vz = P[b1 + 2] - P[b0 + 2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-20) {
          nx /= len;
          ny /= len;
          nz /= len;
        } else {
          nx = 0;
          ny = 0;
          nz = 1;
        }
        const k = (i * COLS + j) * 3;
        N[k] = nx;
        N[k + 1] = ny;
        N[k + 2] = nz;
      }
    }

    if (mirrored) {
      const m = Math.max(Math.abs(minY), Math.abs(maxY));
      minY = -m;
      maxY = m;
    }
    // Sphere around the box centre, as tight as the vertices allow (the mirror is symmetric in y,
    // so |y| covers both valves).
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    let r2 = 0;
    for (let k = 0; k < P.length; k += 3) {
      const dx = P[k] - cx;
      const dy = (mirrored ? Math.abs(P[k + 1]) : P[k + 1]) - cy;
      const dz = P[k + 2] - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > r2) r2 = d;
    }
    this.bounds = { centre: [cx, cy, cz], radius: Math.max(1e-6, Math.sqrt(r2)) };
  }
}

function buildIndices() {
  const idx = new Uint16Array(INDEX_COUNT);
  let n = 0;
  for (let i = 0; i < SEG_U; i++) {
    for (let j = 0; j < SEG_V; j++) {
      const a = i * COLS + j;
      const b = a + COLS; // next θ
      // (a, b, a+1) runs θ then φ: counter-clockwise seen from outside.
      idx[n++] = a;
      idx[n++] = b;
      idx[n++] = a + 1;
      idx[n++] = a + 1;
      idx[n++] = b;
      idx[n++] = b + 1;
    }
  }
  return idx;
}

// ------------------------------------------------------------------ camera

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

export interface Camera {
  view: Mat4;
  proj: Mat4;
  eye: Vec3;
  /** Camera basis in world space. */
  right: Vec3;
  up: Vec3;
  /** From the target toward the eye. */
  back: Vec3;
}

export const FOV = (32 * Math.PI) / 180;

/**
 * Orbit camera around `target` at `yaw` (about the coiling axis) and `pitch` (above the
 * equator), far enough that a sphere of `radius` fits the shorter side of the viewport.
 */
export function orbitCamera(target: Vec3, radius: number, yaw: number, pitch: number, aspect: number): Camera {
  const fit = Math.min(1, aspect);
  const dist = (radius * 1.15) / Math.sin(Math.atan(Math.tan(FOV / 2) * fit));
  const cp = Math.cos(pitch);
  const back: Vec3 = [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)];
  const eye: Vec3 = [target[0] + back[0] * dist, target[1] + back[1] * dist, target[2] + back[2] * dist];
  const right = normalize(cross([0, 0, 1], back));
  const up = cross(back, right);
  const view = new Float32Array([
    right[0], up[0], back[0], 0,
    right[1], up[1], back[1], 0,
    right[2], up[2], back[2], 0,
    -dot(right, eye), -dot(up, eye), -dot(back, eye), 1,
  ]);
  return { view, proj: perspective(FOV, aspect, dist - radius * 1.5, dist + radius * 1.5), eye, right, up, back };
}

export function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const n = Math.max(near, far * 1e-3);
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (n - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + n) * nf, -1, 0, 0, 2 * far * n * nf, 0]);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** Applies a column-major matrix to a point; returns clip coordinates [x, y, z, w]. */
export function transform(m: Mat4, x: number, y: number, z: number): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

export const IDENTITY: Mat4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** The paired valve: a reflection across the aperture plane (y → −y). */
export const MIRROR_Y: Mat4 = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
