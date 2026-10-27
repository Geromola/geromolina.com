import { describe, expect, it } from 'vitest';
import { ANCHORS, ITEMS, anchorWh, lineWh } from '../src/energy/catalog';
import {
  AXIS_MAX,
  AXIS_MIN,
  decadeTicks,
  equivalence,
  errorDecades,
  factorText,
  formatEnergy,
  formatHours,
  points,
  posToWh,
  tier,
  whToPos,
} from '../src/energy/scale';
import {
  ROUNDS_PER_RUN,
  TRAP_ROUND,
  applyResult,
  emptyProgress,
  itemWeight,
  linesForRound,
  makeScenario,
  mulberry32,
  scenarioWh,
  trapPair,
} from '../src/energy/rounds';
import { BallparkGame, biasText, parseProgress, serializeProgress, summarize, type RoundResult } from '../src/energy/game';
import { getItem } from '../src/energy/catalog';

describe('scale', () => {
  it('maps energy to axis position and back', () => {
    for (const wh of [0.1, 0.3, 15, 1000, 33_700, 1.287e9, 1e10]) {
      expect(posToWh(whToPos(wh))).toBeCloseTo(wh, -Math.floor(Math.log10(wh)) + 6);
    }
    expect(whToPos(10 ** AXIS_MIN)).toBe(0);
    expect(whToPos(10 ** AXIS_MAX)).toBe(1);
    expect(whToPos(1e-6)).toBe(0);
    expect(whToPos(1e15)).toBe(1);
  });

  it('formats energy with units at the edges', () => {
    expect(formatEnergy(999).text).toBe('1.0 kWh');
    expect(formatEnergy(125).text).toBe('130 Wh');
    expect(formatEnergy(0.3).text).toBe('0.30 Wh');
    expect(formatEnergy(33_700, 3).text).toBe('33.7 kWh');
    expect(formatEnergy(1_287_000_000, 3).text).toBe('1.29 GWh');
    expect(formatEnergy(999_999).text).toBe('1.0 MWh');
    expect(formatEnergy(12_000).text).toBe('12 kWh');
    expect(formatEnergy(1e9, 1).text).toBe('1 GWh');
    expect(formatEnergy(90_000, 3, true).text).toBe('90 kWh');
    expect(formatEnergy(33_700, 3, true).text).toBe('33.7 kWh');
    expect(formatEnergy(1e6, 1).text).toBe('1 MWh');
  });

  it('labels every decade tick with its own unit', () => {
    const labels = decadeTicks().map((t) => t.label);
    expect(labels).toEqual(['0.1', '1 Wh', '10', '100', '1 kWh', '10', '100', '1 MWh', '10', '100', '1 GWh', '10']);
  });

  it('formats durations', () => {
    expect(formatHours(5 / 60)).toBe('5 min');
    expect(formatHours(8)).toBe('8 h');
    expect(formatHours(24)).toBe('1 day');
    expect(formatHours(168)).toBe('1 week');
    expect(formatHours(730)).toBe('1 month');
    expect(formatHours(8760)).toBe('1 year');
    expect(formatHours(40)).toBe('40 h');
  });

  it('scores by orders of magnitude', () => {
    expect(points(0)).toBe(100);
    expect(points(0.5)).toBe(50);
    expect(points(1)).toBe(0);
    expect(points(3)).toBe(0);
    expect(errorDecades(200, 100)).toBeCloseTo(Math.log10(2));
    expect(errorDecades(50, 100)).toBeCloseTo(Math.log10(2));
    expect(tier(0.05)).toBe('Bullseye');
    expect(tier(0.25)).toBe('Ballpark');
    expect(tier(Math.log10(2.01))).toBe('Ballpark');
    expect(tier(0.5)).toBe('Close-ish');
    expect(tier(0.9)).toBe('Off by ~10×');
    expect(tier(2)).toBe('Different planet');
  });

  it('describes the error as a factor', () => {
    expect(factorText(240, 100)).toBe('×2.4 high');
    expect(factorText(100, 1200)).toBe('×12 low');
    expect(factorText(101, 100)).toBe('spot on');
  });

  it('expresses energy in the nearest anchor below it', () => {
    expect(equivalence(420).text).toBe('≈ 7 laptop charges');
    expect(equivalence(15).text).toBe('≈ 1 phone charge');
    expect(equivalence(0.15).text).toBe('≈ 0.5 AI chat queries');
  });
});

