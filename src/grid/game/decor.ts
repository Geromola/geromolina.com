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
 * v3.2 (SPEC "Home hero v3"), v4 (SPEC "Home hero v4"): the root node "Gero"
 * feeds its links (About, Off the grid, Contact: small nodes beside it) and two
 * sections, NEWS WIRE and PROJECTS, each behind a switch node and inside a
 * fence on the lattice. `menuLayout` places everything in lattice units (the
 * root is vertex (0, 0)); the page positions the DOM from it, so every glyph
 * sits exactly on a vertex and every fence edge on a conductor.
 * `circuitTransformers` and `circuitPaths` wire the circuit: root → each link
 * and each switch → each child.
 */

/** Node geometry in css px, shared with NodeMenu.astro's CSS. */
export const MENU_PX = {
  /** Child glyph diameter. */
  glyph: 44,
  /** Gap between a side glyph and its plate. */
  sideGap: 12,
  /** Plate heights: hanging under the glyph (projects) and beside it (news, phones). */
  hangH: 126,
  sideH: 88,
  /** A hanging plate is this much narrower than 4 spacings (the gap between columns). */
  hangGap: 40,
  /** Compact nodes (the root's links): a smaller glyph and a one-line plate beside it. */
  compactGlyph: 30,
  compactGap: 10,
  compactH: 40,
  /** Headings outrank what they hold: a section switch's glyph, and a category header's (both > `glyph`). */
  switchGlyph: 56,
  headerGlyph: 46,
  /** The Show more control: its height, and its gap under the last plate. */
  moreH: 32,
  moreGap: 8,
  /** The root's glyph diameter, and the room kept between its plate and the first link. */
  rootGlyph: 80,
  linkGap: 24,
  /** The narrowest a link's plate gets beside the root (wide). */
  linkMinW: 120,
  /** A stacked link (phones): its label sits under the glyph, ending this far below the vertex. */
  stackH: 38,
} as const;

export type MenuMode = 'wide' | 'stacked' | 'column';
export type MenuStyle = 'hang' | 'side' | 'compact';
/** The root's links: a one-line plate beside the glyph, or the label under it (phones). */
export type LinkStyle = 'compact' | 'stack';

export interface MenuLinksLayout {
  /** Glyph vertices, in order. */
  nodes: { col: number; row: number }[];
  style: LinkStyle;
  /** Plate (compact) or label (stack) width, px. */
  plateW: number;
  /** On the root's row, beside its plate, or in a row under the root (the fences start lower). */
  placement: 'beside' | 'under';
}

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
  /** The fence bottom its own children need (wide gives both fences the lower of the two). */
  ownR1: number;
  /** PROJECTS by category (SPEC "Projects menu by category"); `children` is then every card, in order. */
  categories?: MenuCategoryLayout[];
}

/**
 * One category row of PROJECTS. Positions are the expanded layout: a collapsed
 * category squeezes its band shut (`menuBands`, `squeezeRow`), so everything
 * under it moves up by whole rows.
 */
export interface MenuCategoryLayout {
  /** The header's glyph: a vertex on the trunk. */
  header: { col: number; row: number };
  /** Every card, expanded. */
  cards: { col: number; row: number }[];
  /** Cards shown while collapsed (the first ones). */
  visible: number;
  /** Rows the hidden cards add under the visible ones, starting at the last visible row `at` (0 rows: they fit beside it). */
  band: { at: number; rows: number };
  /**
   * The Show more control, under the last card row (expanded): `row` is that row, `col` the
   * glyph column it lines up with (the plate's end, or the glyph's start). Null when nothing's hidden.
   */
  more: { row: number; col: number; align: 'end' | 'start' } | null;
  /** Not on the map in this layout (NEWS WIRE's other categories while only its top stories show). */
  hidden?: boolean;
}

