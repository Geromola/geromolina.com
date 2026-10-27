/**
 * Raup's coiling model (Raup 1966, "Geometric analysis of shell coiling"). A shell is one
 * circular tube, the generating curve, that grows as it turns around a fixed axis. Three
 * numbers decide its form:
 *
 * - W, whorl expansion rate: how much the tube grows in one turn.
 * - D, distance from the axis: inner edge ÷ outer edge of the generating curve.
 * - T, translation rate: how far the tube slides down the axis, per unit of distance from it.
 *
 * Coordinates: the coiling axis is z, the spire points up (+z), the aperture sits at θ = 0
 * with radius 1, and earlier growth is θ < 0.
 */

export interface ShellParams {
  W: number;
  D: number;
  T: number;
}

export type ParamKey = keyof ShellParams;

export const W_MIN = 1.01;
export const W_MAX = 1e6;
export const LOG_W_MIN = Math.log10(W_MIN);
export const LOG_W_MAX = 6;
export const D_MAX = 0.95;
export const T_MAX = 4;

/** Largest size ratio between the aperture and the oldest tube we draw. */
export const SIZE_RANGE = 1e3;
export const MAX_WHORLS = 8;

const TAU = Math.PI * 2;

export const clampParams = (p: ShellParams): ShellParams => ({
  W: Math.min(W_MAX, Math.max(W_MIN, p.W)),
  D: Math.min(D_MAX, Math.max(0, p.D)),
  T: Math.min(T_MAX, Math.max(0, p.T)),
});

/** Turns of tube drawn behind the aperture: up to 8, and fewer than one when W ≥ 10³. */
export function whorlCount(W: number): number {
  return Math.min(MAX_WHORLS, Math.log(SIZE_RANGE) / Math.log(Math.max(W_MIN, W)));
}

/** θ at the oldest drawn tube (negative); the aperture is at θ = 0. */
export const thetaMin = (W: number) => -TAU * whorlCount(W);

/** Generating-curve radius at θ. */
export const apertureRadius = (W: number, theta: number) => Math.pow(W, theta / TAU);

/** Distance of the generating curve's centre from the axis, for aperture radius `a`. */
export const centreDistance = (a: number, D: number) => (a * (1 + D)) / (1 - D);

/** Centre of the generating curve at θ: [x, y, z]. */
export function centre(p: ShellParams, theta: number): [number, number, number] {
  const a = apertureRadius(p.W, theta);
  const rc = centreDistance(a, p.D);
  return [rc * Math.cos(theta), rc * Math.sin(theta), -p.T * rc];
}

/**
 * A point on the shell surface. φ runs around the generating curve, which lies in the plane
 * containing the axis: φ = 0 is the outer edge, φ = π the inner edge, φ = π/2 the top.
 */
export function surfacePoint(p: ShellParams, theta: number, phi: number): [number, number, number] {
  const a = apertureRadius(p.W, theta);
  const rc = centreDistance(a, p.D);
  const r = rc + a * Math.cos(phi);
  return [r * Math.cos(theta), r * Math.sin(theta), -p.T * rc + a * Math.sin(phi)];
}

/**
 * Do successive whorls touch or overlap? Compare the generating circle with the one a turn
 * later, in the same plane: centres (W − 1)·rc·√(1 + T²) apart, radii a and W·a. At T = 0
 * this is Raup's hyperbola, W·D < 1.
 */
export function whorlsTouch(p: ShellParams): boolean {
  const gap = (p.W - 1) * ((1 + p.D) / (1 - p.D)) * Math.hypot(1, p.T);
  return gap < p.W + 1;
}

/** The D below which whorls touch, for a given W and T (Raup's 1/W when T = 0). */
export function touchBoundaryD(W: number, T: number): number {
  const k = (W + 1) / ((W - 1) * Math.hypot(1, T));
  return k <= 1 ? 0 : (k - 1) / (k + 1);
}

// ------------------------------------------------------------- regions

export interface Region {
  id: 'cephalopods' | 'gastropods' | 'bivalves' | 'brachiopods';
  name: string;
  examples: string;
  /** Box in (log10 W, D, T). */
  logW: [number, number];
  D: [number, number];
  T: [number, number];
}

/**
 * Where real shells live in the cube. Approximate boxes after the regions in Raup (1966) as
 * the textbooks reproduce them; the page says so. Brachiopods come before bivalves, which
 * they overlap, because their box is the narrower one.
 */
