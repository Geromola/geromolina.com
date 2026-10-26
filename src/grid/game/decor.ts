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
  /**
   * Independent vertical flow it sits in (default 0). A top margin only pushes
   * down the points of its own flow: side-by-side columns (the menu's two
   * zones on desktop) are separate flows; one stacked column is a single flow.
   */
  flow?: number;
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
   * everything below in the same flow down, so `dy` is a line's own shift, not
   * a running total.
   * `col`/`row` is the vertex the glyph ends on.
   */
  snaps: { dx: number; dy: number; col: number; row: number }[];
  /** The largest sum of `dy` over one flow: how much taller the menu gets. */
  grow: number;
}

const LINE_TOL = 2; // px: glyph centres this close in y share a line

/**
 * Snap menu glyphs to lattice vertices. Lines (points of one flow sharing a
 * y) keep their order and land on distinct lattice rows: each one moves down
 * to the next row at or below it. Within a line, glyphs snap to the nearest
 * column through `anchorX`, so a centred row stays symmetric. Without a fixed
 * spacing, the one needing the smallest nudges (both ways) wins; a spacing
 * that would put two glyphs at one y on one vertex is never picked.
 */
export function snapMenu(points: readonly MenuPoint[], opts: MenuSnapOptions): MenuSnap {
  const min = opts.min ?? 56;
  const max = opts.max ?? 76;
  const prefer = opts.prefer ?? (min + max) / 2;
  const order = points.map((_, i) => i).sort((a, b) => points[a].y - points[b].y || points[a].x - points[b].x);
  const group = (key: (i: number) => number) => {
    const out: number[][] = [];
    const open = new Map<number, number[]>(); // flow key → its current line
    for (const i of order) {
      const k = key(i);
      const line = open.get(k);
      if (line && Math.abs(points[i].y - points[line[0]].y) <= LINE_TOL) line.push(i);
      else {
        const fresh = [i];
        open.set(k, fresh);
        out.push(fresh);
      }
    }
    return out;
  };
  const lines = group((i) => points[i].flow ?? 0);
  const levels = group(() => 0); // every point at one y, whatever its flow
  const colOf = (x: number, s: number) => Math.round((x - opts.anchorX) / s);
  const clash = (s: number) =>
    levels.some((line) => new Set(line.map((i) => colOf(points[i].x, s))).size !== line.length);
  const y0 = points.length ? points[order[0]].y : 0;

  let spacing = opts.spacing ?? 0;
  if (!spacing) {
    let best = Infinity;
    for (let s = min; s <= max + 1e-9; s += 0.5) {
      if (clash(s)) continue;
      let cost = 0;
      for (const p of points) {
        const rx = p.x - opts.anchorX - colOf(p.x, s) * s;
        const ry = p.y - y0 - Math.round((p.y - y0) / s) * s;
        cost += rx * rx + ry * ry;
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
  const ox = opts.anchorX - Math.ceil(opts.anchorX / s) * s; // (−s, 0]
  const oy = y0 - Math.ceil(y0 / s) * s;
  const snaps = points.map(() => ({ dx: 0, dy: 0, col: 0, row: 0 }));
  const carry = new Map<number, number>(); // per flow
  for (const line of lines) {
    const flow = points[line[0]].flow ?? 0;
    const y = points[line[0]].y + (carry.get(flow) ?? 0);
    const row = Math.ceil((y - oy) / s - 1e-6);
    const dy = Math.max(0, oy + row * s - y);
    carry.set(flow, (carry.get(flow) ?? 0) + dy);
    for (const i of line) {
      const c = colOf(points[i].x, s);
      const col = Math.round((opts.anchorX - ox) / s) + c;
      snaps[i] = { dx: opts.anchorX + c * s - points[i].x, dy, col, row };
    }
  }
  return { spacing: s, ox, oy, snaps, grow: Math.max(0, ...carry.values()) };
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

// ------------------------------------------------- node menu v3.2: sections
/*
 * v3.2 (SPEC "Home hero v3"): the root node "Gero" feeds two sections, ABOUT
 * ME and PROJECTS, each behind a switch node and inside a fence on the
 * lattice. `menuLayout` places everything in lattice units (the root is vertex
 * (0, 0)); the page positions the DOM from it, so every glyph sits exactly on
 * a vertex and every fence edge on a conductor. `circuitTransformers` and
 * `circuitPaths` wire the circuit: root → each switch → each child.
 */

/** Node geometry in css px, shared with NodeMenu.astro's CSS. */
export const MENU_PX = {
  /** Child glyph diameter. */
  glyph: 44,
  /** Gap between a side glyph and its plate. */
  sideGap: 12,
  /** Plate heights: hanging under the glyph (projects) and beside it (about, phones). */
  hangH: 104,
  sideH: 84,
  /** A hanging plate is this much narrower than 4 spacings (the gap between columns). */
  hangGap: 40,
} as const;

export type MenuMode = 'wide' | 'stacked' | 'column';
export type MenuStyle = 'hang' | 'side';

export interface LatticeRect {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

export interface MenuSectionLayout {
  switch: { col: number; row: number };
  children: { col: number; row: number }[];
  style: MenuStyle;
  /** Plate width, px. */
  plateW: number;
  /** Fence when expanded, and shrunk to the switch when collapsed (lattice lines). */
  fence: LatticeRect;
  collapsed: LatticeRect;
}

export interface MenuLayout {
  mode: MenuMode;
  spacing: number;
  root: { col: number; row: number };
  about: MenuSectionLayout;
  projects: MenuSectionLayout;
  /** Union of the fences, in lattice units. */
  extent: LatticeRect;
}

export interface MenuLayoutOptions {
  /** Children per section. */
  about: number;
  projects: number;
  /** Horizontal margin each side, px. */
  gutter: number;
  /** Lattice row the fences start on (default 1, right under the root): 2 when the root plate is tall. */
  fenceTop?: number;
  /**
   * Collapsed sections. In `stacked` and `column` a collapsed section gives
   * back its rows below the switch, so everything after it moves up by whole
   * rows (and the extent shrinks). `wide` keeps every position.
   */
  collapsed?: { about?: boolean; projects?: boolean };
}

/** Lattice columns each layout needs, fence edge to fence edge. */
const WIDE_COLS = 19;
const STACKED_COLS = 13;
const MIN_WIDE = 56;
const MIN_STACKED = 55;
const MAX_SPACING_MENU = 64;
const PHONE_SPACING_MENU = 58;
/** Switch area when collapsed: the glyph and its label (≈ 4 spacings). */
const SWITCH_COLS = 4;

/**
 * Lay the menu out for a viewport width (SPEC "Home hero v3", v3.2):
 * - `wide`: ABOUT ME (a column of side nodes) left, PROJECTS (3 per row, plates hanging) right.
 * - `stacked`: ABOUT ME (a row of side nodes), then PROJECTS (3 per row) under it.
 * - `column` (phones, narrow tablets): one column on the spine, side nodes throughout.
 * The root is vertex (0, 0); each section's fence starts one row under the root and its
 * switch sits just inside the fence's top-left corner.
 */
export function menuLayout(width: number, opts: MenuLayoutOptions): MenuLayout {
  const inner = width - 2 * opts.gutter;
  const g = MENU_PX.glyph / 2;
  const sideW = (s: number, room: number) => room * s - g - MENU_PX.sideGap;
  const collapsed = (sw: { col: number; row: number }, fence: LatticeRect): LatticeRect => ({
    c0: fence.c0,
    r0: fence.r0,
    c1: Math.min(fence.c1, sw.col + SWITCH_COLS),
    r1: sw.row + 1,
  });
  const grid = (n: number, perRow: number, c0: number, r0: number, dc: number, dr: number) =>
    Array.from({ length: n }, (_, k) => ({ col: c0 + (k % perRow) * dc, row: r0 + Math.floor(k / perRow) * dr }));
  const section = (
    sw: { col: number; row: number },
    children: { col: number; row: number }[],
    style: MenuStyle,
    plateW: number,
    fence: LatticeRect,
  ): MenuSectionLayout => ({ switch: sw, children, style, plateW, fence, collapsed: collapsed(sw, fence) });
  const rows = (n: number, perRow: number) => Math.max(1, Math.ceil(n / perRow));

  let mode: MenuMode;
  let s: number;
  let about: MenuSectionLayout;
  let projects: MenuSectionLayout;
  if (inner / WIDE_COLS >= MIN_WIDE) {
    mode = 'wide';
    s = Math.min(MAX_SPACING_MENU, inner / WIDE_COLS);
    // ABOUT ME: fence cols −1..4; switch (0, 2); children down the spine, 2 rows apart.
    const aKids = grid(opts.about, 1, 0, 4, 0, 2);
    const aBottom = Math.max(9, (aKids.at(-1)?.row ?? 2) + 1);
    // PROJECTS: fence cols 5..18; switch (6, 2); children 4 cols and 3 rows apart, hanging plates.
    const pRows = rows(opts.projects, 3);
    const pBottom = Math.max(aBottom, 4 + 3 * (pRows - 1) + 2);
    about = section({ col: 0, row: 2 }, aKids, 'side', sideW(s, 3.7), { c0: -1, r0: 1, c1: 4, r1: Math.max(aBottom, pBottom) });
    projects = section({ col: 6, row: 2 }, grid(opts.projects, 3, 8, 4, 4, 3), 'hang', 4 * s - MENU_PX.hangGap, {
      c0: 5,
      r0: 1,
      c1: 18,
      r1: Math.max(aBottom, pBottom),
    });
  } else if (inner / STACKED_COLS >= MIN_STACKED) {
    mode = 'stacked';
    s = Math.min(MAX_SPACING_MENU, inner / STACKED_COLS);
    // ABOUT ME: fence −1..12 × 1..5; switch (0, 2); children in a row on row 4, 4 cols apart.
    const aRows = rows(opts.about, 3);
    const aBottom = 4 + 2 * (aRows - 1) + 1;
    about = section({ col: 0, row: 2 }, grid(opts.about, 3, 0, 4, 4, 2), 'side', 4 * s - 2 * g - MENU_PX.sideGap - 16, {
      c0: -1,
      r0: 1,
      c1: 12,
      r1: aBottom,
    });
    // PROJECTS: the next fence down; switch one row in; children 4 cols and 3 rows apart.
    const top = aBottom + 1;
    const pRows = rows(opts.projects, 3);
    projects = section(
      { col: 0, row: top + 1 },
      grid(opts.projects, 3, 2, top + 3, 4, 3),
      'hang',
      4 * s - MENU_PX.hangGap,
      { c0: -1, r0: top, c1: 12, r1: top + 3 + 3 * (pRows - 1) + 2 },
    );
  } else {
    mode = 'column';
    // An exact number of spacings across, near 58px; the fence spans them all.
    const n = Math.max(4, Math.round(inner / PHONE_SPACING_MENU));
    s = inner / n;
    const c1 = n - 1;
    const room = c1 - 0.3;
    const aBottom = 4 + 2 * (opts.about - 1) + 1;
    about = section({ col: 0, row: 2 }, grid(opts.about, 1, 0, 4, 0, 2), 'side', sideW(s, room), {
      c0: -1,
      r0: 1,
      c1,
      r1: aBottom,
    });
    const top = aBottom + 1;
    projects = section(
      { col: 0, row: top + 1 },
      grid(opts.projects, 1, 0, top + 3, 0, 2),
      'side',
      sideW(s, room),
      { c0: -1, r0: top, c1, r1: top + 3 + 2 * (opts.projects - 1) + 1 },
    );
  }
  // Everything but the root moves down when the fences start lower.
  const dr = Math.max(0, Math.round(opts.fenceTop ?? 1) - 1);
  if (dr) {
    for (const sec of [about, projects]) {
      sec.switch = { ...sec.switch, row: sec.switch.row + dr };
      sec.children = sec.children.map((c) => ({ ...c, row: c.row + dr }));
      sec.fence = { ...sec.fence, r0: sec.fence.r0 + dr, r1: sec.fence.r1 + dr };
      sec.collapsed = { ...sec.collapsed, r0: sec.collapsed.r0 + dr, r1: sec.collapsed.r1 + dr };
    }
  }
  let bottom = Math.max(about.fence.r1, projects.fence.r1);
  if (mode !== 'wide') {
    // A collapsed section keeps only its switch row: what follows moves up by the rows it frees.
    if (opts.collapsed?.about) {
      const up = about.fence.r1 - about.collapsed.r1;
      projects.switch = { ...projects.switch, row: projects.switch.row - up };
      projects.children = projects.children.map((c) => ({ ...c, row: c.row - up }));
      projects.fence = { ...projects.fence, r0: projects.fence.r0 - up, r1: projects.fence.r1 - up };
      projects.collapsed = { ...projects.collapsed, r0: projects.collapsed.r0 - up, r1: projects.collapsed.r1 - up };
    }
    bottom = opts.collapsed?.projects ? projects.collapsed.r1 : projects.fence.r1;
  }
  const extent = {
    c0: Math.min(about.fence.c0, projects.fence.c0),
    r0: 0,
    c1: Math.max(about.fence.c1, projects.fence.c1),
    r1: bottom,
  };
  return { mode, spacing: s, root: { col: 0, row: 0 }, about, projects, extent };
}

/** One leg of the circuit: power flows from vertex `from` to vertex `to`. */
export interface Feed {
  from: number;
  to: number;
}

/**
 * One hidden transformer beside every vertex of the circuit (the root, the
 * switches, the children), so the board reads as solved: a feed leaves its
 * source at 13.8 kV, steps up beside it, runs at 345 kV and steps down beside
 * its destination. A switch's one transformer serves both ways (down from the
 * root, up toward its children). Sources are placed first, facing their
 * destinations; each destination takes the free neighbour its feed delivers
 * best through (ties: one no other feed already runs through, then the side
 * facing its own destinations). Two passes. Returns vertices.
 */
export function circuitTransformers(
  board: Board,
  bounds: Bounds,
  nodeVerts: ReadonlySet<number>,
  feeds: readonly Feed[],
  faulted: Uint8Array = new Uint8Array(board.E),
): number[] {
  const isT = new Uint8Array(board.V);
  const table = new Float64Array(board.V * 2);
  const dist = (a: number, b: number) => Math.abs(board.col(a) - board.col(b)) + Math.abs(board.row(a) - board.row(b));
  const free = (v: number) => {
    const out: number[] = [];
    for (const [dc, dr] of [[0, 1], [1, 0], [-1, 0], [0, -1]]) {
      const c = board.col(v) + dc;
      const r = board.row(v) + dr;
      if (!board.inLattice(c, r) || !inBounds(bounds, c, r)) continue;
      const n = board.vertex(c, r);
      if (!nodeVerts.has(n) && !isT[n]) out.push(n);
    }
    return out;
  };
  const inbound = new Map<number, number>(); // destination → its source
  const outbound = new Map<number, number[]>(); // source → its destinations
  for (const f of feeds) {
    inbound.set(f.to, f.from);
    outbound.set(f.from, [...(outbound.get(f.from) ?? []), f.to]);
  }
  // Roots (sources nothing feeds) first, then destinations breadth-first from them.
  const order: number[] = [...outbound.keys()].filter((v) => !inbound.has(v));
  for (let k = 0; k < order.length; k++) for (const to of outbound.get(order[k]) ?? []) if (!order.includes(to)) order.push(to);

  const at = new Map<number, number>(); // vertex → its transformer
  const pathVerts = (skip: number) => {
    const used = new Set<number>();
    for (const [to, from] of inbound) {
      if (to === skip || !at.has(to) || !at.has(from)) continue;
      costTable(board, isT, faulted, to, table);
      for (const v of tracePath(board, isT, faulted, table, from, to).verts) used.add(v);
    }
    return used;
  };
  const place = (v: number) => {
    const prev = at.get(v);
    if (prev !== undefined) isT[prev] = 0;
    const from = inbound.get(v);
    const toward = outbound.get(v) ?? [];
    const used = pathVerts(v);
    let pick = -1;
    let best = -Infinity;
    for (const c of prev !== undefined ? [prev, ...free(v)] : free(v)) {
      let score = 0;
      if (from !== undefined && at.has(from)) {
        isT[c] = 1;
        costTable(board, isT, faulted, v, table);
        isT[c] = 0;
        score += Math.exp(-table[from * 2 + LOW]);
      }
      if (used.has(c)) score -= 0.01;
      score -= 1e-4 * toward.reduce((sum, t) => sum + dist(c, t), 0);
      if (score > best + 1e-12) {
        best = score;
        pick = c;
      }
    }
    if (pick >= 0) {
      isT[pick] = 1;
      at.set(v, pick);
    } else at.delete(v);
  };
  for (const v of order) place(v);
  for (const v of order) if (inbound.has(v)) place(v);

  const out: number[] = [];
  for (let v = 0; v < board.V; v++) if (isT[v]) out.push(v);
  return out;
}

export interface FeedPath {
  /** Node indices. */
  from: number;
  to: number;
  steps: CorridorStep[];
}

/**
 * The route of each feed (node index pairs): from the source at 13.8 kV, down
 * the destination's cost table. The destination must be an active load.
 */
export function circuitPaths(game: GridGame, feeds: readonly { from: number; to: number }[]): FeedPath[] {
  const vOf = (k: number) => game.board.vertex(game.nodes[k].col, game.nodes[k].row);
  return feeds.map(({ from, to }) => {
    const j = game.activeLoads.indexOf(to);
    if (j < 0) return { from, to, steps: [] };
    const path = tracePath(game.board, game.isTransformer, game.faulted, game.tables[j], vOf(from), vOf(to));
    return { from, to, steps: path.verts[path.verts.length - 1] === vOf(to) ? path.steps : [] };
  });
}
