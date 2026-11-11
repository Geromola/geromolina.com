/**
 * How the plasmodium spreads before the flow model takes over (SPEC "Physarum"). DOM-free.
 *
 * Real Physarum explores by spreading out from where it sits in a fan of fine, branching
 * strands, and strands from different places fuse where they meet. Here every origin (a food)
 * grows a tree over the flow model's mesh: the shortest-path forest under random tube costs
 * (first-passage percolation), which branches and wanders the way the real fronts do. A vertex
 * is reached at its distance, and the tube that reached it grows out from its parent, so the
 * tips advance. Where two trees touch, a few of the cheapest tubes between them fuse, grown
 * from both ends until they meet in the middle.
 *
 * When the growth ends it hands the flow model its starting conductivities: strands thick in
 * proportion to what they feed, fused tubes thick, and every other tube a thin film, so the
 * flow model thins the strands the mold actually grew.
 */
import { mulberry32 } from '../energy/rounds';

export interface GrowthMesh {
  vx: ArrayLike<number>;
  vy: ArrayLike<number>;
  ea: ArrayLike<number>;
  eb: ArrayLike<number>;
  /** 1 where the tube exists (not under light, not cut). */
  alive: ArrayLike<number>;
}

export interface Growth {
  /** Cost distance at which each vertex is reached (Infinity when it never is). */
  reach: Float64Array;
  /** The parent of each vertex in its tree (-1 for origins and unreached vertices). */
  parent: Int32Array;
  /** The tube from the parent (-1 likewise). */
  via: Int32Array;
  /** Which origin's tree each vertex joined (-1 when unreached). */
  owner: Int32Array;
  /** Tubes where two trees fuse. */
  fuse: Int32Array;
  /** Reached vertices, nearest first. */
  order: Int32Array;
  /** Cost of each tube. */
  cost: Float64Array;
  /** When the last vertex is reached and the last fusion is complete. */
  end: number;
  /** Vertex positions for drawing, smoothed along the strands so they curve instead of zigzag. */
  sx: Float32Array;
  sy: Float32Array;
}

/** Spread of the random tube costs: a tube costs its length times 1 ± this. */
const COST_SPREAD = 0.6;
/** Fusions per pair of touching trees, at most, and how far apart they must sit (board units). */
const FUSE_MAX = 3;
const FUSE_GAP = 0.12;
/** Smoothing passes for the drawn strands. */
const SMOOTH_PASSES = 4;

/** Adjacency over alive tubes: the tubes of vertex v are adj[off[v] .. off[v + 1]). */
function adjacency(mesh: GrowthMesh, nv: number): { off: Int32Array; adj: Int32Array } {
  const ne = mesh.ea.length;
  const off = new Int32Array(nv + 1);
  for (let e = 0; e < ne; e++) {
    if (!mesh.alive[e]) continue;
    off[mesh.ea[e] + 1]++;
    off[mesh.eb[e] + 1]++;
  }
  for (let v = 0; v < nv; v++) off[v + 1] += off[v];
  const adj = new Int32Array(off[nv]);
  const fill = off.slice(0, nv);
  for (let e = 0; e < ne; e++) {
    if (!mesh.alive[e]) continue;
    adj[fill[mesh.ea[e]]++] = e;
    adj[fill[mesh.eb[e]]++] = e;
  }
  return { off, adj };
}

/** A binary min-heap of vertices keyed by distance. */
class Heap {
  private v: number[] = [];
  private k: number[] = [];
  get size(): number {
    return this.v.length;
  }
  push(vertex: number, key: number): void {
    const { v, k } = this;
    let i = v.length;
    v.push(vertex);
    k.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      v[i] = v[p];
      k[i] = k[p];
      i = p;
    }
    v[i] = vertex;
    k[i] = key;
  }
  pop(): [number, number] {
    const { v, k } = this;
    const top: [number, number] = [v[0], k[0]];
    const lv = v.pop()!;
    const lk = k.pop()!;
    if (v.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= v.length) break;
        const c = l + 1 < v.length && k[l + 1] < k[l] ? l + 1 : l;
        if (k[c] >= lk) break;
        v[i] = v[c];
        k[i] = k[c];
        i = c;
      }
      v[i] = lv;
      k[i] = lk;
    }
    return top;
  }
}