export const REGIONS: readonly Region[] = [
  { id: 'cephalopods', name: 'Coiled cephalopods', examples: 'ammonites, nautilus', logW: [0.2, 0.7], D: [0, 0.6], T: [0, 0.15] },
  { id: 'gastropods', name: 'Snails', examples: 'gastropods', logW: [0.05, 1], D: [0, 0.5], T: [0.3, 4] },
  { id: 'brachiopods', name: 'Brachiopods', examples: 'lamp shells', logW: [1.5, 5.5], D: [0, 0.1], T: [0, 0.1] },
  { id: 'bivalves', name: 'Bivalves', examples: 'clams, cockles', logW: [1, 4], D: [0, 0.5], T: [0, 0.6] },
];

const within = (v: number, [lo, hi]: [number, number]) => v >= lo && v <= hi;

export const inRegion = (r: Region, p: ShellParams) =>
  within(Math.log10(p.W), r.logW) && within(p.D, r.D) && within(p.T, r.T);

/** The region a shell falls in, or null for empty morphospace. */
export const classify = (p: ShellParams): Region | null => REGIONS.find((r) => inRegion(r, p)) ?? null;

// ------------------------------------------------------------- presets

export interface Preset extends ShellParams {
  id: string;
  name: string;
  region: Region['id'];
}

export const PRESETS: readonly Preset[] = [
  { id: 'nautilus', name: 'Nautilus', W: 3, D: 0, T: 0, region: 'cephalopods' },
  { id: 'ammonite', name: 'Ammonite', W: 2, D: 0.4, T: 0, region: 'cephalopods' },
  { id: 'spirula', name: 'Spirula', W: 2, D: 0.55, T: 0, region: 'cephalopods' },
  { id: 'turritella', name: 'Turritella', W: 1.25, D: 0.05, T: 3.5, region: 'gastropods' },
  { id: 'snail', name: 'Garden snail', W: 2.2, D: 0.1, T: 1.2, region: 'gastropods' },
  { id: 'clam', name: 'Clam', W: 300, D: 0.1, T: 0.25, region: 'bivalves' },
  { id: 'brachiopod', name: 'Brachiopod', W: 1e5, D: 0, T: 0, region: 'brachiopods' },
];

// ------------------------------------------------------------- slider scales

/** Each control's 0..1 track position. W is logarithmic. */
export function toPos(key: ParamKey, v: number): number {
  if (key === 'W') return (Math.log10(v) - LOG_W_MIN) / (LOG_W_MAX - LOG_W_MIN);
  return v / (key === 'D' ? D_MAX : T_MAX);
}

export function fromPos(key: ParamKey, pos: number): number {
  const t = Math.min(1, Math.max(0, pos));
  if (key === 'W') return Math.pow(10, LOG_W_MIN + t * (LOG_W_MAX - LOG_W_MIN));
  return t * (key === 'D' ? D_MAX : T_MAX);
}

const SUPERSCRIPT = '⁰¹²³⁴⁵⁶';

export interface Tick {
  pos: number;
  label: string;
}

export function ticks(key: ParamKey): Tick[] {
  if (key === 'W') {
    return [0, 1, 2, 3, 4, 5, 6].map((e) => ({
      pos: toPos('W', Math.max(W_MIN, 10 ** e)),
      label: e === 0 ? '1' : e === 1 ? '10' : `10${SUPERSCRIPT[e]}`,
    }));
  }
  const values = key === 'D' ? [0, 0.25, 0.5, 0.75] : [0, 1, 2, 3, 4];
  return values.map((v) => ({ pos: toPos(key, v), label: String(v) }));
}

/** Readouts: "2.00", "300", "12,000", "1.0 M"; D and T to two decimals. */
export function formatParam(key: ParamKey, v: number): string {
  if (key !== 'W') return v.toFixed(2);
  if (v < 10) return v.toFixed(2);
  if (v < 1e3) return Math.round(v).toString();
  if (v < 1e6 - 0.5e4) return Number(v.toPrecision(2)).toLocaleString('en-US');
  return '1,000,000';
}

// ------------------------------------------------------------- hash state

export function serializeParams(p: ShellParams): string {
  const w = p.W < 10 ? p.W.toFixed(2) : String(Number(p.W.toPrecision(3)));
  return `W=${w}&D=${p.D.toFixed(2)}&T=${p.T.toFixed(2)}`;
}

/** Reads `#W=2&D=0.1&T=1.5`; null unless all three are numbers. Values are clamped. */
export function parseParams(hash: string): ShellParams | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const [W, D, T] = (['W', 'D', 'T'] as const).map((k) => Number.parseFloat(q.get(k) ?? ''));
  if (![W, D, T].every(Number.isFinite)) return null;
  return clampParams({ W, D, T });
}
