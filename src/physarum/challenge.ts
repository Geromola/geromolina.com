/**
 * You vs the mold (SPEC "Physarum"): lay straight track between towns within a budget, then race
 * the mold on the same board and compare cost, travel and robustness. DOM-free.
 *
 * Track is foods plus the player's own junctions, joined by straight links that may not cross
 * light. A link can start or end on a food, on a junction, part-way along another link (which
 * splits it with a junction) or in open ground (a new junction). For scoring, dead-end spurs are
 * pruned and junctions with two links are contracted, as `extractNetwork` does for the mold, but
 * the cost counts every length built.
 */
import { mulberry32 } from '../energy/rounds';
import { dist, metrics, normalize, type Metrics, type Network, type Normalized } from './metrics';
import { mst } from './reference';
import { isLit, layout, type Pt, type Scene } from './scene';

export interface Level {
  id: string;
  title: string;
  blurb: string;
  /** Track allowed, as a multiple of the towns' minimum spanning tree. */
  budget: number;
  board: (width: number, height: number, maskW: number) => Scene;
}

/** Seeded towns over the landscape board, at least `gap` apart and clear of `avoid`. */
function towns(seed: number, n: number, gap: number, avoid: (p: Pt) => boolean = () => false): Pt[] {
  const rng = mulberry32(seed);
  const out: Pt[] = [];
  for (let tries = 0; out.length < n && tries < 20000; tries++) {
    const p: Pt = [0.06 + rng() * 0.88, 0.06 + rng() * 0.513];
    if (avoid(p) || out.some((q) => dist(p[0], p[1], q[0], q[1]) < gap)) continue;
    out.push([Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]);
  }
  return out;
}

const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 40): Pt[] =>
  Array.from({ length: n }, (_, k) => [cx + rx * Math.cos((2 * Math.PI * k) / n), cy + ry * Math.sin((2 * Math.PI * k) / n)] as const);

const LAKE = { cx: 0.5, cy: 0.3125, rx: 0.2, ry: 0.13 };
const inLake = ([x, y]: Pt, pad: number) => ((x - LAKE.cx) / (LAKE.rx + pad)) ** 2 + ((y - LAKE.cy) / (LAKE.ry + pad)) ** 2 < 1;
/** The ridge: a lit band down the middle with one pass, low down. */
const RIDGE = [
  [0.46, 0, 0.54, 0.4],
  [0.46, 0.5, 0.54, 0.625],
] as const;
const onRidge = ([x]: Pt) => x > 0.4 && x < 0.6;

export const LEVELS: readonly Level[] = [
  {
    id: 'five',
    title: 'Five towns',
    blurb: 'Join five towns. The shortest tree is cheap, but one broken link cuts a town off.',
    budget: 1.6,
    board: (w, h, m) => layout(w, h, m, towns(11, 5, 0.22)),
  },
  {
    id: 'lake',
    title: 'Round the lake',
    blurb: 'A lake in the middle. Track can’t cross it, and neither can the mold.',
    budget: 1.6,
    board: (w, h, m) => layout(w, h, m, towns(4, 8, 0.15, (p) => inLake(p, 0.05)), [], [ellipse(LAKE.cx, LAKE.cy, LAKE.rx, LAKE.ry)]),
  },
  {
    id: 'nine',
    title: 'Nine towns',
    blurb: 'Junctions between towns cut cost. Drag into open ground to make one.',
    budget: 1.7,
    board: (w, h, m) => layout(w, h, m, towns(23, 9, 0.15)),
  },
  {
    id: 'pass',
    title: 'The pass',
    blurb: 'Mountains down the middle with one pass. Everything east to west goes through it, or nothing does.',
    budget: 1.6,
    board: (w, h, m) => layout(w, h, m, towns(8, 10, 0.14, onRidge), RIDGE),
  },
  {
    id: 'twelve',
    title: 'Twelve towns',
    blurb: 'A bigger map. Beat the mold on all three if you can.',
    budget: 1.5,
    board: (w, h, m) => layout(w, h, m, towns(31, 12, 0.13)),
  },
];

export const levelIndex = (id: string | null | undefined): number => Math.max(0, LEVELS.findIndex((l) => l.id === id));

// ------------------------------------------------------------ track

/** Junctions are nodes foods.length + i. */
export interface Track {
  junctions: { x: number; y: number }[];
  links: [number, number][];
}

export const emptyTrack = (): Track => ({ junctions: [], links: [] });

export function nodeAt(scene: Scene, t: Track, i: number): { x: number; y: number } {
  return i < scene.foods.length ? scene.foods[i] : t.junctions[i - scene.foods.length];
}

