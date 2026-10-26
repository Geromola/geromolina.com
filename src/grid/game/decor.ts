import { computeLattice, type Lattice } from '../layout';
import type { Bounds } from './board';
import { visibleBounds, type GameNode } from './layout';
import type { LevelDef } from './levels';

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
