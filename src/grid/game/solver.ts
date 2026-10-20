import { inBounds, type Board, type Bounds } from './board';
import { LIT_THRESHOLD } from './physics';
import { bestPlant, costTable } from './routing';

/**
 * Placement solver (SPEC "Solver"): greedy, then 1-swap local search, over the
 * non-node vertices within Manhattan distance 1 of active plants and loads.
 * Its result is the "best" efficiency the stars are measured against.
 */

export interface Problem {
  board: Board;
  faulted: Uint8Array;
  /** Active plant vertices. */
  plants: readonly number[];
  /** Target load vertices. */
  loads: readonly number[];
  budget: number;
  /** Vertices a transformer may go on. */
  candidates: readonly number[];
}

export interface Score {
  /** Mean load efficiency. */
  efficiency: number;
  perLoad: number[];
  lit: number;
  won: boolean;
}

export interface Solution extends Score {
  /** Transformer vertices. */
  placement: number[];
}

/** Non-node, in-bounds vertices within Manhattan distance 1 of the given nodes. */
export function candidatesFor(board: Board, bounds: Bounds, nodeVerts: ReadonlySet<number>, around: readonly number[]): number[] {
  const out = new Set<number>();
  for (const v of around) {
    const c = board.col(v);
    const r = board.row(v);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc;
      const nr = r + dr;
      if (!board.inLattice(nc, nr) || !inBounds(bounds, nc, nr)) continue;
      const nv = board.vertex(nc, nr);
      if (!nodeVerts.has(nv)) out.add(nv);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Efficiency and lit count for a transformer mask. */
export function scoreMask(p: Problem, isT: Uint8Array, table?: Float64Array): Score {
  const t = table ?? new Float64Array(p.board.V * 2);
  const perLoad: number[] = [];
  let sum = 0;
  let lit = 0;
  for (const load of p.loads) {
    costTable(p.board, isT, p.faulted, load, t);
    const { efficiency } = bestPlant(t, p.plants);
    perLoad.push(efficiency);
    sum += efficiency;
    if (efficiency >= LIT_THRESHOLD) lit++;
  }
  const efficiency = p.loads.length ? sum / p.loads.length : 0;
  return { efficiency, perLoad, lit, won: p.loads.length > 0 && lit === p.loads.length };
}

/** Lexicographic: more lit loads first, then higher efficiency. */
const rank = (s: Score) => s.lit * 2 + s.efficiency;
const EPS = 1e-12;

export function solve(p: Problem): Solution {
  const isT = new Uint8Array(p.board.V);
  const table = new Float64Array(p.board.V * 2);
  const cands = p.candidates;
  const placed: number[] = [];
  const evalNow = () => scoreMask(p, isT, table);
  let cur = evalNow();

  // A useful pair is a step-up by a plant plus a step-down by a load.
  const nearPlant = cands.filter((c) => p.plants.some((v) => manhattan(p.board, c, v) <= 1));
  const nearLoad = cands.filter((c) => p.loads.some((v) => manhattan(p.board, c, v) <= 1));

  // Greedy: best single addition; when no single helps (a lone transformer
  // can't, since a path needs an even number of flips), try the best pair.
  while (placed.length < p.budget) {
    let best = rank(cur);
    let pick: number[] | null = null;
    let pickScore = cur;
    for (const c of cands) {
      if (isT[c]) continue;
      isT[c] = 1;
      const s = evalNow();
      isT[c] = 0;
      if (rank(s) > best + EPS) {
        best = rank(s);
        pick = [c];
        pickScore = s;
      }
    }
    if (!pick && placed.length + 2 <= p.budget) {
      for (const a of nearPlant) {
        if (isT[a]) continue;
        isT[a] = 1;
        for (const b of nearLoad) {
          if (isT[b]) continue;
          isT[b] = 1;
          const s = evalNow();
          isT[b] = 0;
          if (rank(s) > best + EPS) {
            best = rank(s);
            pick = [a, b];
            pickScore = s;
          }
        }
        isT[a] = 0;
      }
    }
    if (!pick) break;
    for (const v of pick) {
      isT[v] = 1;
      placed.push(v);
    }
    cur = pickScore;
  }

  // 1-swap local search: move one transformer to another candidate while it helps.
  for (let improved = true; improved; ) {
    improved = false;
    for (let i = 0; i < placed.length; i++) {
      const from = placed[i];
      let best = rank(cur);
      let to = -1;
      let toScore = cur;
      isT[from] = 0;
      for (const c of cands) {
        if (isT[c] || c === from) continue;
        isT[c] = 1;
        const s = evalNow();
        isT[c] = 0;
        if (rank(s) > best + EPS) {
          best = rank(s);
          to = c;
          toScore = s;
        }
      }
      if (to >= 0) {
        isT[to] = 1;
        placed[i] = to;
        cur = toScore;
        improved = true;
      } else {
        isT[from] = 1;
      }
    }
  }

  // Drop transformers that don't pull their weight (same lit count and efficiency).
  for (let i = placed.length - 1; i >= 0; i--) {
    isT[placed[i]] = 0;
    const s = evalNow();
    if (rank(s) >= rank(cur) - EPS) {
      placed.splice(i, 1);
      cur = s;
    } else {
      isT[placed[i]] = 1;
    }
  }

  return { ...cur, placement: placed.slice().sort((a, b) => a - b) };
}

function manhattan(board: Board, a: number, b: number) {
  return Math.abs(board.col(a) - board.col(b)) + Math.abs(board.row(a) - board.row(b));
}