export function linkLength(scene: Scene, t: Track, [a, b]: [number, number]): number {
  const p = nodeAt(scene, t, a), q = nodeAt(scene, t, b);
  return dist(p.x, p.y, q.x, q.y);
}

/** Every length built. */
export function builtLength(scene: Scene, t: Track): number {
  let s = 0;
  for (const l of t.links) s += linkLength(scene, t, l);
  return s;
}

/** Whether the straight segment passes over light. */
export function crossesLight(scene: Scene, ax: number, ay: number, bx: number, by: number): boolean {
  const n = Math.max(1, Math.ceil(dist(ax, ay, bx, by) / 0.003));
  for (let k = 0; k <= n; k++) if (isLit(scene, ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n)) return true;
  return false;
}

/** Where a drag starts or ends: a node, a point along a link, or open ground. */
export type End = { kind: 'node'; i: number } | { kind: 'link'; li: number; x: number; y: number } | { kind: 'open'; x: number; y: number };

/** The node within `hit` of p, else the link within `hit`, else open ground. */
export function endAt(scene: Scene, t: Track, x: number, y: number, hit: number): End {
  let best = -1, bestD = hit;
  const n = scene.foods.length + t.junctions.length;
  for (let i = 0; i < n; i++) {
    const p = nodeAt(scene, t, i);
    const d = dist(p.x, p.y, x, y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best >= 0) return { kind: 'node', i: best };
  let li = -1, lp = { x, y };
  bestD = hit;
  t.links.forEach(([a, b], k) => {
    const p = nodeAt(scene, t, a), q = nodeAt(scene, t, b);
    const dx = q.x - p.x, dy = q.y - p.y;
    const u = Math.max(0, Math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / (dx * dx + dy * dy || 1)));
    const c = { x: p.x + u * dx, y: p.y + u * dy };
    const d = dist(c.x, c.y, x, y);
    if (d < bestD) {
      bestD = d;
      li = k;
      lp = c;
    }
  });
  if (li >= 0) return { kind: 'link', li, ...lp };
  return { kind: 'open', x, y };
}

/** The end's position. */
export function endPoint(scene: Scene, t: Track, e: End): { x: number; y: number } {
  return e.kind === 'node' ? nodeAt(scene, t, e.i) : { x: e.x, y: e.y };
}

export type BuildError = 'light' | 'budget' | 'short';

/**
 * Lays a link from a to b (ends found in `t`), splitting links and adding junctions as needed.
 * Returns the new track, or why it can't be built (over light, over budget, or too short).
 */
export function build(scene: Scene, t: Track, a: End, b: End, budget: number, minLength = 0.015): Track | BuildError {
  const pa = endPoint(scene, t, a), pb = endPoint(scene, t, b);
  if (a.kind === 'node' && b.kind === 'node' && a.i === b.i) return 'short';
  if (dist(pa.x, pa.y, pb.x, pb.y) < minLength) return 'short';
  if (crossesLight(scene, pa.x, pa.y, pb.x, pb.y)) return 'light';
  const next: Track = { junctions: t.junctions.map((j) => ({ ...j })), links: t.links.map((l) => [l[0], l[1]]) };
  const F = scene.foods.length;
  // Splitting both ends of one link: split at b first would shift a's link index, so resolve in order.
  const place = (e: End): number => {
    if (e.kind === 'node') return e.i;
    next.junctions.push({ x: e.x, y: e.y });
    const j = F + next.junctions.length - 1;
    if (e.kind === 'link') {
      const [u, v] = next.links[e.li];
      next.links[e.li] = [u, j];
      next.links.push([j, v]);
    }
    return j;
  };
  let bb = b;
  if (a.kind === 'link' && b.kind === 'link' && a.li === b.li) {
    // Both on one link: after splitting at a, b lies on whichever half holds it.
    const ia = place(a);
    const [u] = next.links[a.li];
    const pu = nodeAt(scene, next, u);
    const half = dist(pu.x, pu.y, b.x, b.y) < dist(pu.x, pu.y, pa.x, pa.y) ? a.li : next.links.length - 1;
    bb = { kind: 'link', li: half, x: b.x, y: b.y };
    const ib = place(bb);
    next.links.push([ia, ib]);
  } else {
    const ia = place(a);
    const ib = place(bb);
    if (ia === ib) return 'short';
    if (!next.links.some(([u, v]) => (u === ia && v === ib) || (u === ib && v === ia))) next.links.push([ia, ib]);
  }
  if (builtLength(scene, next) > budget + 1e-9) return 'budget';
  return next;
}

/**
 * Removes the junction within `hit` with its links, else the link within `hit`; null if neither.
 * A junction on a straight line (where track branched off it) loses only its branches, and the
 * line is whole again.
 */
