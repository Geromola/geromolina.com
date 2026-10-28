/**
 * The cube as geometry: the flat slice map (log10 W across, D up, T on a separate strip, 0..1
 * coordinates, y up) and the 3D cube (the same scales on three axes, T up), with the touch
 * boundary, region slices and boxes, and a seeded "never evolved" point.
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

// ------------------------------------------------------------------ the cube in 3D

/** A point in the unit cube: x = log W, y = D, z = T (up), each 0..1 (the map and strip scales). */
export type CubePoint = [number, number, number];

export const cubePoint = (p: ShellParams): CubePoint => {
  const [x, y] = mapPoint(p);
  return [x, y, stripPos(p.T)];
};

/** The cube's 12 edges, as pairs of corners. */
export const CUBE_EDGES: readonly [CubePoint, CubePoint][] = (() => {
  const edges: [CubePoint, CubePoint][] = [];
  for (const a of [0, 1]) {
    for (const b of [0, 1]) {
      edges.push([[0, a, b], [1, a, b]]);
      edges.push([[a, 0, b], [a, 1, b]]);
      edges.push([[a, b, 0], [a, b, 1]]);
    }
  }
  return edges;
})();

/** A region's box in the cube: [x0, y0, z0, x1, y1, z1]. */
export function regionBox(region: Region): [number, number, number, number, number, number] {
  const [x0, y0] = mapPoint({ W: 10 ** region.logW[0], D: region.D[0] });
  const [x1, y1] = mapPoint({ W: 10 ** region.logW[1], D: Math.min(D_MAX, region.D[1]) });
  return [Math.max(0, x0), y0, stripPos(region.T[0]), Math.min(1, x1), Math.min(1, y1), stripPos(region.T[1])];
}

/** The six faces of a box, each as four corners in order. */
export function boxFaces([x0, y0, z0, x1, y1, z1]: ReturnType<typeof regionBox>): CubePoint[][] {
  return [
    [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]],
    [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]],
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
  ];
}

/**
 * The surface where whorls stop touching, as a mesh of lines: one curve across W at each of
 * `tLines` heights, and one up T at each W decade. Below the sheet, whorls touch.
 */
export function touchSheet(tLines = 5, steps = 60): CubePoint[][] {
  const lines: CubePoint[][] = [];
  for (let k = 0; k < tLines; k++) {
    const z = k / (tLines - 1);
    lines.push(boundaryPolyline(fromStrip(z), steps).map(([x, y]) => [x, y, z]));
  }
  for (let e = 0; e <= LOG_W_MAX; e++) {
    const W = Math.max(10 ** e, 10 ** LOG_W_MIN);
    const [x] = mapPoint({ W, D: 0 });
    const line: CubePoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const z = i / steps;
      line.push([x, Math.min(1, touchBoundaryD(W, fromStrip(z)) / D_MAX), z]);
    }
    lines.push(line);
  }
  return lines;
}
