/**
 * Network metrics from Tero et al. (2010), SPEC "Physarum". DOM-free.
 * - TL, cost: total length of the network.
 * - MD, transport efficiency: mean shortest distance through the network between food pairs.
 * - FT, fault tolerance: the chance that one random link failure does not cut off part of the
 *   network, i.e. 1 − bridges / links. A tree (the MST) scores 0.
 * TL and MD are compared through their ratio to the minimum spanning tree, as the paper does.
 */

export interface NetNode {
  x: number;
  y: number;
  /** Index of the food at this node, or -1 for a junction (a Steiner point). */
  food: number;
}

export interface NetLink {
  a: number;
  b: number;
  length: number;
  /** x, y pairs from node a to node b, when the link is not a straight segment. */
  path?: number[];
}

export interface Network {
  nodes: NetNode[];
  links: NetLink[];
}

export interface Metrics {
  tl: number;
  /** Infinity when some food pair is not connected. */
  md: number;
  ft: number;
  connected: boolean;
}

export interface Normalized extends Metrics {
  /** TL / TL of the MST: cost. */
  tlMst: number;
  /** MD / MD of the MST: under 1 is faster than the tree. */
  mdMst: number;
}

export const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay);

export function totalLength(net: Network): number {
  let s = 0;
  for (const l of net.links) s += l.length;
  return s;
}

/** Shortest distances from node `src` to every node (Dijkstra; networks here are small). */
export function distancesFrom(net: Network, src: number): Float64Array {
  const n = net.nodes.length;
  const adj = adjacency(net);
  const d = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  d[src] = 0;
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || d[i] < d[u])) u = i;
    if (u < 0 || d[u] === Infinity) break;
    done[u] = 1;
    for (const [v, li] of adj[u]) {
      const nd = d[u] + net.links[li].length;
      if (nd < d[v]) d[v] = nd;
    }
  }
  return d;
}

/** Mean shortest distance over all food pairs (Infinity if any pair is cut off). */
export function meanFoodDistance(net: Network): number {
  const foods = net.nodes.flatMap((n, i) => (n.food >= 0 ? [i] : []));
  if (foods.length < 2) return 0;
  let s = 0;
  let pairs = 0;
  for (let a = 0; a < foods.length; a++) {
    const d = distancesFrom(net, foods[a]);
    for (let b = a + 1; b < foods.length; b++) {
      s += d[foods[b]];
      pairs++;
    }
  }
  return s / pairs;
}

/** Number of links whose removal disconnects the network (Tarjan; self-loops never count). */
export function bridgeCount(net: Network): number {
  const n = net.nodes.length;
  const adj = adjacency(net);
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  let time = 0;
  let bridges = 0;
  const visit = (u: number, parentLink: number) => {
    disc[u] = low[u] = time++;
    for (const [v, li] of adj[u]) {
      if (li === parentLink) continue;
      if (disc[v] < 0) {
        visit(v, li);
        low[u] = Math.min(low[u], low[v]);
        if (low[v] > disc[u]) bridges++;
      } else low[u] = Math.min(low[u], disc[v]);
    }
  };
  for (let i = 0; i < n; i++) if (disc[i] < 0) visit(i, -1);
  return bridges;
}

export function faultTolerance(net: Network): number {
  if (net.links.length === 0) return 0;
  return 1 - bridgeCount(net) / net.links.length;
}

export function metrics(net: Network): Metrics {
  const md = meanFoodDistance(net);
  return { tl: totalLength(net), md, ft: faultTolerance(net), connected: md < Infinity };
}

/** Metrics with TL and MD as ratios to `mst` (the reference tree's own metrics). */
export function normalize(m: Metrics, mst: Metrics): Normalized {
  return { ...m, tlMst: mst.tl > 0 ? m.tl / mst.tl : 0, mdMst: mst.md > 0 ? m.md / mst.md : 0 };
}

/** Neighbour lists [node, link] per node; self-loops are left out (they never shorten a route). */
function adjacency(net: Network): [number, number][][] {
  const adj: [number, number][][] = net.nodes.map(() => []);
  net.links.forEach((l, i) => {
    if (l.a === l.b) return;
    adj[l.a].push([l.b, i]);
    adj[l.b].push([l.a, i]);
  });
  return adj;
}