export function erase(scene: Scene, t: Track, x: number, y: number, hit: number): Track | null {
  const F = scene.foods.length;
  const e = endAt(scene, t, x, y, hit);
  let links = t.links;
  if (e.kind === 'node' && e.i >= F) {
    const pair = straightThrough(scene, t, e.i);
    links = links.filter(([u, v]) => u !== e.i && v !== e.i);
    if (pair) links = [...links, pair];
  } else if (e.kind === 'link' || e.kind === 'node') {
    // A food can't be erased; a press on one takes the nearest link out of it.
    const li = e.kind === 'link' ? e.li : nearestLinkAt(scene, t, e.i, x, y);
    if (li < 0) return null;
    links = links.filter((_, k) => k !== li);
  } else return null;
  return tidy(scene, { junctions: t.junctions, links });
}

function nearestLinkAt(scene: Scene, t: Track, node: number, x: number, y: number): number {
  let best = -1, bestD = Infinity;
  t.links.forEach(([u, v], k) => {
    if (u !== node && v !== node) return;
    const o = nodeAt(scene, t, u === node ? v : u);
    const d = dist(o.x, o.y, x, y);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  });
  return best;
}

/** The two ends of a straight line through junction j (its links on opposite sides), if any. */
function straightThrough(scene: Scene, t: Track, j: number): [number, number] | null {
  const p = nodeAt(scene, t, j);
  const others = t.links.flatMap(([u, v]) => (u === j ? [v] : v === j ? [u] : []));
  for (let a = 0; a < others.length; a++) {
    for (let b = a + 1; b < others.length; b++) {
      const qa = nodeAt(scene, t, others[a]), qb = nodeAt(scene, t, others[b]);
      const ax = qa.x - p.x, ay = qa.y - p.y, bx = qb.x - p.x, by = qb.y - p.y;
      const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
      if (cos < -0.9995) return [others[a], others[b]];
    }
  }
  return null;
}

/** Joins junctions left in the middle of a straight line, drops ones with no links, renumbers. */
function tidy(scene: Scene, t0: Track): Track {
  const F = scene.foods.length;
  let t = t0;
  for (let j = F; j < F + t.junctions.length; j++) {
    const mine = t.links.filter(([u, v]) => u === j || v === j);
    if (mine.length !== 2) continue;
    const pair = straightThrough(scene, t, j);
    if (pair) t = { junctions: t.junctions, links: [...t.links.filter(([u, v]) => u !== j && v !== j), pair] };
  }
  const deg = new Map<number, number>();
  for (const [u, v] of t.links) {
    deg.set(u, (deg.get(u) ?? 0) + 1);
    deg.set(v, (deg.get(v) ?? 0) + 1);
  }
  const map = new Map<number, number>();
  const junctions: Track['junctions'] = [];
  t.junctions.forEach((j, k) => {
    if (!deg.get(F + k)) return;
    map.set(F + k, F + junctions.length);
    junctions.push(j);
  });
  const at = (i: number) => (i < F ? i : map.get(i)!);
  return { junctions, links: t.links.map(([u, v]) => [at(u), at(v)]) };
}

/** The track as a network, every node and link as built. */
export function trackNetwork(scene: Scene, t: Track): Network {
  return {
    nodes: [...scene.foods.map((f, i) => ({ x: f.x, y: f.y, food: i })), ...t.junctions.map((j) => ({ x: j.x, y: j.y, food: -1 }))],
    links: t.links.map(([a, b]) => ({ a, b, length: linkLength(scene, t, [a, b]) })),
  };
}

/** Prunes dead-end junctions and contracts junctions with two links, keeping lengths. */
export function contract(net: Network): Network {
  const nodes = net.nodes.map((n) => ({ ...n }));
  let links = net.links.filter((l) => l.a !== l.b).map((l) => ({ ...l }));
  const alive = nodes.map(() => true);
  for (let changed = true; changed; ) {
    changed = false;
    const inc: number[][] = nodes.map(() => []);
    links.forEach((l, k) => {
      inc[l.a].push(k);
      inc[l.b].push(k);
    });
    for (let v = 0; v < nodes.length; v++) {
      if (!alive[v] || nodes[v].food >= 0) continue;
      const ls = inc[v];
      if (ls.length === 0) alive[v] = false;
      else if (ls.length === 1) {
        links = links.filter((_, k) => k !== ls[0]);
        alive[v] = false;
        changed = true;
        break;
      } else if (ls.length === 2) {
        const [p, q] = ls.map((k) => links[k]);
        const a = p.a === v ? p.b : p.a, b = q.a === v ? q.b : q.a;
        links = links.filter((_, k) => k !== ls[0] && k !== ls[1]);
        if (a !== b) links.push({ a, b, length: p.length + q.length });
        alive[v] = false;
        changed = true;
        break;
      }
    }
  }
  const map = new Map<number, number>();
  const kept = nodes.filter((_, i) => {
    if (!alive[i]) return false;
    map.set(i, map.size);
    return true;
  });
  return { nodes: kept, links: links.map((l) => ({ ...l, a: map.get(l.a)!, b: map.get(l.b)! })) };
}

