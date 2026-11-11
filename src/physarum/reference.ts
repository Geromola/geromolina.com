/**
 * Reference networks over a set of food points (SPEC "Physarum"), the yardsticks Tero et al.
 * measured the mold and the rail network against. DOM-free.
 * - `mst`: the minimum spanning tree, the cheapest network that joins every point using only
 *   straight links between them.
 * - `delaunay`: the Delaunay triangulation, the most connected planar one.
 * - `steinerTree`: an approximate Steiner tree. Extra junctions may be added, so it can be
 *   shorter than the MST. The exact problem is NP-hard; this heuristic inserts a Fermat point
 *   wherever two links meet at under 120°, then relaxes every junction (Weiszfeld), and keeps
 *   a change only when the tree gets shorter.
 */
import { dist, type Network } from './metrics';

export interface Point {
  x: number;
  y: number;
}

const straight = (pts: readonly Point[], edges: [number, number][]): Network => ({
  nodes: pts.map((p, i) => ({ x: p.x, y: p.y, food: i })),
  links: edges.map(([a, b]) => ({ a, b, length: dist(pts[a].x, pts[a].y, pts[b].x, pts[b].y) })),
});

/** Prim's algorithm on the complete Euclidean graph. */
export function mstEdges(pts: readonly Point[]): [number, number][] {
  const n = pts.length;
  if (n < 2) return [];
  const inTree = new Uint8Array(n);
  const best = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const edges: [number, number][] = [];
  best[0] = 0;
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
    inTree[u] = 1;
    if (from[u] >= 0) edges.push([from[u], u]);
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue;
      const d = dist(pts[u].x, pts[u].y, pts[v].x, pts[v].y);
      if (d < best[v]) {
        best[v] = d;
        from[v] = u;
      }
    }
  }
  return edges;
}

export const mst = (pts: readonly Point[]): Network => straight(pts, mstEdges(pts));

/** Bowyer–Watson. Fine for the few dozen points a scene holds. */
export function delaunayEdges(pts: readonly Point[]): [number, number][] {
  const n = pts.length;
  if (n < 2) return [];
  if (n === 2) return [[0, 1]];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-9);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // The super triangle's corners are indices n, n + 1 and n + 2.
  const P = [...pts, { x: cx - 20 * span, y: cy - span }, { x: cx, y: cy + 20 * span }, { x: cx + 20 * span, y: cy - span }];
  type Tri = { a: number; b: number; c: number; ux: number; uy: number; r2: number };
  const tri = (a: number, b: number, c: number): Tri => {
    const [A, B, C] = [P[a], P[b], P[c]];
    const d = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
    const a2 = A.x * A.x + A.y * A.y, b2 = B.x * B.x + B.y * B.y, c2 = C.x * C.x + C.y * C.y;
    const ux = (a2 * (B.y - C.y) + b2 * (C.y - A.y) + c2 * (A.y - B.y)) / d;
    const uy = (a2 * (C.x - B.x) + b2 * (A.x - C.x) + c2 * (B.x - A.x)) / d;
    return { a, b, c, ux, uy, r2: (A.x - ux) ** 2 + (A.y - uy) ** 2 };
  };
  let tris: Tri[] = [tri(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const p = P[i];
    const bad = tris.filter((t) => (p.x - t.ux) ** 2 + (p.y - t.uy) ** 2 <= t.r2 * (1 + 1e-9));
    const edgeCount = new Map<string, [number, number, number]>();
    for (const t of bad) {
      for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        const e = edgeCount.get(key);
        if (e) e[2]++;
        else edgeCount.set(key, [u, v, 1]);
      }
    }
    tris = tris.filter((t) => !bad.includes(t));
    for (const [u, v, count] of edgeCount.values()) if (count === 1) tris.push(tri(u, v, i));
  }
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  for (const t of tris) {
    for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
      if (u >= n || v >= n) continue;
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(u < v ? [u, v] : [v, u]);
      }
    }
  }
  return edges;
}

export const delaunay = (pts: readonly Point[]): Network => straight(pts, delaunayEdges(pts));

/** Geometric median of a few points (Weiszfeld), starting from (x, y). */
function median(pts: readonly Point[], x: number, y: number, iters = 60): Point {
  for (let k = 0; k < iters; k++) {
    let sx = 0, sy = 0, sw = 0;
    for (const p of pts) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 1e-12) return { x: p.x, y: p.y };
      sx += p.x / d; sy += p.y / d; sw += 1 / d;
    }
    x = sx / sw;
    y = sy / sw;
  }
  return { x, y };
}

export function steinerTree(pts: readonly Point[]): Network {
  const nodes: Point[] = pts.map((p) => ({ x: p.x, y: p.y }));
  const adj: Set<number>[] = nodes.map(() => new Set());
  for (const [a, b] of mstEdges(pts)) {
    adj[a].add(b);
    adj[b].add(a);
  }
  const len = (a: number, b: number) => dist(nodes[a].x, nodes[a].y, nodes[b].x, nodes[b].y);
  const relax = () => {
    for (let sweep = 0; sweep < 30; sweep++) {
      for (let s = pts.length; s < nodes.length; s++) {
        const nb = [...adj[s]].map((i) => nodes[i]);
        nodes[s] = median(nb, nodes[s].x, nodes[s].y, 4);
      }
    }
  };
  const minAngle = (2 * Math.PI) / 3 - 1e-3;
  for (let round = 0; round < pts.length * 4; round++) {
    let best: { v: number; u: number; w: number; s: Point; gain: number } | null = null;
    for (let v = 0; v < nodes.length; v++) {
      const nb = [...adj[v]];
      for (let i = 0; i < nb.length; i++) {
        for (let j = i + 1; j < nb.length; j++) {
          const [u, w] = [nb[i], nb[j]];
          const ax = nodes[u].x - nodes[v].x, ay = nodes[u].y - nodes[v].y;
          const bx = nodes[w].x - nodes[v].x, by = nodes[w].y - nodes[v].y;
          const angle = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by)))));
          if (!(angle < minAngle)) continue;
          const tri = [nodes[v], nodes[u], nodes[w]];
          const s = median(tri, (tri[0].x + tri[1].x + tri[2].x) / 3, (tri[0].y + tri[1].y + tri[2].y) / 3);
          const after = tri.reduce((sum, p) => sum + dist(p.x, p.y, s.x, s.y), 0);
          const gain = len(v, u) + len(v, w) - after;
          if (gain > 1e-9 && (!best || gain > best.gain)) best = { v, u, w, s, gain };
        }
      }
    }
    if (!best) break;
    const { v, u, w, s } = best;
    const si = nodes.length;
    nodes.push(s);
    adj.push(new Set([v, u, w]));
    adj[v].delete(u); adj[v].delete(w); adj[u].delete(v); adj[w].delete(v);
    adj[v].add(si); adj[u].add(si); adj[w].add(si);
    relax();
  }
  const links: Network['links'] = [];
  for (let a = 0; a < nodes.length; a++) for (const b of adj[a]) if (a < b) links.push({ a, b, length: len(a, b) });
  return { nodes: nodes.map((p, i) => ({ x: p.x, y: p.y, food: i < pts.length ? i : -1 })), links };
}
