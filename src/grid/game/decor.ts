import { computeLattice, type Lattice } from '../layout';
import { inBounds, type Board, type Bounds } from './board';
import type { GridGame } from './engine';
import { visibleBounds, type GameNode } from './layout';
import type { LevelDef } from './levels';
import { HIGH, LOW, SEG_COST, T_COST } from './physics';
import { bestPlant, costTable } from './routing';

/**
 * The decorative flow behind the projects hero (SPEC "Home hero v2"): each
 * project card's terminal dot becomes a lattice anchor, live cards are plants
 * and the others are loads. DOM-free; `main.ts` measures the dots.
 */

export interface DecorCard {
  id: string;
  live: boolean;
  /** Centre of the card's terminal dot, in map px. */
  x: number;
  y: number;
}

export interface DecorLayout {
  lattice: Lattice;
  /** One per card, in card order, each on its own vertex. */
  nodes: GameNode[];
  bounds: Bounds;
  /** The single decorative level, or null with fewer than two cards. */
  level: LevelDef | null;
}

const MIN_SPACING = 52;
const MAX_SPACING = 96;
const TOL_PX = 1;

/**
 * A lattice whose conductors run through the dots: the spacing is picked so
 * every distinct dot column sits on a vertical conductor (when the columns
 * allow it), and the origin is shifted so the first dot is exactly on a
 * vertex. The lattice still bleeds past every edge, as `computeLattice` does.
 */
export function decorLattice(width: number, height: number, dots: readonly { x: number; y: number }[]): Lattice {
  const base = computeLattice(width, height);
  if (!dots.length) return base;
  const xs: number[] = [];
  for (const x of [...dots.map((d) => d.x)].sort((a, b) => a - b)) {
    if (!xs.length || x - xs[xs.length - 1] > TOL_PX) xs.push(x);
  }
  let spacing = base.spacing;
  if (xs.length > 1) {
    let gap = Infinity;
    for (let k = 1; k < xs.length; k++) gap = Math.min(gap, xs[k] - xs[k - 1]);
    let best = 0;
    for (let n = 1; gap / n >= MIN_SPACING; n++) {
      const s = gap / n;
      if (s > MAX_SPACING) continue;
      const fits = xs.every((x) => {
        const d = (x - xs[0]) / s;
        return Math.abs(d - Math.round(d)) * s <= TOL_PX;
      });
      if (fits && (!best || Math.abs(s - base.spacing) < Math.abs(best - base.spacing))) best = s;
    }
    if (best) spacing = best;
  }
  const ox = dots[0].x - Math.ceil(dots[0].x / spacing) * spacing; // (−spacing, 0]
  const oy = dots[0].y - Math.ceil(dots[0].y / spacing) * spacing;
  return {
    spacing,
    ox,
    oy,
    cols: Math.ceil((width - ox) / spacing) + 1,
    rows: Math.ceil((height - oy) / spacing) + 1,
  };
}

/** Lattice, anchors (nearest free vertex to each dot, inside the visible area) and the level. */
export function layoutDecor(cards: readonly DecorCard[], width: number, height: number): DecorLayout {
  const lattice = decorLattice(width, height, cards);
  const bounds = visibleBounds(lattice, width, height);
  const taken = new Set<number>();
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const nodes = cards.map((card): GameNode => {
    const c0 = clamp(Math.round((card.x - lattice.ox) / lattice.spacing), bounds.minC, bounds.maxC);
    const r0 = clamp(Math.round((card.y - lattice.oy) / lattice.spacing), bounds.minR, bounds.maxR);
    // Nearest free vertex: itself, then rings outward (up first, toward the dot's outside).
    let col = c0;
    let row = r0;
    search: for (let d = 0; d < Math.max(lattice.cols, lattice.rows); d++) {
      for (const [dc, dr] of ring(d)) {
        const c = c0 + dc;
        const r = r0 + dr;
        if (c < bounds.minC || c > bounds.maxC || r < bounds.minR || r > bounds.maxR) continue;
        if (taken.has(r * lattice.cols + c)) continue;
        col = c;
        row = r;
        break search;
      }
    }
    taken.add(row * lattice.cols + col);
    return { id: card.id, kind: card.live ? 'plant' : 'section', col, row };
  });
  return { lattice, nodes, bounds, level: decorLevel(cards) };
}