describe('catalog', () => {
  it('gives every item a source, a fact and positive energy presets', () => {
    for (const item of ITEMS) {
      expect(item.source.url).toMatch(/^https:\/\//);
      expect(item.fact.length).toBeGreaterThan(10);
      if (item.kind === 'power') {
        expect(item.watts).toBeGreaterThan(0);
        expect(item.hours.length).toBeGreaterThan(0);
      } else {
        expect(item.whPer).toBeGreaterThan(0);
      }
    }
    expect(new Set(ITEMS.map((i) => i.id)).size).toBe(ITEMS.length);
  });

  it('computes line energy as power × time or count × unit', () => {
    expect(lineWh({ itemId: 'kettle', count: 1, hours: 5 / 60 })).toBeCloseTo(125);
    expect(lineWh({ itemId: 'led', count: 10, hours: 12 })).toBe(1080);
    expect(lineWh({ itemId: 'gasoline', count: 2 })).toBe(67_400);
  });

  it('orders the anchors smallest first and keeps them on the axis', () => {
    const whs = ANCHORS.map(anchorWh);
    expect([...whs].sort((a, b) => a - b)).toEqual(whs);
    for (const wh of whs) {
      expect(Math.log10(wh)).toBeGreaterThan(AXIS_MIN);
      expect(Math.log10(wh)).toBeLessThan(AXIS_MAX);
    }
    // The ladder spans the axis: from under 1 Wh to over 1 GWh.
    expect(whs[0]).toBeLessThan(1);
    expect(whs[whs.length - 1]).toBeGreaterThan(1e9);
  });
});

describe('rounds', () => {
  it('is deterministic per seed', () => {
    const a = makeScenario(mulberry32(42), emptyProgress(), 5);
    const b = makeScenario(mulberry32(42), emptyProgress(), 5);
    expect(a).toEqual(b);
  });

  it('follows the 1 / 2 / 3 line curve and keeps every total on the axis', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = mulberry32(seed);
      for (let round = 0; round < ROUNDS_PER_RUN; round++) {
        const s = makeScenario(rng, emptyProgress(), round);
        expect(s.lines.length).toBe(linesForRound(round));
        expect(new Set(s.lines.map((l) => l.itemId)).size).toBe(s.lines.length);
        const wh = scenarioWh(s);
        expect(wh).toBeCloseTo(s.lines.reduce((sum, l) => sum + lineWh(l), 0));
        expect(Math.log10(wh)).toBeGreaterThanOrEqual(AXIS_MIN);
        expect(Math.log10(wh)).toBeLessThanOrEqual(AXIS_MAX);
      }
    }
  });

  it('puts a trap in round 8: more power, less energy', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const [hot, cool] = trapPair(mulberry32(seed));
      const h = getItem(hot.itemId);
      const c = getItem(cool.itemId);
      if (h.kind !== 'power' || c.kind !== 'power') throw new Error('trap items must be power items');
      expect(h.watts).toBeGreaterThanOrEqual(10 * c.watts);
      expect(lineWh(cool)).toBeGreaterThan(lineWh(hot));
      const s = makeScenario(mulberry32(seed), emptyProgress(), TRAP_ROUND);
      expect(s.trap).toBe(true);
      expect(s.lines.length).toBe(3);
    }
  });

  it('moves Leitner boxes up on a hit and the dominant item to box 1 on a miss', () => {
    const s = { lines: [{ itemId: 'kettle', count: 1, hours: 5 / 60 }, { itemId: 'laptop', count: 1, hours: 8 }] };
    let p = applyResult(emptyProgress(), s, 0.1);
    expect(p.boxes).toEqual({ kettle: 2, laptop: 2 });
    p = applyResult(p, s, 0.1);
    expect(p.boxes.laptop).toBe(3);
    p = applyResult(p, s, 0.8);
    expect(p.boxes).toEqual({ kettle: 3, laptop: 1 });
    expect(itemWeight(p, 'kettle')).toBeLessThan(itemWeight(p, 'laptop'));
    for (let i = 0; i < 10; i++) p = applyResult(p, s, 0);
    expect(p.boxes.kettle).toBe(5);
  });

  it('counts anchor hits toward learning', () => {
    const s = { lines: [ANCHORS[1].line], anchorId: ANCHORS[1].id };
    let p = applyResult(emptyProgress(), s, 0.2);
    expect(p.anchorHits[ANCHORS[1].id]).toBe(1);
    p = applyResult(p, s, 0.9);
    expect(p.anchorHits[ANCHORS[1].id]).toBe(1);
  });
});