/** Grows a tree from each origin vertex over the alive tubes. */
export function grow(mesh: GrowthMesh, origins: readonly number[], seed = 1): Growth {
  const nv = mesh.vx.length;
  const ne = mesh.ea.length;
  const rng = mulberry32(seed);
  const cost = new Float64Array(ne);
  for (let e = 0; e < ne; e++) {
    const len = Math.hypot(mesh.vx[mesh.eb[e]] - mesh.vx[mesh.ea[e]], mesh.vy[mesh.eb[e]] - mesh.vy[mesh.ea[e]]);
    cost[e] = len * (1 + COST_SPREAD * (2 * rng() - 1));
  }
  const { off, adj } = adjacency(mesh, nv);
  const reach = new Float64Array(nv).fill(Infinity);
  const parent = new Int32Array(nv).fill(-1);
  const via = new Int32Array(nv).fill(-1);
  const owner = new Int32Array(nv).fill(-1);
  const done = new Uint8Array(nv);
  const order: number[] = [];
  const heap = new Heap();
  origins.forEach((v, k) => {
    if (v < 0 || v >= nv || owner[v] >= 0) return;
    reach[v] = 0;
    owner[v] = k;
    heap.push(v, 0);
  });
  while (heap.size) {
    const [v, d] = heap.pop();
    if (done[v] || d > reach[v]) continue;
    done[v] = 1;
    order.push(v);
    for (let i = off[v]; i < off[v + 1]; i++) {
      const e = adj[i];
      const u = mesh.ea[e] === v ? mesh.eb[e] : mesh.ea[e];
      const du = d + cost[e];
      if (du < reach[u]) {
        reach[u] = du;
        parent[u] = v;
        via[u] = e;
        owner[u] = owner[v];
        heap.push(u, du);
      }
    }
  }

  // Fusions: for each pair of touching trees, the cheapest meeting tubes, spaced apart.
  const meet = (e: number) => (reach[mesh.ea[e]] + reach[mesh.eb[e]] + cost[e]) / 2;
  const seams = new Map<string, number[]>();
  for (let e = 0; e < ne; e++) {
    if (!mesh.alive[e]) continue;
    const a = owner[mesh.ea[e]];
    const b = owner[mesh.eb[e]];
    if (a < 0 || b < 0 || a === b) continue;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let list = seams.get(key);
    if (!list) seams.set(key, (list = []));
    list.push(e);
  }
  const fuse: number[] = [];
  const mid = (e: number): [number, number] => [(mesh.vx[mesh.ea[e]] + mesh.vx[mesh.eb[e]]) / 2, (mesh.vy[mesh.ea[e]] + mesh.vy[mesh.eb[e]]) / 2];
  for (const list of seams.values()) {
    list.sort((p, q) => meet(p) - meet(q));
    const kept: number[] = [];
    for (const e of list) {
      if (kept.length >= FUSE_MAX) break;
      const [x, y] = mid(e);
      if (kept.every((k) => Math.hypot(mid(k)[0] - x, mid(k)[1] - y) >= FUSE_GAP)) kept.push(e);
    }
    fuse.push(...kept);
  }

  let end = 0;
  for (const v of order) end = Math.max(end, reach[v]);
  for (const e of fuse) end = Math.max(end, meet(e));

  // Smooth the drawn strands: a vertex with one parent and one child slides toward their mean.
  const children = new Int32Array(nv);
  for (const v of order) if (parent[v] >= 0) children[parent[v]]++;
  const isOrigin = new Uint8Array(nv);
  for (const v of origins) if (v >= 0 && v < nv) isOrigin[v] = 1;
  const child = new Int32Array(nv).fill(-1);
  for (const v of order) if (parent[v] >= 0) child[parent[v]] = v;
  const sx = Float32Array.from(mesh.vx as ArrayLike<number>);
  const sy = Float32Array.from(mesh.vy as ArrayLike<number>);
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    for (const v of order) {
      if (isOrigin[v] || children[v] !== 1 || parent[v] < 0) continue;
      const p = parent[v];
      const c = child[v];
      sx[v] = 0.5 * sx[v] + 0.25 * (sx[p] + sx[c]);
      sy[v] = 0.5 * sy[v] + 0.25 * (sy[p] + sy[c]);
    }
  }

  return { reach, parent, via, owner, fuse: Int32Array.from(fuse), order: Int32Array.from(order), cost, end, sx, sy };
}

export interface GrowthFrame {
  /** Per tube, how far it has grown from its `ea` end and from its `eb` end (0 to 1 each). */
  fromA: Float32Array;
  fromB: Float32Array;
  /** Per tube, its thickness in [0, 1]: how much of the tree it feeds. */
  weight: Float32Array;
}

/** Vertices a strand must feed to reach full thickness. */
const FULL_FEED = 120;

/** The growth at cost distance `tau`: how far each tube reaches and how thick it is. */
export function growthAt(g: Growth, mesh: Pick<GrowthMesh, 'ea' | 'eb'>, tau: number, out?: GrowthFrame): GrowthFrame {
  const ne = mesh.ea.length;
  const frame = out ?? { fromA: new Float32Array(ne), fromB: new Float32Array(ne), weight: new Float32Array(ne) };
  frame.fromA.fill(0);
  frame.fromB.fill(0);
  frame.weight.fill(0);
  // What each vertex feeds: itself once reached (in part while its tube is still growing), plus
  // everything below it.
  const feed = new Float32Array(g.reach.length);
  for (let i = g.order.length - 1; i >= 0; i--) {
    const v = g.order[i];
    const p = g.parent[v];
    if (p < 0) continue;
    const span = g.reach[v] - g.reach[p];
    const grown = span > 0 ? Math.min(1, Math.max(0, (tau - g.reach[p]) / span)) : tau >= g.reach[v] ? 1 : 0;
    if (grown <= 0) continue;
    feed[v] += grown;
    feed[p] += feed[v];
    const e = g.via[v];
    if (mesh.ea[e] === p) frame.fromA[e] = grown;
    else frame.fromB[e] = grown;
    frame.weight[e] = Math.min(1, Math.sqrt(feed[v] / FULL_FEED));
  }
  for (const e of g.fuse) {
    const c = g.cost[e];
    const a = Math.min(1, Math.max(0, (tau - g.reach[mesh.ea[e]]) / c));
    const b = Math.min(1, Math.max(0, (tau - g.reach[mesh.eb[e]]) / c));
    // The two ends grow toward each other and stop where they meet.
    const over = a + b - 1;
    frame.fromA[e] = over > 0 ? a - over / 2 : a;
    frame.fromB[e] = over > 0 ? b - over / 2 : b;
    frame.weight[e] = over >= 0 ? 0.35 : 0.2;
  }
  return frame;
}

