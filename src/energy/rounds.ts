/**
 * Ballpark rounds: a seeded scenario generator with a difficulty curve, plus the Leitner
 * scheduler that decides which items come back. Pure: state in, state out.
 */
import { ANCHORS, ITEMS, getItem, lineWh, type Anchor, type Item, type Line } from './catalog';
import { LEARNED_DECADES } from './scale';

export const ROUNDS_PER_RUN = 10;
/** Round index (0-based) that always holds a trap. */
export const TRAP_ROUND = 7;
/** An anchor is learned once it is guessed within ×2 this many times. */
export const ANCHOR_HITS_TO_LEARN = 2;
export const MAX_BOX = 5;

export interface Scenario {
  lines: Line[];
  /** Set when the round is an anchor question. */
  anchorId?: string;
  trap?: boolean;
}

export interface Progress {
  /** Leitner box per item id, 1 … 5 (missing = 1). */
  boxes: Record<string, number>;
  /** Times each anchor was guessed within ×2. */
  anchorHits: Record<string, number>;
  best: number;
  runs: number;
}

export function emptyProgress(): Progress {
  return { boxes: {}, anchorHits: {}, best: 0, runs: 0 };
}

export type Rng = () => number;

/** mulberry32: small, fast, deterministic per seed. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)];

function pickWeighted<T>(rng: Rng, list: readonly T[], weight: (t: T) => number): T {
  const total = list.reduce((s, t) => s + weight(t), 0);
  let r = rng() * total;
  for (const t of list) {
    r -= weight(t);
    if (r <= 0) return t;
  }
  return list[list.length - 1];
}

export function boxOf(progress: Progress, itemId: string): number {
  return progress.boxes[itemId] ?? 1;
}

/** Items you know come back less often: weight 1 / 2^box. */
export function itemWeight(progress: Progress, itemId: string): number {
  return 1 / 2 ** boxOf(progress, itemId);
}

export function isLearned(progress: Progress, anchorId: string): boolean {
  return (progress.anchorHits[anchorId] ?? 0) >= ANCHOR_HITS_TO_LEARN;
}

export function learnedAnchors(progress: Progress): Anchor[] {
  return ANCHORS.filter((a) => isLearned(progress, a.id));
}

/** A random realistic line for an item. */
export function randomLine(rng: Rng, item: Item): Line {
  if (item.kind === 'power') return { itemId: item.id, count: pick(rng, item.counts), hours: pick(rng, item.hours) };
  return { itemId: item.id, count: pick(rng, item.amounts) };
}

/** Lines in a combo stay within this many decades of each other, so none is trivially zero. */
const COMBO_SPREAD = 2.5;

function comboFits(lines: Line[]): boolean {
  const logs = lines.map((l) => Math.log10(lineWh(l)));
  return Math.max(...logs) - Math.min(...logs) <= COMBO_SPREAD;
}

function weightedItem(rng: Rng, progress: Progress, exclude: Set<string>, filter: (i: Item) => boolean = () => true): Item {
  const pool = ITEMS.filter((i) => !exclude.has(i.id) && filter(i));
  return pickWeighted(rng, pool, (i) => itemWeight(progress, i.id));
}

function combo(rng: Rng, progress: Progress, n: number, seed: Line[] = []): Line[] {
  for (let attempt = 0; attempt < 200; attempt++) {
    const lines = [...seed];
    const used = new Set(lines.map((l) => l.itemId));
    while (lines.length < n) {
      const item = weightedItem(rng, progress, used);
      used.add(item.id);
      lines.push(randomLine(rng, item));
    }
    if (comboFits(lines)) return lines;
  }
  // Fallback that always fits: small household items at their first presets.
  const filler = ['laptop', 'tv', 'led'].filter((id) => !seed.some((l) => l.itemId === id));
  return [...seed, ...filler.map((id) => randomLine(() => 0, getItem(id)))].slice(0, n);
}

/**
 * A trap: a high-power item for a short time next to a low-power item for a long time, where
 * the low-power one ends up using more energy. Teaches that energy is power × time.
 */
export function trapPair(rng: Rng): Line[] {
  const powers = ITEMS.filter((i) => i.kind === 'power');
  const hot = powers.filter((i) => i.watts >= 1000 && i.watts < 10_000);
  const cool = powers.filter((i) => i.watts <= 100);
  for (let attempt = 0; attempt < 200; attempt++) {
    const h = pick(rng, hot);
    const c = pick(rng, cool);
    if (h.kind !== 'power' || c.kind !== 'power') continue;
    const hl: Line = { itemId: h.id, count: 1, hours: Math.min(...h.hours) };
    const cl: Line = { itemId: c.id, count: pick(rng, c.counts), hours: pick(rng, c.hours) };
    const ratio = lineWh(cl) / lineWh(hl);
    if (ratio > 1.3 && ratio < 30) return [hl, cl];
  }
  return [
    { itemId: 'kettle', count: 1, hours: 5 / 60 },
    { itemId: 'laptop', count: 1, hours: 8 },
  ];
}

function shuffle<T>(rng: Rng, list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** How many lines a round has: 1 for rounds 1–3, 2 for 4–7, 3 for 8–10. */
export function linesForRound(round: number): number {
  return round < 3 ? 1 : round < 7 ? 2 : 3;
}

/**
 * The scenario for round `round` (0-based). Early rounds prefer anchors you haven't learned;
 * later rounds combine items picked by the Leitner weights; round 8 is a trap.
 */
export function makeScenario(rng: Rng, progress: Progress, round: number, recent: Set<string> = new Set()): Scenario {
  const n = linesForRound(round);
  if (n === 1) {
    const fresh = ANCHORS.filter((a) => !isLearned(progress, a.id) && !recent.has(a.line.itemId));
    if (fresh.length && rng() < 0.75) {
      const a = pick(rng, fresh);
      return { lines: [a.line], anchorId: a.id };
    }
    const item = weightedItem(rng, progress, recent);
    return { lines: [randomLine(rng, item)] };
  }
  if (round === TRAP_ROUND) {
    const pair = trapPair(rng);
    return { lines: shuffle(rng, combo(rng, progress, n, pair)), trap: true };
  }
  return { lines: combo(rng, progress, n) };
}

/** Total energy of a scenario, in Wh. */
export function scenarioWh(s: Scenario): number {
  return s.lines.reduce((sum, l) => sum + lineWh(l), 0);
}

/**
 * Update the boxes after a round. A hit (within ×2) moves every item up a box; a miss sends the
 * dominant item (largest share) back to box 1. Anchor hits count toward learning it.
 */
export function applyResult(progress: Progress, s: Scenario, e: number): Progress {
  const boxes = { ...progress.boxes };
  const anchorHits = { ...progress.anchorHits };
  const hit = e <= LEARNED_DECADES;
  if (hit) {
    for (const l of s.lines) boxes[l.itemId] = Math.min(MAX_BOX, (boxes[l.itemId] ?? 1) + 1);
    if (s.anchorId) anchorHits[s.anchorId] = (anchorHits[s.anchorId] ?? 0) + 1;
  } else {
    const dominant = s.lines.reduce((a, b) => (lineWh(b) > lineWh(a) ? b : a));
    boxes[dominant.itemId] = 1;
  }
  return { ...progress, boxes, anchorHits };
}