/** Offsets at Chebyshev distance d, nearest first, rows above before rows below. */
function ring(d: number): [number, number][] {
  if (d === 0) return [[0, 0]];
  const out: [number, number][] = [];
  for (let dr = -d; dr <= d; dr++) {
    for (let dc = -d; dc <= d; dc++) if (Math.max(Math.abs(dc), Math.abs(dr)) === d) out.push([dc, dr]);
  }
  return out.sort((a, b) => Math.hypot(...a) - Math.hypot(...b) || a[1] - b[1]);
}

/**
 * Live cards are plants, the rest are loads. With no live card the first card
 * is the plant; with no other card the first live one stays a plant and the
 * other live ones become loads. Null with fewer than two cards.
 */
export function decorLevel(cards: readonly Pick<DecorCard, 'id' | 'live'>[]): LevelDef | null {
  if (cards.length < 2) return null;
  let plants = cards.filter((c) => c.live).map((c) => c.id);
  let loads = cards.filter((c) => !c.live).map((c) => c.id);
  if (!plants.length) {
    plants = [loads[0]];
    loads = loads.slice(1);
  } else if (!loads.length) {
    loads = plants.slice(1);
    plants = [plants[0]];
  }
  return { title: 'Projects', plants, loads, budget: 0 };
}

// ------------------------------------------------------------ node menu
/*
 * The node menu (SPEC "Home hero v3"): the projects are grid nodes in tidy
 * rows. CSS lays the rows out; `snapMenu` picks a lattice and the small
 * nudges that put every glyph on a vertex. The flow then runs along
 * solved-looking corridors: `corridorTransformers` places hidden step-ups and
 * step-downs (one per node) and `corridorPaths` traces each load's route, so
 * the hero can draw the lit corridors and stagger the power-on by distance.
 */

export interface MenuPoint {
  /** Glyph centre in map px, before snapping. */
  x: number;
  y: number;
}

export interface MenuSnapOptions {
  /** A conductor runs through this x (the menu's centre line, or the phone spine). */
  anchorX: number;
  /** Fixed spacing (px). Without it the spacing that needs the smallest nudges wins. */
  spacing?: number;
  /** Search range for the spacing and the size it leans toward. */
  min?: number;
  max?: number;
  prefer?: number;
}

export interface MenuSnap {
  spacing: number;
  /** Pixel position of vertex (0, 0): the lattice bleeds past the top-left edge. */
  ox: number;
  oy: number;
  /**
   * Per point: `dx` is a horizontal nudge (px, either way, at most half a
   * spacing) and `dy` an extra top margin (px, ≥ 0) for its line. Margins push
   * everything below down, so `dy` is a line's own shift, not a running total.
   * `col`/`row` is the vertex the glyph ends on.
   */
  snaps: { dx: number; dy: number; col: number; row: number }[];
  /** Sum of every line's `dy`: how much taller the menu gets. */
  grow: number;
}

const LINE_TOL = 2; // px: glyph centres this close in y share a line

/**
 * Snap menu glyphs to lattice vertices. Lines (points sharing a y) keep their
 * order and land on distinct lattice rows: each one moves down to the next
 * row at or below it. Within a line, glyphs snap to the nearest column
 * through `anchorX`, so a centred row stays symmetric. A spacing that would
 * put two glyphs of a line on one vertex is never picked.
 */
