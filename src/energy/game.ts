/**
 * BallparkGame: one run of 10 rounds. guessing → revealed → guessing … → summary.
 * DOM-free; `src/energy/main.ts` drives it and persists `progress`.
 */
import { ANCHORS, lineWh, type Line } from './catalog';
import { errorDecades, points, signedDecades } from './scale';
import {
  ROUNDS_PER_RUN,
  applyResult,
  emptyProgress,
  isLearned,
  makeScenario,
  mulberry32,
  scenarioWh,
  type Progress,
  type Rng,
  type Scenario,
} from './rounds';

export type Phase = 'guessing' | 'revealed' | 'summary';

export interface RoundResult {
  scenario: Scenario;
  guess: number;
  truth: number;
  /** Error in decades. */
  e: number;
  points: number;
  /** Each line's energy, in Wh, in scenario order. */
  parts: number[];
  /** True when this round turned an anchor into a learned one. */
  learnedAnchor?: string;
}

export interface RunSummary {
  total: number;
  max: number;
  /** Geometric-mean factor off: 10^(mean error in decades). */
  meanFactor: number;
  /** Mean signed decades for truths under 1 kWh and at or over 1 kWh (null with no rounds). */
  biasSmall: number | null;
  biasBig: number | null;
  best: number;
  newBest: boolean;
}

/** 1 kWh splits "small" from "big" for the bias readout. */
export const BIG_WH = 1000;

export class BallparkGame {
  progress: Progress;
  phase: Phase = 'guessing';
  round = 0;
  scenario!: Scenario;
  results: RoundResult[] = [];
  private rng: Rng;
  private used = new Set<string>();
  private bestBefore = 0;

  constructor(progress: Progress = emptyProgress(), seed = Date.now()) {
    this.progress = progress;
    this.rng = mulberry32(seed);
    this.start();
  }

  /** Start a new run (keeps progress). */
  start() {
    this.phase = 'guessing';
    this.round = 0;
    this.results = [];
    this.used.clear();
    this.bestBefore = this.progress.best;
    this.deal();
  }

  private deal() {
    this.scenario = makeScenario(this.rng, this.progress, this.round, this.used);
    for (const l of this.scenario.lines) this.used.add(l.itemId);
  }

  get truth(): number {
    return scenarioWh(this.scenario);
  }

  get score(): number {
    return this.results.reduce((s, r) => s + r.points, 0);
  }

  /** Lock in a guess (Wh). Only valid while guessing. */
  guess(wh: number): RoundResult {
    if (this.phase !== 'guessing') throw new Error(`Cannot guess while ${this.phase}`);
    const truth = this.truth;
    const e = errorDecades(wh, truth);
    const anchorId = this.scenario.anchorId;
    const wasLearned = anchorId ? isLearned(this.progress, anchorId) : false;
    this.progress = applyResult(this.progress, this.scenario, e);
    const result: RoundResult = {
      scenario: this.scenario,
      guess: wh,
      truth,
      e,
      points: points(e),
      parts: this.scenario.lines.map((l: Line) => lineWh(l)),
      learnedAnchor: anchorId && !wasLearned && isLearned(this.progress, anchorId) ? anchorId : undefined,
    };
    this.results.push(result);
    this.phase = 'revealed';
    if (this.results.length === ROUNDS_PER_RUN) {
      this.progress = {
        ...this.progress,
        runs: this.progress.runs + 1,
        best: Math.max(this.progress.best, this.score),
      };
    }
    return result;
  }

  /** Move on from a reveal: the next round, or the summary after the last one. */
  next() {
    if (this.phase !== 'revealed') return;
    if (this.results.length >= ROUNDS_PER_RUN) {
      this.phase = 'summary';
      return;
    }
    this.round++;
    this.phase = 'guessing';
    this.deal();
  }

  summary(): RunSummary {
    return summarize(this.results, this.progress.best, this.bestBefore);
  }
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarize(results: RoundResult[], best: number, bestBefore: number): RunSummary {
  const total = results.reduce((s, r) => s + r.points, 0);
  const meanE = mean(results.map((r) => r.e)) ?? 0;
  const signed = (rs: RoundResult[]) => mean(rs.map((r) => signedDecades(r.guess, r.truth)));
  return {
    total,
    max: results.length * 100,
    meanFactor: 10 ** meanE,
    biasSmall: signed(results.filter((r) => r.truth < BIG_WH)),
    biasBig: signed(results.filter((r) => r.truth >= BIG_WH)),
    best: Math.max(best, total),
    newBest: total > bestBefore,
  };
}

/** "You guess ×2.1 low on big things." or null when within ×1.4 either way. */
export function biasText(bias: number | null, which: 'small' | 'big'): string | null {
  if (bias === null || Math.abs(bias) < 0.15) return null;
  const f = 10 ** Math.abs(bias);
  const shown = f >= 10 ? Math.round(f).toLocaleString('en-US') : f.toFixed(1);
  return `You guess ×${shown} ${bias > 0 ? 'high' : 'low'} on ${which === 'small' ? 'small things (under 1 kWh)' : 'big things (1 kWh and up)'}.`;
}

const STORAGE_VERSION = 1;

export function serializeProgress(p: Progress): string {
  return JSON.stringify({ v: STORAGE_VERSION, ...p });
}

const isCountMap = (x: unknown): x is Record<string, number> =>
  !!x && typeof x === 'object' && Object.values(x).every((v) => typeof v === 'number' && Number.isFinite(v));

/** Parse stored progress; anything malformed or from another version starts fresh. */
export function parseProgress(raw: string | null): Progress {
  if (!raw) return emptyProgress();
  try {
    const d = JSON.parse(raw);
    if (!d || d.v !== STORAGE_VERSION || !isCountMap(d.boxes) || !isCountMap(d.anchorHits)) return emptyProgress();
    const known = new Set(ANCHORS.map((a) => a.id));
    const anchorHits = Object.fromEntries(Object.entries(d.anchorHits as Record<string, number>).filter(([k]) => known.has(k)));
    return {
      boxes: d.boxes,
      anchorHits,
      best: typeof d.best === 'number' ? d.best : 0,
      runs: typeof d.runs === 'number' ? d.runs : 0,
    };
  } catch {
    return emptyProgress();
  }
}
