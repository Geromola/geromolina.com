/**
 * "What shell is this?": the nearest real shell in the catalog, by distance in the cube. An
 * `Identifier` takes the shell's numbers and returns a match, so a model-based identifier can
 * replace the cache later without touching the page.
 */
import { CATALOG, type CatalogEntry } from './catalog';
import { classify, type ShellParams } from './model';

export type Tier = 'match' | 'resembles' | 'none';

export interface Identification {
  entry: CatalogEntry;
  /** Distance in cube units (about one just-noticeable change in shape each). */
  distance: number;
  tier: Tier;
  /** The next two closest shells. */
  runnersUp: CatalogEntry[];
}

export type Identifier = (p: ShellParams) => Identification;

/** One cube unit along each axis: a change you can just see in the render. */
export const SCALE = { logW: 0.4, D: 0.12, T: 0.5 };
export const MATCH_MAX = 1.5;
export const RESEMBLES_MAX = 4;

export function cubeDistance(a: ShellParams, b: ShellParams): number {
  return Math.hypot(
    (Math.log10(a.W) - Math.log10(b.W)) / SCALE.logW,
    (a.D - b.D) / SCALE.D,
    (a.T - b.T) / SCALE.T,
  );
}

export function tierFor(distance: number, p: ShellParams): Tier {
  if (distance <= MATCH_MAX) return 'match';
  // Inside one of Raup's regions a shell is plausible even far from our 16 examples.
  if (distance <= RESEMBLES_MAX || classify(p)) return 'resembles';
  return 'none';
}

export const identifyFromCache: Identifier = (p) => {
  const ranked = CATALOG.map((entry) => ({ entry, distance: cubeDistance(p, entry) })).sort(
    (a, b) => a.distance - b.distance,
  );
  const [best] = ranked;
  return {
    entry: best.entry,
    distance: best.distance,
    tier: tierFor(best.distance, p),
    runnersUp: ranked.slice(1, 3).map((r) => r.entry),
  };
};
