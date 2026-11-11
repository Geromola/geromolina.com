/**
 * The page's figure helpers (SPEC "Physarum", Design language), DOM-free: the shuttle-streaming
 * wave, oat-flake outlines, hand-drawn callouts on the board, and the layout of the
 * cost-against-resilience figure. Drawing happens in overlay.ts and main.ts.
 */
import { mulberry32 } from '../energy/rounds';

/** Shuttle streaming reverses about every 100 s in the real plasmodium; drawn sped up. */
export const REAL_SHUTTLE_SECONDS = 100;
export const SHUTTLE_SECONDS = 8;

/** Phase groups the streaming wave is drawn in (each is one set of strokes). */
export const WAVE_GROUPS = 4;

/**
 * Which phase group a point belongs to: the wave runs diagonally across the board, about two
 * crests per board width.
 */
export function waveGroup(x: number, y: number, width: number): number {
  const u = ((x + 0.6 * y) / width) * 2;
  const g = Math.floor((u - Math.floor(u)) * WAVE_GROUPS);
  return Math.min(WAVE_GROUPS - 1, Math.max(0, g));
}

/**
 * How swollen phase group `g` is at `seconds`, from 0 to 1: a slow peristaltic wave that
 * travels from group to group.
 */
export function waveSwell(g: number, seconds: number): number {
  const phase = (seconds / SHUTTLE_SECONDS) * Math.PI * 2 - (g / WAVE_GROUPS) * Math.PI * 2;
  return 0.5 + 0.5 * Math.sin(phase);
}

/**
 * An oat flake's outline: `n` radii (shares of the flake's radius, 0.72 to 1.12) around an
 * ellipse, and a tilt, the same every time for the same seed.
 */
export function flakeShape(seed: number, n = 9): { radii: number[]; tilt: number; squash: number } {
  const rng = mulberry32(seed * 7919 + 13);
  const radii = Array.from({ length: n }, () => 0.72 + 0.4 * rng());
  return { radii, tilt: rng() * Math.PI, squash: 0.62 + 0.18 * rng() };
}

/** Points around a flake centred at (x, y) with radius r, ready to draw as a smooth closed curve. */
export function flakePoints(x: number, y: number, r: number, shape: ReturnType<typeof flakeShape>): number[] {
  const out: number[] = [];
  const n = shape.radii.length;
  const c = Math.cos(shape.tilt), s = Math.sin(shape.tilt);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const px = Math.cos(a) * r * shape.radii[i];
    const py = Math.sin(a) * r * shape.radii[i] * shape.squash;
    out.push(x + px * c - py * s, y + px * s + py * c);
  }
  return out;
}

export interface Callout {
  /** What it points at, in px. */
  ax: number;
  ay: number;
  /** Where the label sits (its anchor), in px, and which way the text runs from it. */
  lx: number;
  ly: number;
  align: 'left' | 'right';
  /** The leader: a gentle curve from near the label to just short of the target. */
  leader: number[];
}

/**
 * Places a callout for a point on a board (`bx`, `by`, `bw`, `bh` in px): the label sits
 * `reach` px away, up and out toward the roomier side, inside the board. The leader bows a
 * little, and its wobble is the same every time for the same seed, so it looks drawn by hand
 * but never jitters.
 */
export function placeCallout(ax: number, ay: number, bx: number, by: number, bw: number, bh: number, reach: number, seed = 1): Callout {
  const right = ax < bx + bw / 2;
  const up = ay > by + bh * 0.3;
  const margin = Math.min(bw, bh) * 0.04;
  const lx = Math.min(bx + bw - margin, Math.max(bx + margin, ax + (right ? reach : -reach)));
  const ly = Math.min(by + bh - margin, Math.max(by + margin, ay + (up ? -reach * 0.7 : reach * 0.7)));
  const rng = mulberry32(seed * 104729 + 1);
  // Start beside the label, end a little short of the target.
  const sx = lx + (right ? -4 : 4);
  const sy = ly;
  const dx = ax - sx, dy = ay - sy;
  const len = Math.hypot(dx, dy) || 1;
  const gap = Math.min(len * 0.2, 3.5);
  const ex = ax - (dx / len) * gap, ey = ay - (dy / len) * gap;
  const bow = (0.12 + 0.1 * rng()) * len * (rng() < 0.5 ? -1 : 1);
  const mx = (sx + ex) / 2 - (dy / len) * bow, my = (sy + ey) / 2 + (dx / len) * bow;
  const leader: number[] = [];
  const steps = 10;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // A quadratic curve, with a whisper of tremor in the middle so it reads as drawn.
    const tremor = Math.sin(t * Math.PI) * (rng() - 0.5) * 1.2;
    const x = (1 - t) * (1 - t) * sx + 2 * (1 - t) * t * mx + t * t * ex;
    const y = (1 - t) * (1 - t) * sy + 2 * (1 - t) * t * my + t * t * ey;
    leader.push(x + tremor, y - tremor);
  }
  return { ax, ay, lx, ly, align: right ? 'left' : 'right', leader };
}