/** Cards per row, and cards a collapsed category shows, per mode. */
export const CATEGORY_GRID: Record<MenuMode, { perRow: number; visible: number }> = {
  wide: { perRow: 3, visible: 3 },
  stacked: { perRow: 3, visible: 2 },
  column: { perRow: 1, visible: 2 },
};

export interface MenuLayout {
  mode: MenuMode;
  spacing: number;
  root: { col: number; row: number };
  links: MenuLinksLayout;
  /**
   * One section above the other (stacked, column, and the full news wire), rather than side by
   * side (wide): a collapsed NEWS WIRE then gives its rows back to what follows.
   */
  stacked: boolean;
  /** NEWS WIRE takes the full width with every story (SPEC "Home hero v4", the full wire). */
  newsFull: boolean;
  news: MenuSectionLayout;
  projects: MenuSectionLayout;
  /** Union of the fences, in lattice units. */
  extent: LatticeRect;
}

export interface MenuLayoutOptions {
  /** Children per section. PROJECTS as an array: cards per category, laid out in category rows. */
  /**
   * NEWS WIRE's children. As an array: stories per category (the first is featured), laid out
   * like PROJECTS' categories: its top `newsTop` stories in the left column, or with `newsFull`
   * every story across the full width (PROJECTS then sits under it).
   */
  news: number | readonly number[];
  newsTop?: number;
  newsFull?: boolean;
  projects: number | readonly number[];
  /** The root's links (default none). */
  links?: number;
  /** How far the root's plate reaches right of its vertex, px: wide puts the links beside it when they fit. */
  rootW?: number;
  /** Horizontal margin each side, px. */
  gutter: number;
  /** Lattice row the fences start on (default 1, right under the root): 2 when the root plate is tall. */
  fenceTop?: number;
  /**
   * Collapsed sections. In `stacked` and `column` a collapsed section gives
   * back its rows below the switch, so everything after it moves up by whole
   * rows (and the extent shrinks). `wide` keeps every position.
   */
  collapsed?: { news?: boolean; projects?: boolean };
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
 * Lay the menu out for a viewport width (SPEC "Home hero v3" v3.2, "Home hero v4"):
 * - `wide`: the links beside the root's plate; NEWS WIRE (a column of side nodes) left,
 *   PROJECTS (3 per row, plates hanging) right.
 * - `stacked`: the links in a row under the root; NEWS WIRE (a row of side nodes), then
 *   PROJECTS (3 per row) under it.
 * - `column` (phones, narrow tablets): the links in a row under the root, labels under their
 *   glyphs; then one column on the spine, side nodes throughout.
 * The root is vertex (0, 0); each section's fence starts one row under the root (or under the
 * links' row) and its switch sits just inside the fence's top-left corner.
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
    categories?: MenuCategoryLayout[],
  ): MenuSectionLayout => ({
    switch: sw,
    children,
    style,
    plateW,
    fence,
    collapsed: collapsed(sw, fence),
    ownR1: fence.r1,
    ...(categories && { categories }),
  });
  const rows = (n: number, perRow: number) => Math.max(1, Math.ceil(n / perRow));
  // Whole rows a hanging plate needs under its glyph row (2 at 64px).
  const hangRows = (sp: number) => Math.max(2, Math.ceil(MENU_PX.hangH / sp - 1e-9));
  const counts = typeof opts.projects === 'number' ? null : opts.projects;
  const nProjects = counts ? counts.reduce((a, b) => a + b, 0) : (opts.projects as number);

  const mode: MenuMode = inner / WIDE_COLS >= MIN_WIDE ? 'wide' : inner / STACKED_COLS >= MIN_STACKED ? 'stacked' : 'column';
  /**
   * Category rows from row `top` down: a header on the trunk (column `header`), its cards from
   * column `card`, `dc` apart, under it. Returns them and the row under the last one.
   */
  const categoryRows = (
    of: readonly number[],
    top: number,
    at: { header: number; card: number; dc: number },
    { perRow, visible } = CATEGORY_GRID[mode],
  ) => {
    const first = mode === 'column' ? 2 : 1; // header → first card row
    const step = mode === 'column' ? 2 : 3; // card row → card row
    const tail = mode === 'column' ? 2 : 3; // last card row → the next header (one more under a Show more)
    let h = top;
    const cats = of.map((n): MenuCategoryLayout => {
      const row0 = h + first;
      const cards = Array.from({ length: n }, (_, k) => ({
        col: at.card + (k % perRow) * at.dc,
        row: row0 + Math.floor(k / perRow) * step,
      }));
      const lastShown = row0 + (rows(Math.min(n, visible), perRow) - 1) * step;
      const last = row0 + (rows(n, perRow) - 1) * step;
      const hidden = n > visible;
      const cat: MenuCategoryLayout = {
        header: { col: at.header, row: h },
        cards,
        visible: Math.min(n, visible),
        band: { at: lastShown, rows: last - lastShown },
        more: hidden
          ? mode === 'column'
            ? { row: last, col: at.card, align: 'start' }
            : { row: last, col: at.card + (perRow - 1) * at.dc, align: 'end' }
          : null,
      };
      h = last + tail + (hidden ? 1 : 0);
      return cat;
    });
    return { cats, bottom: h };
  };

  const newsCounts = typeof opts.news === 'number' ? null : opts.news;
  const nNews = newsCounts ? newsCounts.reduce((a, b) => a + b, 0) : (opts.news as number);
  const full = Boolean(opts.newsFull && newsCounts);
  const stacked = mode !== 'wide' || full;
  let s: number;
  let right: number;
  let room = 0;
  if (mode === 'wide') {
    s = Math.min(MAX_SPACING_MENU, inner / WIDE_COLS);
    right = 18;
  } else if (mode === 'stacked') {
    s = Math.min(MAX_SPACING_MENU, inner / STACKED_COLS);
    right = 12;
  } else {
    // An exact number of spacings across, near 58px; the fence spans them all.
    const n = Math.max(4, Math.round(inner / PHONE_SPACING_MENU));
    s = inner / n;
    right = n - 1;
    room = right - 0.3;
  }
  const sideKids = mode === 'wide' ? sideW(s, 3.7) : mode === 'stacked' ? 4 * s - 2 * g - MENU_PX.sideGap - 16 : sideW(s, room);
  const hangW = 4 * s - MENU_PX.hangGap;

  // NEWS WIRE.
  let news: MenuSectionLayout;
  const newsC1 = mode === 'wide' && !full ? 4 : right;
  if (newsCounts && full) {
    // Every story, by category, across the full width: wide 4 per row, stacked 3, phones 1.
    const perRow = mode === 'wide' ? 4 : mode === 'stacked' ? 3 : 1;
    const at = mode === 'column' ? { header: 0, card: 0, dc: 0 } : { header: 0, card: 2, dc: 4 };
    const byCat = categoryRows(newsCounts, 3, at, { perRow, visible: Infinity });
    const r1 = mode === 'column' ? byCat.bottom - 1 : byCat.bottom;
    news = section(
      { col: 0, row: 2 },
      byCat.cats.flatMap((c) => c.cards),
      mode === 'column' ? 'side' : 'hang',
      mode === 'column' ? sideKids : hangW,
      { c0: -1, r0: 1, c1: newsC1, r1 },
      byCat.cats,
    );
  } else if (newsCounts) {
    // The featured category's header under the switch, its top stories as side nodes under it
    // (a row of them when stacked), and the All-stories control under the last one.
    const top = Math.min(Math.max(1, opts.newsTop ?? 3), newsCounts[0] ?? 0);
    const cards = mode === 'stacked' ? grid(top, 3, 0, 5, 4, 0) : grid(top, 1, 0, 5, 0, 2);
    const last = cards.at(-1)?.row ?? 3;
    const featured: MenuCategoryLayout = {
      header: { col: 0, row: 3 },
      cards,
      visible: top,
      band: { at: last, rows: 0 },
      more: { row: last, col: 0, align: 'start' },
    };
    const others = newsCounts.slice(1).map(
      (): MenuCategoryLayout => ({ header: { col: 0, row: 3 }, cards: [], visible: 0, band: { at: 3, rows: 0 }, more: null, hidden: true }),
    );
    const r1 = mode === 'wide' ? Math.max(9, last + 2) : last + 2;
    news = section({ col: 0, row: 2 }, cards, 'side', sideKids, { c0: -1, r0: 1, c1: newsC1, r1 }, [featured, ...others]);
  } else {
    // Plain children: down the spine 2 rows apart (wide, phones), or in rows of 3 (stacked).
    const kids = mode === 'stacked' ? grid(nNews, 3, 0, 4, 4, 2) : grid(nNews, 1, 0, 4, 0, 2);
    const last = kids.at(-1)?.row ?? 2;
    const r1 = mode === 'wide' ? Math.max(9, last + 1) : last + 1;
    news = section({ col: 0, row: 2 }, kids, 'side', sideKids, { c0: -1, r0: 1, c1: newsC1, r1 });
  }

  // PROJECTS: beside NEWS WIRE (wide: fence cols 5..18, switch (6, 2), the category headers down
  // the trunk at col 6, cards 4 cols and 3 rows apart with hanging plates), or the next fence down
  // (stacked, phones, the full wire), with the trunk at col 0.
  let projects: MenuSectionLayout;
  if (!stacked) {
    const nBottom = news.fence.r1;
    const byCat = counts && categoryRows(counts, 3, { header: 6, card: 8, dc: 4 });
    const pRows = rows(nProjects, 3);
    const pBottom = byCat ? byCat.bottom : Math.max(nBottom, 4 + 3 * (pRows - 1) + hangRows(s));
    const r1 = Math.max(nBottom, pBottom);
    news.fence = { ...news.fence, r1 };
    news.ownR1 = nBottom;
    projects = section(
      { col: 6, row: 2 },
      byCat ? byCat.cats.flatMap((c) => c.cards) : grid(nProjects, 3, 8, 4, 4, 3),
      'hang',
      hangW,
      { c0: 5, r0: 1, c1: 18, r1 },
      byCat?.cats,
    );
    projects.ownR1 = pBottom;
  } else if (mode === 'column') {
    const top = news.fence.r1 + 1;
    // By category: the headers on the spine, right under the switch, each one's cards down the
    // spine under it.
    const byCat = counts && categoryRows(counts, top + 2, { header: 0, card: 0, dc: 0 });
    projects = section(
      { col: 0, row: top + 1 },
      byCat ? byCat.cats.flatMap((c) => c.cards) : grid(nProjects, 1, 0, top + 3, 0, 2),
      'side',
      sideKids,
      { c0: -1, r0: top, c1: right, r1: byCat ? byCat.bottom - 1 : top + 3 + 2 * (nProjects - 1) + 1 },
      byCat?.cats,
    );
  } else {
    const top = news.fence.r1 + 1;
    const byCat = counts && categoryRows(counts, top + 2, { header: 0, card: 2, dc: 4 });
    const pRows = rows(nProjects, 3);
    projects = section(
      { col: 0, row: top + 1 },
      byCat ? byCat.cats.flatMap((c) => c.cards) : grid(nProjects, 3, 2, top + 3, 4, 3),
      'hang',
      hangW,
      { c0: -1, r0: top, c1: right, r1: byCat ? byCat.bottom : top + 3 + 3 * (pRows - 1) + hangRows(s) },
      byCat?.cats,
    );
  }
  // The root's links: beside its plate (wide, when they fit before the fences' right edge), else
  // in a row under the root, spread across, with the fences a row lower.
  let dr = Math.max(0, Math.round(opts.fenceTop ?? 1) - 1);
  const nLinks = Math.max(0, opts.links ?? 0);
  const cg = MENU_PX.compactGlyph / 2;
  let links: MenuLinksLayout = { nodes: [], style: 'compact', plateW: 0, placement: 'beside' };
  if (nLinks > 0 && mode === 'wide') {
    // As far right as they go: the last plate ends by the fences' right edge, the row spread
    // evenly back toward the root's plate (at least 3 spacings apart).
    const first = Math.ceil(((opts.rootW ?? 0) + MENU_PX.linkGap + cg) / s);
    const last = Math.floor(right - (cg + MENU_PX.compactGap + MENU_PX.linkMinW) / s);
    const step = nLinks > 1 ? Math.floor((last - first) / (nLinks - 1)) : 3;
    if (step >= 3 || (nLinks === 1 && last >= first)) {
      const start = last - step * (nLinks - 1);
      const plateW = Math.min(step * s - 2 * cg - MENU_PX.compactGap - 12, (right - last) * s - cg - MENU_PX.compactGap);
      links = { nodes: grid(nLinks, nLinks, start, 0, step, 0), style: 'compact', plateW, placement: 'beside' };
    }
  }
  if (nLinks > 0 && !links.nodes.length) {
    const row = dr + 1;
    // Phones: evenly spread, each label centred under its glyph and kept inside the fences' edges.
    const stackStep = nLinks > 1 ? Math.max(1, Math.floor((right - 1) / (nLinks - 1))) : 2;
    const step = Math.max(2, Math.floor((right + 1) / nLinks));
    links =
      mode === 'column'
        ? {
            nodes: grid(nLinks, nLinks, 0, row, stackStep, 0),
            style: 'stack',
            plateW: Math.min(stackStep, 2) * s - 8,
            placement: 'under',
          }
        : {
            nodes: grid(nLinks, nLinks, 0, row, step, 0),
            style: 'compact',
            plateW: step * s - 2 * cg - MENU_PX.compactGap - 12,
            placement: 'under',
          };
    dr += 1;
  }
  // Everything but the root (and its links) moves down when the fences start lower.
  if (dr) for (const sec of [news, projects]) moveSection(sec, dr);
  let bottom = Math.max(news.fence.r1, projects.fence.r1);
  if (stacked) {
    // A collapsed section keeps only its switch row: what follows moves up by the rows it frees.
    if (opts.collapsed?.news) moveSection(projects, -(news.fence.r1 - news.collapsed.r1));
    bottom = opts.collapsed?.projects ? projects.collapsed.r1 : projects.fence.r1;
  }
  const extent = {
    c0: Math.min(news.fence.c0, projects.fence.c0),
    r0: 0,
    c1: Math.max(news.fence.c1, projects.fence.c1),
    r1: bottom,
  };
  return { mode, spacing: s, root: { col: 0, row: 0 }, links, stacked, newsFull: full, news, projects, extent };
}