describe('game', () => {
  it('plays a full run and ends in a summary', () => {
    const g = new BallparkGame(emptyProgress(), 7);
    for (let i = 0; i < ROUNDS_PER_RUN; i++) {
      expect(g.phase).toBe('guessing');
      expect(g.round).toBe(i);
      const r = g.guess(g.truth * 2);
      expect(r.points).toBe(points(Math.log10(2)));
      expect(g.phase).toBe('revealed');
      expect(() => g.guess(1)).toThrow();
      g.next();
    }
    expect(g.phase).toBe('summary');
    const s = g.summary();
    expect(s.total).toBe(ROUNDS_PER_RUN * points(Math.log10(2)));
    expect(s.meanFactor).toBeCloseTo(2);
    expect(g.progress.runs).toBe(1);
    expect(g.progress.best).toBe(s.total);
    expect(s.newBest).toBe(true);
  });

  it('marks an anchor learned on its second hit', () => {
    const anchor = ANCHORS[0];
    const g = new BallparkGame({ ...emptyProgress(), anchorHits: { [anchor.id]: 1 } }, 1);
    g.scenario = { lines: [anchor.line], anchorId: anchor.id };
    expect(g.guess(g.truth).learnedAnchor).toBe(anchor.id);
  });

  it('measures bias and the geometric-mean factor', () => {
    const r = (guess: number, truth: number): RoundResult => ({
      scenario: { lines: [] },
      guess,
      truth,
      e: Math.abs(Math.log10(guess / truth)),
      points: 0,
      parts: [],
    });
    const s = summarize([r(10, 100), r(1000, 10_000), r(2, 1)], 0, 0);
    expect(s.biasBig).toBeCloseTo(-1);
    expect(s.biasSmall).toBeCloseTo((-1 + Math.log10(2)) / 2);
    expect(s.meanFactor).toBeCloseTo(10 ** ((1 + 1 + Math.log10(2)) / 3));
    expect(biasText(-1, 'big')).toBe('You guess ×10 low on big things (1 kWh and up).');
    expect(biasText(0.05, 'small')).toBeNull();
    expect(biasText(null, 'small')).toBeNull();
  });

  it('round-trips progress and rejects bad storage', () => {
    const p = { boxes: { kettle: 3 }, anchorHits: { phone: 2 }, best: 640, runs: 4 };
    expect(parseProgress(serializeProgress(p))).toEqual(p);
    expect(parseProgress(null)).toEqual(emptyProgress());
    expect(parseProgress('not json')).toEqual(emptyProgress());
    expect(parseProgress('{"v":99}')).toEqual(emptyProgress());
    expect(parseProgress(JSON.stringify({ v: 1, boxes: { a: 'x' }, anchorHits: {} }))).toEqual(emptyProgress());
  });
});