/** The track's cost (every length built), travel and robustness, against the towns' MST. */
export function measure(scene: Scene, t: Track, ref: Metrics = metrics(mst(scene.foods))): Normalized {
  const m = metrics(contract(trackNetwork(scene, t)));
  return normalize({ ...m, tl: builtLength(scene, t) }, ref);
}

// ------------------------------------------------------------ the race

export type Outcome = 'win' | 'tie' | 'lose';
export type Verdict = 'beat' | 'lost' | 'tradeoff' | 'tie' | 'unfinished';

export interface Score {
  cost: Outcome;
  travel: Outcome;
  robust: Outcome;
  wins: number;
  losses: number;
  verdict: Verdict;
}

/** Within this share, cost and travel tie; robust ties within this many points. */
export const TIE_SHARE = 0.02;
export const TIE_FT = 0.02;

const lower = (a: number, b: number): Outcome => (Math.abs(a - b) <= TIE_SHARE * b ? 'tie' : a < b ? 'win' : 'lose');

/** Your track against the mold's network: lower cost and travel win, higher robust wins. */
export function score(you: Normalized, mold: Normalized): Score {
  if (!you.connected) return { cost: 'lose', travel: 'lose', robust: 'lose', wins: 0, losses: 3, verdict: 'unfinished' };
  const cost = lower(you.tlMst, mold.tlMst);
  const travel = lower(you.mdMst, mold.mdMst);
  const robust: Outcome = Math.abs(you.ft - mold.ft) <= TIE_FT ? 'tie' : you.ft > mold.ft ? 'win' : 'lose';
  const all = [cost, travel, robust];
  const wins = all.filter((o) => o === 'win').length;
  const losses = all.filter((o) => o === 'lose').length;
  const verdict: Verdict = wins && !losses ? 'beat' : losses && !wins ? 'lost' : wins ? 'tradeoff' : 'tie';
  return { cost, travel, robust, wins, losses, verdict };
}

// ------------------------------------------------------------ progress

/** Per level: the best result so far (wins − losses) and whether you have beaten the mold. */
export interface ChallengeProgress {
  at: string;
  best: Record<string, { margin: number; beat: boolean }>;
}

export function parseChallenge(text: string | null): ChallengeProgress {
  const fresh: ChallengeProgress = { at: LEVELS[0].id, best: {} };
  if (!text) return fresh;
  try {
    const c = (JSON.parse(text) as { challenge?: { at?: unknown; best?: unknown } })?.challenge;
    const ids = new Set(LEVELS.map((l) => l.id));
    const best: ChallengeProgress['best'] = {};
    if (c?.best && typeof c.best === 'object') {
      for (const [id, v] of Object.entries(c.best as Record<string, { margin?: unknown; beat?: unknown }>)) {
        if (ids.has(id) && typeof v?.margin === 'number' && Number.isFinite(v.margin)) best[id] = { margin: Math.max(-3, Math.min(3, Math.round(v.margin))), beat: v.beat === true };
      }
    }
    return { at: typeof c?.at === 'string' && ids.has(c.at) ? c.at : fresh.at, best };
  } catch {
    return fresh;
  }
}

/** Writes the challenge into the saved progress, keeping anything else stored there. */
export function serializeChallenge(p: ChallengeProgress, previous: string | null = null): string {
  let rest: Record<string, unknown> = {};
  try {
    const raw: unknown = previous ? JSON.parse(previous) : null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) rest = raw as Record<string, unknown>;
  } catch {
    // Unreadable: start over.
  }
  return JSON.stringify({ ...rest, challenge: { at: p.at, best: p.best } });
}

/** Keeps the better of a level's saved result and a new score. */
export function record(p: ChallengeProgress, level: string, s: Score): ChallengeProgress {
  if (s.verdict === 'unfinished') return p;
  const old = p.best[level];
  const margin = s.wins - s.losses;
  const beat = s.verdict === 'beat';
  if (old && old.margin >= margin && (old.beat || !beat)) return p;
  return { ...p, best: { ...p.best, [level]: { margin: Math.max(margin, old?.margin ?? -3), beat: beat || !!old?.beat } } };
}