/** Move a section (switch, children, fences, categories) down `dr` whole rows. */
function moveSection(sec: MenuSectionLayout, dr: number) {
  const down = <T extends { row: number }>(p: T): T => ({ ...p, row: p.row + dr });
  sec.switch = down(sec.switch);
  sec.children = sec.children.map(down);
  sec.fence = { ...sec.fence, r0: sec.fence.r0 + dr, r1: sec.fence.r1 + dr };
  sec.collapsed = { ...sec.collapsed, r0: sec.collapsed.r0 + dr, r1: sec.collapsed.r1 + dr };
  sec.ownR1 += dr;
  sec.categories = sec.categories?.map((c) => ({
    ...c,
    header: down(c.header),
    cards: c.cards.map(down),
    band: { ...c.band, at: c.band.at + dr },
    more: c.more && down(c.more),
  }));
}

/**
 * Rows squeezed shut, in layout rows: from row `at`, `rows` of them, for columns `c0..c1`,
 * by `v` (0 open .. 1 shut). NEWS WIRE's freed rows (stacked, column) and each category's
 * hidden-card rows are bands; the engine keeps the expanded layout and the page draws it
 * through them.
 */
export interface Band {
  at: number;
  rows: number;
  c0: number;
  c1: number;
  v: number;
}