export function snapMenu(points: readonly MenuPoint[], opts: MenuSnapOptions): MenuSnap {
  const min = opts.min ?? 56;
  const max = opts.max ?? 76;
  const prefer = opts.prefer ?? (min + max) / 2;
  const order = points.map((_, i) => i).sort((a, b) => points[a].y - points[b].y || points[a].x - points[b].x);
  const lines: number[][] = [];
  for (const i of order) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(points[i].y - points[line[0]].y) <= LINE_TOL) line.push(i);
    else lines.push([i]);
  }
  const colOf = (x: number, s: number) => Math.round((x - opts.anchorX) / s);
  const clash = (s: number) =>
    lines.some((line) => new Set(line.map((i) => colOf(points[i].x, s))).size !== line.length);

  let spacing = opts.spacing ?? 0;
  if (!spacing) {
    let best = Infinity;
    for (let s = min; s <= max + 1e-9; s += 0.5) {
      if (clash(s)) continue;
      let cost = 0;
      for (const p of points) {
        const r = p.x - opts.anchorX - colOf(p.x, s) * s;
        cost += r * r;
      }
      // Lean toward the preferred size when the fit is equally good.
      cost += 0.05 * points.length * (s - prefer) ** 2;
      if (cost < best) {
        best = cost;
        spacing = s;
      }
    }
    if (!spacing) spacing = min;
  }

  const s = spacing;
  const y0 = points.length ? points[order[0]].y : 0;
  const ox = opts.anchorX - Math.ceil(opts.anchorX / s) * s; // (−s, 0]
  const oy = y0 - Math.ceil(y0 / s) * s;
  const snaps = points.map(() => ({ dx: 0, dy: 0, col: 0, row: 0 }));
  let carry = 0;
  for (const line of lines) {
    const y = points[line[0]].y + carry;
    const row = Math.ceil((y - oy) / s - 1e-6);
    const dy = Math.max(0, oy + row * s - y);
    carry += dy;
    for (const i of line) {
      const c = colOf(points[i].x, s);
      const col = Math.round((opts.anchorX - ox) / s) + c;
      snaps[i] = { dx: opts.anchorX + c * s - points[i].x, dy, col, row };
    }
  }
  return { spacing: s, ox, oy, snaps, grow: carry };
}

/** The menu lattice for a map size, from a snap's spacing and origin (bleeds past every edge). */
export function menuLattice(snap: Pick<MenuSnap, 'spacing' | 'ox' | 'oy'>, width: number, height: number): Lattice {
  const { spacing, ox, oy } = snap;
  return {
    spacing,
    ox,
    oy,
    cols: Math.ceil((width - ox) / spacing) + 1,
    rows: Math.ceil((height - oy) / spacing) + 1,
  };
}

/**
 * Hidden transformers that make the decorative board look solved: a step-up
 * beside every plant (on the side facing the loads) and a step-down beside
 * every load (the neighbour that delivers best; ties go to a spot no other
 * corridor already runs through). Loads are placed nearest-first, then each
 * step-down is re-checked once with the others in place. Returns vertices.
 */
