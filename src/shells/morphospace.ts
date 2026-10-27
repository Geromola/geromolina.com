/**
 * The cube as a map: log10 W across, D up, with T on a separate strip. Pure geometry for the
 * map canvas (0..1 coordinates, y up), the touch boundary for the current T slice, region
 * slices and a seeded "never evolved" point.
 */
import {
  D_MAX,
  LOG_W_MAX,
  LOG_W_MIN,
  REGIONS,
  T_MAX,
  classify,
  touchBoundaryD,
  type Region,
  type ShellParams,
} from './model';

/** Map position (0..1, y up) of a shell's W and D. */
export const mapPoint = (p: Pick<ShellParams, 'W' | 'D'>): [number, number] => [
  (Math.log10(p.W) - LOG_W_MIN) / (LOG_W_MAX - LOG_W_MIN),
  p.D / D_MAX,
];

/** W and D at a map position; clamped to the cube. */
export function fromMap(x: number, y: number): Pick<ShellParams, 'W' | 'D'> {
  const cx = Math.min(1, Math.max(0, x));
  const cy = Math.min(1, Math.max(0, y));
  return { W: 10 ** (LOG_W_MIN + cx * (LOG_W_MAX - LOG_W_MIN)), D: cy * D_MAX };
}

export const stripPos = (T: number) => T / T_MAX;
export const fromStrip = (y: number) => Math.min(1, Math.max(0, y)) * T_MAX;

/** The touch boundary across the map for a T slice, as map points. Below it, whorls touch. */
export function boundaryPolyline(T: number, steps = 160): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const x = i / steps;
    const { W } = fromMap(x, 0);
    pts.push([x, Math.min(1, touchBoundaryD(W, T) / D_MAX)]);
  }
  return pts;
}

export interface RegionSlice {
  region: Region;
  /** Map rectangle: x0, y0, x1, y1 (0..1, y up). */
  rect: [number, number, number, number];
  /** Does the current T fall inside the region's T range? */
  active: boolean;
}

export function regionSlices(T: number): RegionSlice[] {
  return REGIONS.map((region) => {
    const [x0] = mapPoint({ W: 10 ** region.logW[0], D: region.D[0] });
    const [x1] = mapPoint({ W: 10 ** region.logW[1], D: region.D[1] });
    return {
      region,
      rect: [Math.max(0, x0), region.D[0] / D_MAX, Math.min(1, x1), Math.min(1, region.D[1] / D_MAX)],
      active: T >= region.T[0] && T <= region.T[1],
    };
  });
}

/** Mulberry32: small, seedable, good enough for picking a point. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A shell no animal has built: a seeded point outside every region. Kept away from the very
 * edges of the cube (D ≤ 0.85, W ≥ 1.1), where the shapes are hard to read.
 */
export function randomEmptyPoint(seed: number): ShellParams {
  const next = rng(seed);
  for (let i = 0; i < 1000; i++) {
    const p = {
      W: 10 ** (Math.log10(1.1) + next() * (LOG_W_MAX - Math.log10(1.1))),
      D: next() * 0.85,
      T: next() * T_MAX,
    };
    if (!classify(p)) return p;
  }
  return { W: 30, D: 0.7, T: 3 };
}