export interface TradeoffPoint {
  id: string;
  label: string;
  /** Total length against the minimum spanning tree's. */
  cost: number;
  /** Share of links that can fail alone without cutting anything off, 0 to 1. */
  robust: number;
}

export interface TradeoffLayout {
  width: number;
  height: number;
  /** The plot area. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Cost ticks along the bottom, with their x. */
  ticks: { value: number; x: number }[];
  points: (TradeoffPoint & { x: number; y: number; lx: number; ly: number; anchor: 'start' | 'end' })[];
}

/**
 * Lays out the cost-against-resilience figure in a `width` × `height` box: cost along the
 * bottom from 0.8× to a whole or half multiple past the costliest network, robustness up the
 * side from 0 to 100%. Labels sit right of their point, or left near the right edge; in the
 * lower half they sit above it. They step apart when two would overlap.
 */
export function tradeoffLayout(points: readonly TradeoffPoint[], width: number, height: number): TradeoffLayout {
  const x0 = 34, x1 = width - 10, y0 = 10, y1 = height - 26;
  const finite = points.filter((p) => Number.isFinite(p.cost) && Number.isFinite(p.robust));
  const top = Math.max(2, ...finite.map((p) => p.cost));
  const max = Math.ceil(top * 1.08 * 2) / 2;
  const min = 0.8;
  const X = (c: number) => x0 + ((c - min) / (max - min)) * (x1 - x0);
  const Y = (r: number) => y1 - r * (y1 - y0);
  const step = max - min > 3 ? 1 : 0.5;
  const ticks: TradeoffLayout['ticks'] = [];
  for (let v = 1; v <= max + 1e-9; v += step) ticks.push({ value: Math.round(v * 10) / 10, x: X(v) });
  const placed: TradeoffLayout['points'] = [];
  const marks = finite.map((p) => ({ x: X(Math.max(min, p.cost)), y: Y(Math.min(1, Math.max(0, p.robust))) }));
  for (const p of finite) {
    const x = X(Math.max(min, p.cost)), y = Y(Math.min(1, Math.max(0, p.robust)));
    let anchor: 'start' | 'end' = x > x0 + (x1 - x0) * 0.62 ? 'end' : 'start';
    // Labels in the lower half sit above their point and step up; the rest sit level and step down.
    const dir = y > (y0 + y1) / 2 ? -1 : 1;
    let ly = dir < 0 ? y - 6 : y + 3.5;
    // Labels are about 5.2 px a character (10.5 px italic serif); two clash when their spans
    // overlap on the same line, or when a label would run over another network's point.
    const span = (l: number, a: 'start' | 'end', text: string): [number, number] => (a === 'start' ? [l, l + text.length * 5.2] : [l - text.length * 5.2, l]);
    const at = (a: 'start' | 'end') => (a === 'start' ? x + 7 : x - 7);
    const clash = (a: 'start' | 'end', yy: number) => {
      const [s0, s1] = span(at(a), a, p.label);
      if (s0 < x0 - 30 || s1 > x1 + 8) return true;
      return (
        placed.some((q) => {
          const [q0, q1] = span(q.lx, q.anchor, q.label);
          return Math.abs(q.ly - yy) < 11 && s0 < q1 + 4 && q0 < s1 + 4;
        }) || marks.some((m) => (m.x !== x || m.y !== y) && m.x > s0 - 5 && m.x < s1 + 5 && Math.abs(m.y - (yy - 3.5)) < 8)
      );
    };
    const fit = (yy: number) => Math.min(y1 - 2, Math.max(y0 + 8, yy));
    // Try the other side of the point before stepping off its line.
    if (clash(anchor, fit(ly)) && !clash(anchor === 'start' ? 'end' : 'start', fit(ly))) anchor = anchor === 'start' ? 'end' : 'start';
    for (let tries = 0; tries < 6 && clash(anchor, fit(ly)); tries++) ly += 11 * dir;
    const lx = at(anchor);
    placed.push({ ...p, x, y, lx, ly: Math.min(y1 - 2, Math.max(y0 + 8, ly)), anchor });
  }
  return { width, height, x0, x1, y0, y1, ticks, points: placed };
}