export function corridorTransformers(
  board: Board,
  bounds: Bounds,
  nodeVerts: ReadonlySet<number>,
  plants: readonly number[],
  loads: readonly number[],
  faulted: Uint8Array = new Uint8Array(board.E),
): number[] {
  const isT = new Uint8Array(board.V);
  const table = new Float64Array(board.V * 2);
  const dist = (a: number, b: number) => Math.abs(board.col(a) - board.col(b)) + Math.abs(board.row(a) - board.row(b));
  const free = (v: number) => {
    const out: number[] = [];
    // Below, right, left, above: the menu's loads sit below its plants.
    for (const [dc, dr] of [[0, 1], [1, 0], [-1, 0], [0, -1]]) {
      const c = board.col(v) + dc;
      const r = board.row(v) + dr;
      if (!board.inLattice(c, r) || !inBounds(bounds, c, r)) continue;
      const n = board.vertex(c, r);
      if (!nodeVerts.has(n) && !isT[n]) out.push(n);
    }
    return out;
  };

  for (const p of plants) {
    let pick = -1;
    let best = Infinity;
    for (const c of free(p)) {
      const d = loads.reduce((sum, l) => sum + dist(c, l), 0);
      if (d < best - 1e-9) {
        best = d;
        pick = c;
      }
    }
    if (pick >= 0) isT[pick] = 1;
  }

  const near = (l: number) => Math.min(...plants.map((p) => dist(p, l)));
  const queue = [...loads].sort((a, b) => near(a) - near(b));
  const at = new Map<number, number>(); // load → its step-down
  const onPaths = (skip: number) => {
    const used = new Set<number>();
    for (const l of at.keys()) {
      if (l === skip) continue;
      costTable(board, isT, faulted, l, table);
      const plant = bestPlant(table, plants).plant;
      if (plant >= 0) for (const v of tracePath(board, isT, faulted, table, plant, l).verts) used.add(v);
    }
    return used;
  };
  const place = (l: number) => {
    const prev = at.get(l);
    if (prev !== undefined) isT[prev] = 0;
    const used = onPaths(l);
    let pick = -1;
    let best = -Infinity;
    for (const c of prev !== undefined ? [prev, ...free(l)] : free(l)) {
      isT[c] = 1;
      costTable(board, isT, faulted, l, table);
      isT[c] = 0;
      const score = bestPlant(table, plants).efficiency - (used.has(c) ? 0.01 : 0);
      if (score > best + 1e-12) {
        best = score;
        pick = c;
      }
    }
    if (pick >= 0) {
      isT[pick] = 1;
      at.set(l, pick);
    } else at.delete(l);
  };
  for (const l of queue) place(l);
  for (const l of queue) place(l);

  const out: number[] = [];
  for (let v = 0; v < board.V; v++) if (isT[v]) out.push(v);
  return out;
}

export interface CorridorStep {
  edge: number;
  /** Travelled at 345 kV (white-hot) or 13.8 kV (cyan). */
  high: boolean;
}

export interface CorridorPath {
  /** Node index of the load. */
  load: number;
  /** Node index of the plant that feeds it, or −1 when it can't be reached. */
  plant: number;
  /** Edges from the plant to the load, in order. */
  steps: CorridorStep[];
}

/**
 * The route each active load is fed along: from its best plant, greedily down
 * the load's cost table (the way the electrons lean, at zero temperature).
 */
export function corridorPaths(game: GridGame): CorridorPath[] {
  return game.activeLoads.map((load, j) => {
    const route = game.routes[j];
    if (route.plant < 0) return { load, plant: -1, steps: [] };
    const loadV = game.board.vertex(game.nodes[load].col, game.nodes[load].row);
    const path = tracePath(game.board, game.isTransformer, game.faulted, game.tables[j], route.plant, loadV);
    const plant = game.nodeAtVertex(game.board.col(route.plant), game.board.row(route.plant));
    return { load, plant, steps: path.steps };
  });
}

/** Follow `table` (a load's cost table) from (plant, LOW) to the load. */
function tracePath(board: Board, isT: Uint8Array, faulted: Uint8Array, table: Float64Array, plant: number, load: number) {
  const steps: CorridorStep[] = [];
  const verts: number[] = [plant];
  let v = plant;
  let lv: number = LOW;
  for (let guard = 0; v !== load && guard < board.V * 2; guard++) {
    let pick = -1;
    let pickE = -1;
    let pickL = lv;
    let best = Infinity;
    for (let k = 0; k < 4; k++) {
      const n = board.nbrV[v * 4 + k];
      if (n < 0) break;
      const e = board.nbrE[v * 4 + k];
      if (faulted[e]) continue;
      const t = isT[n] === 1;
      const ln = t ? 1 - lv : lv;
      const score = SEG_COST[lv] + (t ? T_COST : 0) + table[n * 2 + ln];
      if (score < best) {
        best = score;
        pick = n;
        pickE = e;
        pickL = ln;
      }
    }
    if (pick < 0 || !Number.isFinite(best)) break;
    steps.push({ edge: pickE, high: lv === HIGH });
    v = pick;
    lv = pickL;
    verts.push(v);
  }
  return { steps, verts };
}
