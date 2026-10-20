import { inBounds, type Board, type Bounds } from './board';

/**
 * Level definitions (SPEC "Levels"). The map is the same in every level; a
 * level only picks the active plants, the target loads, the budget and faults.
 */

export interface LevelDef {
  title: string;
  /** Node ids of the active plants. */
  plants: string[];
  /** Node ids of the target loads. */
  loads: string[];
  /** Transformers available (≤ 4). */
  budget: number;
  /** Seeded storm damage; regenerated with seed + 1, + 2, … until solvable. */
  faults?: { fraction: number; seed: number };
}

export const LEVELS: readonly LevelDef[] = [
  { title: 'First light', plants: ['custom-llm'], loads: ['about'], budget: 2 },
  { title: 'Two towns', plants: ['custom-llm'], loads: ['about', 'off-the-grid'], budget: 3 },
  { title: 'Long haul', plants: ['spotify-insight'], loads: ['contact', 'about'], budget: 4 },
  {
    title: 'Storm damage',
    plants: ['custom-llm', 'spotify-insight'],
    loads: ['about', 'off-the-grid', 'contact', 'networking-tracker'],
    budget: 4,
    faults: { fraction: 0.12, seed: 0x5707 },
  },
];

/**
 * Cut about `fraction` of the visible edges (both ends in `bounds`), never an
 * edge incident to a node vertex. Deterministic per seed. Returns a per-edge mask.
 */
export function generateFaults(
  board: Board,
  bounds: Bounds,
  nodeVerts: ReadonlySet<number>,
  fraction: number,
  seed: number,
): Uint8Array {
  const mask = new Uint8Array(board.E);
  let visible = 0;
  const pool: number[] = [];
  for (let e = 0; e < board.E; e++) {
    const a = board.edgeA[e];
    const b = board.edgeB[e];
    if (!inBounds(bounds, board.col(a), board.row(a)) || !inBounds(bounds, board.col(b), board.row(b))) continue;
    visible++;
    if (!nodeVerts.has(a) && !nodeVerts.has(b)) pool.push(e);
  }
  const rand = mulberry32(seed);
  // Fisher–Yates, then take the first n.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
  }
  const n = Math.min(pool.length, Math.round(visible * fraction));
  for (let i = 0; i < n; i++) mask[pool[i]] = 1;
  return mask;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