/** Tubes the growth did not lay: the film, 1 per tube. */
export function filmTubes(g: Growth, edgeCount: number): Uint8Array {
  const film = new Uint8Array(edgeCount).fill(1);
  for (const v of g.order) if (g.via[v] >= 0) film[g.via[v]] = 0;
  for (const e of g.fuse) film[e] = 0;
  return film;
}

/** Every tube off the strands starts at this share of f(I₀), give or take a quarter: a thin film. */
export const FILM = 0.2;
/** Film draws only above this share of f(I₀): past where it started, so the flow chose it. */
export const FILM_SHOW = 0.3;
/**
 * Model time after which film still in the network is there on merit: unused film decays as
 * e^-t, below the network's threshold (NETWORK_SHARE of f(I₀), from FILM of it) by t ≈ 4.6.
 */
export const FILM_TRUST = 5;

/**
 * How thick each tube draws once the flow model runs, 0 to 1 (0 hides it): the square root of
 * its conductivity against f(I₀) (`full`). Tubes in the measured network show at least faintly,
 * but film only once it is trusted (`trusted`, after FILM_TRUST) or the flow has thickened it
 * past FILM_SHOW: at first the whole film counts as network, and the lattice must never show.
 */
export function flowWeights(
  D: ArrayLike<number>,
  full: number,
  film: ArrayLike<number> | null,
  inNet: ArrayLike<number>,
  trusted: boolean,
  out: Float32Array = new Float32Array(D.length),
): Float32Array {
  for (let e = 0; e < D.length; e++) {
    const r = D[e] / full;
    const w = r > 0 ? Math.min(1, Math.sqrt(r)) : 0;
    if (inNet[e]) out[e] = !film?.[e] || trusted ? Math.max(0.15, w) : r > FILM_SHOW ? w : 0;
    else out[e] = film?.[e] || w < 0.1 ? 0 : w;
  }
  return out;
}

/**
 * Drawing positions: `x`, `y` relaxed along the tubes that show (weight at least `min`), so a
 * chain of lattice tubes draws as a curve, not a zigzag. Junctions, dead ends and `pinned`
 * vertices hold still.
 */
export function smoothAlong(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  mesh: Pick<GrowthMesh, 'ea' | 'eb'>,
  weight: ArrayLike<number>,
  pinned: ArrayLike<number>,
  passes = 6,
  min = 0.15,
): { x: Float32Array; y: Float32Array } {
  const nv = x.length;
  const deg = new Int32Array(nv);
  const n1 = new Int32Array(nv).fill(-1);
  const n2 = new Int32Array(nv).fill(-1);
  for (let e = 0; e < mesh.ea.length; e++) {
    if (weight[e] < min) continue;
    const a = mesh.ea[e];
    const b = mesh.eb[e];
    if (deg[a]++ === 0) n1[a] = b;
    else n2[a] = b;
    if (deg[b]++ === 0) n1[b] = a;
    else n2[b] = a;
  }
  const sx = Float32Array.from(x);
  const sy = Float32Array.from(y);
  for (let pass = 0; pass < passes; pass++) {
    for (let v = 0; v < nv; v++) {
      if (deg[v] !== 2 || pinned[v]) continue;
      sx[v] = 0.5 * sx[v] + 0.25 * (sx[n1[v]] + sx[n2[v]]);
      sy[v] = 0.5 * sy[v] + 0.25 * (sy[n1[v]] + sy[n2[v]]);
    }
  }
  return { x: sx, y: sy };
}

/**
 * The flow model's starting conductivities: strands on the fresh mesh's scale (0.5 to 1) by how
 * much they feed, fused tubes 0.75, and every other alive tube a film around FILM × `full`.
 */
export function startConductivity(g: Growth, mesh: GrowthMesh, full: number, seed = 1, film = FILM): Float64Array {
  const ne = mesh.ea.length;
  const rng = mulberry32(seed);
  const D = new Float64Array(ne);
  const end = growthAt(g, mesh, g.end);
  for (let e = 0; e < ne; e++) D[e] = mesh.alive[e] ? film * full * (0.75 + 0.5 * rng()) : 0;
  for (const v of g.order) {
    const e = g.via[v];
    if (e >= 0) D[e] = 0.5 + 0.5 * end.weight[e];
  }
  for (const e of g.fuse) D[e] = 0.75;
  return D;
}
