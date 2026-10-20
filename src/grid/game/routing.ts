import type { Board } from './board';
import { HIGH, LOW, SEG_COST, T_COST } from './physics';

/**
 * Routing on the state graph (vertex, level), SPEC "Routing".
 *
 * State index is `vertex * 2 + level`. Moving along a segment at level l costs
 * `SEG_COST[l]`; entering a transformer vertex flips the level and adds
 * `T_COST`. Faulted edges are skipped. A load vertex is absorbing: reaching it
 * at LOW delivers, reaching it at HIGH is an overvoltage (infinite cost).
 */

/** Shared scratch heap, sized on demand. Routing is single-threaded. */
let heapD = new Float64Array(0);
let heapS = new Int32Array(0);

/**
 * Backward Dijkstra from (load, LOW). Fills `out[v * 2 + l]` with the cost
 * (nats) of delivering from state (v, l) to the load; `Infinity` if impossible.
 * `isT[v]` is 1 where a transformer sits; `faulted[e]` is 1 for a cut edge.
 */
export function costTable(
  board: Board,
  isT: Uint8Array,
  faulted: Uint8Array,
  load: number,
  out: Float64Array = new Float64Array(board.V * 2),
): Float64Array {
  out.fill(Infinity);
  const cap = board.V * 2 * 4 + 1;
  if (heapD.length < cap) {
    heapD = new Float64Array(cap);
    heapS = new Int32Array(cap);
  }
  const hd = heapD;
  const hs = heapS;
  const { nbrV, nbrE } = board;
  const segLow = SEG_COST[LOW];
  const segHigh = SEG_COST[HIGH];

  let n = 0;
  out[load * 2 + LOW] = 0;
  hd[0] = 0;
  hs[0] = load * 2 + LOW;
  n = 1;

  while (n > 0) {
    // Pop min.
    const d = hd[0];
    const s = hs[0];
    n--;
    if (n > 0) {
      const ld = hd[n];
      const ls = hs[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && hd[c + 1] < hd[c]) c++;
        if (hd[c] >= ld) break;
        hd[i] = hd[c];
        hs[i] = hs[c];
        i = c;
      }
      hd[i] = ld;
      hs[i] = ls;
    }
    if (d > out[s]) continue;

    const v = s >> 1;
    const lv = s & 1; // level after entering v
    const t = isT[v] === 1;
    const lu = t ? 1 - lv : lv; // level while travelling the segment into v
    const step = (lu === LOW ? segLow : segHigh) + (t ? T_COST : 0);
    const nd = d + step;
    for (let k = 0; k < 4; k++) {
      const u = nbrV[v * 4 + k];
      if (u < 0) break;
      if (u === load || faulted[nbrE[v * 4 + k]] === 1) continue;
      const su = u * 2 + lu;
      if (nd < out[su]) {
        out[su] = nd;
        // Push.
        let i = n++;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (hd[p] <= nd) break;
          hd[i] = hd[p];
          hs[i] = hs[p];
          i = p;
        }
        hd[i] = nd;
        hs[i] = su;
      }
    }
  }
  return out;
}

export interface LoadRoute {
  /** Best plant vertex for this load, or −1 if no plant reaches it. */
  plant: number;
  /** exp(−cost) from the best plant; 0 if unreachable. */
  efficiency: number;
}

/** Best plant and its efficiency for a load, from that load's cost table. */
export function bestPlant(table: Float64Array, plants: readonly number[]): LoadRoute {
  let plant = -1;
  let cost = Infinity;
  for (const p of plants) {
    const c = table[p * 2 + LOW];
    if (c < cost) {
      cost = c;
      plant = p;
    }
  }
  return { plant, efficiency: plant >= 0 ? Math.exp(-cost) : 0 };
}