/**
 * The menu's bands. `shut`: how far NEWS WIRE (0 open .. 1 collapsed) and each category
 * (0 expanded .. 1 collapsed) are squeezed. Wide keeps NEWS WIRE's rows, and its category
 * bands only cover the PROJECTS columns (NEWS WIRE sits beside them).
 */
export function menuBands(l: MenuLayout, shut: { news?: number; categories?: readonly number[] }): Band[] {
  const out: Band[] = [];
  const newsRows = l.stacked ? l.news.fence.r1 - l.news.collapsed.r1 : 0;
  if (newsRows > 0) out.push({ at: l.news.collapsed.r1, rows: newsRows, c0: -Infinity, c1: Infinity, v: shut.news ?? 0 });
  l.projects.categories?.forEach((c, k) => {
    if (c.band.rows <= 0) return;
    const c0 = l.stacked ? -Infinity : l.projects.fence.c0;
    out.push({ ...c.band, c0, c1: Infinity, v: shut.categories?.[k] ?? 0 });
  });
  return out;
}

/** Where layout row `row` (at column `col`) is drawn through the bands: under a band it moves up, inside it it closes up. */
export function squeezeRow(row: number, col: number, bands: readonly Band[]): number {
  let out = row;
  for (const b of bands) {
    if (b.v <= 0 || row <= b.at || col < b.c0 || col > b.c1) continue;
    out -= b.v * Math.min(row - b.at, b.rows);
  }
  return out;
}

