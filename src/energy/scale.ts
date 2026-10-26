/**
 * The Ballpark axis and its arithmetic: a fixed log scale from 0.1 Wh to 10 GWh, unit
 * formatting, scoring by orders of magnitude, and equivalences against the anchor ladder.
 */
import { ANCHORS, anchorWh, type Anchor } from './catalog';

/** log10 of the axis ends, in Wh: 0.1 Wh … 10 GWh. */
export const AXIS_MIN = -1;
export const AXIS_MAX = 10;
export const AXIS_SPAN = AXIS_MAX - AXIS_MIN;

/** Axis position in [0, 1] for an energy in Wh (clamped). */
export function whToPos(wh: number): number {
  const p = (Math.log10(Math.max(wh, 1e-12)) - AXIS_MIN) / AXIS_SPAN;
  return Math.min(1, Math.max(0, p));
}

/** Energy in Wh for an axis position in [0, 1]. */
export function posToWh(pos: number): number {
  const p = Math.min(1, Math.max(0, pos));
  return 10 ** (AXIS_MIN + p * AXIS_SPAN);
}

const UNITS = [
  { name: 'GWh', scale: 1e9 },
  { name: 'MWh', scale: 1e6 },
  { name: 'kWh', scale: 1e3 },
  { name: 'Wh', scale: 1 },
];

/** Round to `sig` significant figures. */
export function roundSig(x: number, sig: number): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  const p = sig - 1 - Math.floor(Math.log10(Math.abs(x)));
  const f = 10 ** p;
  return Math.round(x * f) / f;
}

/** Fixed-decimal string with exactly `sig` significant figures (never exponential). */
function sigString(x: number, sig: number): string {
  if (x === 0) return '0';
  const decimals = Math.max(0, sig - 1 - Math.floor(Math.log10(Math.abs(x))));
  return x.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** "130 Wh", "1.0 kWh", "33.7 kWh" (sig = 3). Rounds first, so 999 Wh becomes "1.0 kWh". */
export function formatEnergy(wh: number, sig = 2): { value: string; unit: string; text: string } {
  const rounded = roundSig(wh, sig);
  const unit = UNITS.find((u) => rounded >= u.scale) ?? UNITS[UNITS.length - 1];
  const value = sigString(roundSig(rounded / unit.scale, sig), sig);
  return { value, unit: unit.name, text: `${value} ${unit.name}` };
}

/** "5 min", "8 h", "1 day", "2 weeks", "1 month", "1 year". */
export function formatHours(hours: number): string {
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  if (hours >= 8760 && hours % 8760 === 0) return plural(hours / 8760, 'year');
  if (hours >= 730 && hours % 730 === 0) return plural(hours / 730, 'month');
  if (hours >= 168 && hours % 168 === 0) return plural(hours / 168, 'week');
  if (hours >= 24 && hours % 24 === 0) return plural(hours / 24, 'day');
  if (hours >= 1) return `${roundSig(hours, 3)} h`;
  return `${Math.round(hours * 60)} min`;
}

/** "1,500 W", "3 MW". */
export function formatWatts(watts: number): string {
  if (watts >= 1e6) return `${roundSig(watts / 1e6, 3).toLocaleString('en-US')} MW`;
  return `${roundSig(watts, 3).toLocaleString('en-US')} W`;
}

/** A count for prose: "2.5", "28", "1,200". */
export function formatCount(n: number): string {
  if (n >= 1000) return roundSig(n, 2).toLocaleString('en-US');
  if (n >= 10) return Math.round(n).toLocaleString('en-US');
  return roundSig(n, 2).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Signed error in decades: log10(guess / truth). Positive means the guess was high. */
export function signedDecades(guess: number, truth: number): number {
  return Math.log10(guess / truth);
}

/** Unsigned error in decades (orders of magnitude). */
export function errorDecades(guess: number, truth: number): number {
  return Math.abs(signedDecades(guess, truth));
}

/** 100 for a perfect guess, 0 at one order of magnitude off or worse. */
export function points(e: number): number {
  return Math.round(100 * Math.max(0, 1 - e));
}

/** Within ×2 counts as knowing it (moves the Leitner box up). */
export const LEARNED_DECADES = 0.3;

export const TIERS = [
  { max: 0.1, label: 'Bullseye' },
  { max: LEARNED_DECADES, label: 'Ballpark' },
  { max: 0.6, label: 'Close-ish' },
  { max: 1, label: 'Off by ~10×' },
  { max: Infinity, label: 'Different planet' },
] as const;

export function tier(e: number): string {
  return TIERS.find((t) => e <= t.max)!.label;
}

/** "×2.4 high", "×12 low", "spot on". */
export function factorText(guess: number, truth: number): string {
  const s = signedDecades(guess, truth);
  if (Math.abs(s) < 0.02) return 'spot on';
  return `×${formatCount(10 ** Math.abs(s))} ${s > 0 ? 'high' : 'low'}`;
}

const ANCHOR_WH = ANCHORS.map((a) => ({ anchor: a, wh: anchorWh(a) })).sort((a, b) => a.wh - b.wh);

/**
 * Express an energy in the nearest anchor at or below it: "≈ 28 phone charges". Below the
 * smallest anchor, use that one as a fraction.
 */
export function equivalence(wh: number, anchors: Anchor[] = ANCHORS): { anchor: Anchor; count: number; text: string } {
  const pool = ANCHOR_WH.filter((a) => anchors.includes(a.anchor));
  const list = pool.length ? pool : ANCHOR_WH;
  const pick = [...list].reverse().find((a) => a.wh <= wh * 1.0001) ?? list[0];
  const count = wh / pick.wh;
  const shown = formatCount(count);
  return { anchor: pick.anchor, count, text: `≈ ${shown} ${shown === '1' ? pick.anchor.one : pick.anchor.many}` };
}

/** Decade ticks on the axis: [{ wh, label, major }]; major ticks carry a unit. */
export function decadeTicks(): { wh: number; pos: number; label: string; major: boolean }[] {
  const ticks = [];
  for (let d = AXIS_MIN; d <= AXIS_MAX; d++) {
    const wh = 10 ** d;
    const major = d % 3 === 0;
    const f = formatEnergy(wh, 1);
    ticks.push({ wh, pos: whToPos(wh), label: major ? f.text : f.value, major });
  }
  return ticks;
}