/** How squeezed the band holding row `row` (strictly inside it) is: 0 when it's in none. */
export function bandSqueeze(row: number, col: number, bands: readonly Band[]): number {
  let v = 0;
  for (const b of bands) if (row > b.at && row < b.at + b.rows && col >= b.c0 && col <= b.c1) v = Math.max(v, b.v);
  return v;
}

/**
 * The flow's anchors, where they're drawn: the root, its links, the switches, NEWS WIRE's children, and
 * in PROJECTS each category header plus its visible cards (all of them while `open[k]`). A
 * collapsed category's hidden cards are no anchors, and its rows are squeezed shut.
 */
export function menuAnchors(l: MenuLayout, open: readonly boolean[] = []): { id: string; col: number; row: number }[] {
  const cats = l.projects.categories;
  const bands = menuBands(l, { categories: cats?.map((_, k) => (open[k] ? 0 : 1)) });
  const out: { id: string; col: number; row: number }[] = [];
  const add = (id: string, p: { col: number; row: number }) => out.push({ id, col: p.col, row: squeezeRow(p.row, p.col, bands) });
  add('root', l.root);
  l.links.nodes.forEach((p, k) => add(`link/${k}`, p));
  add('news', l.news.switch);
  const newsCats = l.news.categories?.filter((c) => !c.hidden);
  if (!newsCats) l.news.children.forEach((c, k) => add(`news/${k}`, c));
  newsCats?.forEach((c, k) => {
    add(`news-cat/${k}`, c.header);
    c.cards.forEach((p, j) => add(`news-cat/${k}/${j}`, p));
  });
  add('projects', l.projects.switch);
  if (!cats) l.projects.children.forEach((c, k) => add(`projects/${k}`, c));
  cats?.forEach((c, k) => {
    add(`cat/${k}`, c.header);
    c.cards.slice(0, open[k] ? c.cards.length : c.visible).forEach((p, j) => add(`cat/${k}/${j}`, p));
  });
  return out;
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
