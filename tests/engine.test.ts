import { describe, expect, it } from 'vitest';
import { GridGame, starsFor } from '../src/grid/game/engine';
import { layoutGame } from '../src/grid/game/layout';
import { LEVELS, type LevelDef } from '../src/grid/game/levels';
import { HIGH, LOSS_HIGH, LOSS_LOW, LOW, SEG_COST, T_COST } from '../src/grid/game/physics';
import { solve } from '../src/grid/game/solver';
import { LAYOUTS, NODES } from './fixtures/nodes';

function run(game: GridGame, seconds: number, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) game.step(dt);
}

const forLayout = (w: number, h: number, count = 600) => GridGame.fromLayout(layoutGame(NODES, w, h), { count, seed: 7 });

/** A straight 20 × 7 board: plant at (1, 3), load at (18, 3). */
function corridor(count = 800) {
  const levels: LevelDef[] = [{ title: 'Corridor', plants: ['p'], loads: ['l'], budget: 2 }];
  return new GridGame({
    cols: 20,
    rows: 7,
    nodes: [
      { id: 'p', kind: 'plant', col: 1, row: 3 },
      { id: 'l', kind: 'section', col: 18, row: 3 },
    ],
    levels,
    count,
    ambientFraction: 0.35,
    seed: 3,
  });
}

/** Follow the cheapest next state from (plant, LOW) along a cost table. */
function cheapestPath(game: GridGame, table: Float64Array, start: number, goal: number) {
  const { board } = game;
  const path: { v: number; level: number }[] = [{ v: start, level: LOW }];
  let v = start;
  let lv = LOW;
  let prev = -1;
  for (let guard = 0; v !== goal && guard < 200; guard++) {
    let best = Infinity;
    let next = -1;
    let nextLv = lv;
    for (let k = 0; k < 4; k++) {
      const n = board.nbrV[v * 4 + k];
      if (n < 0 || n === prev || game.faulted[board.nbrE[v * 4 + k]]) continue;
      const t = game.isTransformer[n];
      const ln = t ? 1 - lv : lv;
      const c = SEG_COST[lv] + (t ? T_COST : 0) + table[n * 2 + ln];
      if (c < best) {
        best = c;
        next = n;
        nextLv = ln;
      }
    }
    prev = v;
    v = next;
    lv = nextLv;
    path.push({ v, level: lv });
  }
  return path;
}

describe('physics', () => {
  it('HIGH loss is LOW loss / 625 (I²R at 25× less current)', () => {
    expect(LOSS_HIGH).toBe(LOSS_LOW / 625);
    expect(SEG_COST[HIGH]).toBeCloseTo(-Math.log(1 - LOSS_LOW / 625), 15);
  });

  it('stars follow the thresholds', () => {
    expect(starsFor(false, 1, 0.9)).toBe(0);
    expect(starsFor(true, 0.9, 0.9)).toBe(3);
    expect(starsFor(true, 0.9 * 0.985, 0.9)).toBe(3);
    expect(starsFor(true, 0.9 * 0.95, 0.9)).toBe(2);
    expect(starsFor(true, 0.9 * 0.93, 0.9)).toBe(2);
    expect(starsFor(true, 0.9 * 0.9, 0.9)).toBe(1);
  });
});

describe('routing', () => {
  it('takes the HV corridor between a step-up and a step-down, beating the empty board', () => {
    const game = corridor();
    const empty = game.evaluate();
    expect(empty.efficiency).toBeCloseTo(Math.pow(1 - LOSS_LOW, 17), 6);
    expect(empty.won).toBe(false);

    expect(game.placeTransformer(2, 3)).toBe(true);
    expect(game.placeTransformer(17, 3)).toBe(true);
    const ev = game.evaluate();
    expect(ev.efficiency).toBeGreaterThan(empty.efficiency + 0.3);
    expect(ev.won).toBe(true);
    expect(ev.stars).toBe(3);
    // Two LOW segments, two transformer passes, fifteen HIGH segments.
    expect(ev.efficiency).toBeCloseTo(Math.exp(-(2 * SEG_COST[LOW] + 2 * T_COST + 15 * SEG_COST[HIGH])), 9);

    // Cost tables: the cheapest path goes up at (2,3), rides HIGH, comes down at (17,3).
    const plant = game.board.vertex(1, 3);
    const load = game.board.vertex(18, 3);
    const path = cheapestPath(game, game.tables[0], plant, load);
    expect(path.at(-1)!.v).toBe(load);
    expect(path.at(-1)!.level).toBe(LOW);
    expect(path.map((p) => p.v)).toContain(game.board.vertex(2, 3));
    expect(path.map((p) => p.v)).toContain(game.board.vertex(17, 3));
    const high = path.filter((p) => p.level === HIGH);
    expect(high.length).toBeGreaterThanOrEqual(15);

    // Electrons: packets ride HIGH between the two transformers and get delivered.
    // HIGH drifts at half speed over a 15-segment corridor, so give them time.
    run(game, 45);
    let highN = 0;
    let inCorridor = 0;
    for (let i = 0; i < game.count; i++) {
      if (game.ambient[i] || game.volt[i] !== HIGH) continue;
      highN++;
      if (game.x[i] >= 2 && game.x[i] <= 17) inCorridor++;
      expect(game.hue[i]).toBe(1);
    }
    expect(highN).toBeGreaterThan(50);
    expect(inCorridor / highN).toBeGreaterThan(0.85);
    const k = game.nodeIndex('l');
    expect(game.delivered[k]).toBeGreaterThan(10);
    expect(game.sparked[k]).toBe(0);
    // Delivered packets keep most of their energy.
    expect(game.deliveredEnergy[k] / game.delivered[k]).toBeGreaterThan(0.6);
  });

  it('electrons deliver more energy per packet with the corridor than without', () => {
    const plain = corridor();
    run(plain, 45);
    const hv = corridor();
    hv.placeTransformer(2, 3);
    hv.placeTransformer(17, 3);
    run(hv, 45);
    const k = plain.nodeIndex('l');
    expect(plain.delivered[k]).toBeGreaterThan(0);
    expect(hv.delivered[k]).toBeGreaterThan(0);
    const perPlain = plain.deliveredEnergy[k] / plain.delivered[k];
    const perHv = hv.deliveredEnergy[k] / hv.delivered[k];
    expect(perHv).toBeGreaterThan(perPlain + 0.15);
    // The wasted energy shows up as heat on the conductors.
    const sumHeat = (g: GridGame) => g.heat.reduce((a, h) => a + h, 0);
    expect(sumHeat(plain)).toBeGreaterThan(sumHeat(hv));
  });

  it('arriving at HIGH is an overvoltage, not a delivery', () => {
    // Cost tables: a HIGH state next to the load can't step straight in; it has to
    // go round through the step-down first.
    const board = corridor(0);
    board.placeTransformer(17, 3);
    const t = board.tables[0];
    expect(t[board.board.vertex(18, 3) * 2 + HIGH]).toBe(Infinity);
    expect(t[board.board.vertex(18, 2) * 2 + HIGH]).toBeCloseTo(2 * SEG_COST[HIGH] + T_COST + SEG_COST[LOW], 12);

    // 4 × 1 line: plant, transformer, empty, load. Electrons (no immediate
    // reversal) reach the load at HIGH and spark.
    const levels: LevelDef[] = [{ title: 'Spark', plants: ['p'], loads: ['l'], budget: 1 }];
    const game = new GridGame({
      cols: 4,
      rows: 1,
      nodes: [
        { id: 'p', kind: 'plant', col: 0, row: 0 },
        { id: 'l', kind: 'section', col: 3, row: 0 },
      ],
      levels,
      count: 300,
      ambientFraction: 0,
      seed: 11,
    });
    expect(game.evaluate().efficiency).toBeCloseTo(Math.pow(1 - LOSS_LOW, 3), 9);
    expect(game.placeTransformer(1, 0)).toBe(true);
    const table = game.tables[0];
    expect(table[game.board.vertex(3, 0) * 2 + HIGH]).toBe(Infinity);
    // The only LOW arrival bounces back through the transformer (up, then down again).
    expect(table[game.board.vertex(0, 0) * 2 + LOW]).toBeCloseTo(3 * SEG_COST[LOW] + 2 * SEG_COST[HIGH] + 2 * T_COST, 12);

    run(game, 20);
    const k = game.nodeIndex('l');
    expect(game.delivered[k]).toBe(0);
    expect(game.sparked[k]).toBeGreaterThan(0);
  });

  it('removes faulted edges from routing', () => {
    const game = corridor();
    game.placeTransformer(2, 3);
    game.placeTransformer(17, 3);
    const before = game.evaluate().efficiency;
    // Cut every edge into the step-down's column except through (17, 3)... by cutting (16,3)–(17,3)
    // the HIGH packets must go around, which costs almost nothing at HIGH.
    const e = game.board.edgeBetween(game.board.vertex(16, 3), game.board.vertex(17, 3));
    game.faulted[e] = 1;
    game.reset();
    game.placeTransformer(2, 3);
    game.placeTransformer(17, 3);
    const path = cheapestPath(game, game.tables[0], game.board.vertex(1, 3), game.board.vertex(18, 3));
    for (let i = 1; i < path.length; i++) expect(game.board.edgeBetween(path[i - 1].v, path[i].v)).not.toBe(e);
    expect(game.evaluate().efficiency).toBeLessThan(before);
  });
});

describe('placement API', () => {
  it('validates, enforces the budget, moves and removes', () => {
    const game = forLayout(1440, 900);
    const about = game.nodes[game.nodeIndex('about')];
    expect(game.canPlace(about.col, about.row)).toBe(false); // node vertex
    expect(game.canPlace(0, 0)).toBe(false); // outside the visible area
    expect(game.canPlace(-1, 3)).toBe(false);
    expect(game.canPlace(2.5, 3)).toBe(false);
    expect(game.canPlace(2, 3)).toBe(true);

    expect(game.budget).toBe(2);
    expect(game.placeTransformer(2, 3)).toBe(true);
    expect(game.canPlace(2, 3)).toBe(false); // occupied
    expect(game.placeTransformer(2, 3)).toBe(false);
    expect(game.placeTransformer(3, 3)).toBe(true);
    expect(game.budgetLeft).toBe(0);
    expect(game.placeTransformer(4, 3)).toBe(false); // out of budget
    expect(game.transformers).toEqual([
      { col: 2, row: 3 },
      { col: 3, row: 3 },
    ]);

    expect(game.moveTransformer(2, 3, 3, 3)).toBe(false); // occupied target
    expect(game.moveTransformer(2, 3, about.col, about.row)).toBe(false); // node target
    expect(game.moveTransformer(2, 3, 2, 4)).toBe(true);
    expect(game.hasTransformer(2, 3)).toBe(false);
    expect(game.hasTransformer(2, 4)).toBe(true);
    expect(game.removeTransformer(2, 3)).toBe(false);
    expect(game.removeTransformer(2, 4)).toBe(true);
    expect(game.budgetLeft).toBe(1);
  });

  it('recomputes routing on every change', () => {
    const game = forLayout(1440, 900);
    const sol = game.solverPlacement;
    const empty = game.evaluate();
    for (const t of sol) game.placeTransformer(t.col, t.row);
    const won = game.evaluate();
    expect(won.won).toBe(true);
    expect(won.efficiency).toBeGreaterThan(empty.efficiency);
    expect(won.deliveredMW + won.lostMW).toBeCloseTo(50, 9);
    game.moveTransformer(sol[0].col, sol[0].row, 2, 3);
    expect(game.evaluate().won).toBe(false);
    game.moveTransformer(2, 3, sol[0].col, sol[0].row);
    expect(game.evaluate().efficiency).toBeCloseTo(won.efficiency, 12);
    game.reset();
    expect(game.evaluate().efficiency).toBeCloseTo(empty.efficiency, 12);
    expect(game.budgetLeft).toBe(game.budget);
  });
});

describe('levels on the reference layouts', () => {
  for (const [w, h] of LAYOUTS) {
    describe(`${w}×${h}`, () => {
      const game = forLayout(w, h, 200);
      LEVELS.forEach((def, i) => {
        it(`level ${i + 1} (${def.title}): solver wins within budget, empty board doesn't`, () => {
          game.setLevel(i);
          expect(game.budget).toBeLessThanOrEqual(4);
          const empty = game.evaluate();
          expect(empty.won).toBe(false);
          expect(empty.stars).toBe(0);

          const sol = game.solverPlacement;
          expect(sol.length).toBeLessThanOrEqual(def.budget);
          for (const t of sol) expect(game.placeTransformer(t.col, t.row)).toBe(true);
          const ev = game.evaluate();
          expect(ev.won).toBe(true);
          expect(ev.perLoad.every((l) => l.lit)).toBe(true);
          expect(ev.efficiency).toBeCloseTo(ev.best, 12);
          expect(ev.stars).toBe(3);
          expect(ev.deliveredMW + ev.lostMW).toBeCloseTo(50 * def.plants.length, 9);
        });
      });

      it('solver runs in under 50 ms on every level', () => {
        for (let i = 0; i < LEVELS.length; i++) {
          game.setLevel(i);
          const problem = game.solverProblem();
          solve(problem); // warm up the JIT
          let worst = 0;
          for (let k = 0; k < 3; k++) {
            const t0 = performance.now();
            const s = solve(problem);
            worst = Math.max(worst, performance.now() - t0);
            expect(s.won).toBe(true);
          }
          expect(worst).toBeLessThan(50);
        }
      });
    });
  }
});

describe('faults', () => {
  it('are deterministic per seed and never touch node vertices', () => {
    for (const [w, h] of LAYOUTS) {
      const a = forLayout(w, h, 50);
      const b = forLayout(w, h, 50);
      const fa = a.generateFaults(0.12, 1234);
      expect(b.generateFaults(0.12, 1234)).toEqual(fa);
      expect(a.generateFaults(0.12, 1235)).not.toEqual(fa);

      a.setLevel(3);
      b.setLevel(3);
      expect(a.faultSeed).not.toBeNull();
      expect(a.faultSeed).toBe(b.faultSeed);
      expect(Array.from(a.faulted)).toEqual(Array.from(b.faulted));

      const nodeVerts = new Set(a.nodes.map((n) => a.board.vertex(n.col, n.row)));
      let cut = 0;
      for (let e = 0; e < a.edgeCount; e++) {
        if (!a.faulted[e]) continue;
        cut++;
        const { c0, r0, c1, r1 } = a.edgeVertices(e);
        expect(nodeVerts.has(a.board.vertex(c0, r0))).toBe(false);
        expect(nodeVerts.has(a.board.vertex(c1, r1))).toBe(false);
      }
      // ~12% of the visible edges.
      const { minC, maxC, minR, maxR } = a.bounds;
      const visible = (maxC - minC) * (maxR - minR + 1) + (maxC - minC + 1) * (maxR - minR);
      expect(cut).toBe(Math.round(visible * 0.12));

      // Other levels have no faults.
      a.setLevel(0);
      expect(a.faulted.every((f) => f === 0)).toBe(true);
      expect(a.faultSeed).toBeNull();
    }
  });
});

describe('step', () => {
  it('runs 5 s of simulated time with finite outputs', () => {
    for (const [w, h] of LAYOUTS) {
      const game = forLayout(w, h, 1500);
      game.setLevel(3);
      for (const t of game.solverPlacement) game.placeTransformer(t.col, t.row);
      run(game, 5);
      const n = game.count;
      for (let i = 0; i < n; i++) {
        expect(Number.isFinite(game.x[i]) && Number.isFinite(game.y[i])).toBe(true);
        expect(Number.isFinite(game.bright[i]) && Number.isFinite(game.hue[i])).toBe(true);
        expect(game.x[i]).toBeGreaterThanOrEqual(0);
        expect(game.x[i]).toBeLessThanOrEqual(game.cols - 1);
        expect(game.y[i]).toBeGreaterThanOrEqual(0);
        expect(game.y[i]).toBeLessThanOrEqual(game.rows - 1);
        expect(game.bright[i]).toBeGreaterThanOrEqual(0);
        expect(game.hue[i]).toBeGreaterThanOrEqual(-1);
        expect(game.hue[i]).toBeLessThanOrEqual(1);
      }
      expect(game.heat.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
      expect(game.heat.some((v) => v > 0)).toBe(true);
      for (let e = 0; e < game.edgeCount; e++) if (game.faulted[e]) expect(game.heat[e]).toBe(0);
      const delivered = game.activeLoads.reduce((a, k) => a + game.delivered[k], 0);
      expect(delivered).toBeGreaterThan(0);
      // About 35% ambient.
      const ambient = game.ambient.reduce((a, v) => a + v, 0);
      expect(ambient / n).toBeCloseTo(0.35, 2);
    }
  });

  it('heat decays with τ ≈ 1 s once flow stops', () => {
    const game = corridor(400);
    run(game, 4);
    const e = game.heat.reduce((best, v, i, arr) => (v > arr[best] ? i : best), 0);
    const h0 = game.heat[e];
    expect(h0).toBeGreaterThan(0);
    // Freeze the flow: no electrons left to add heat.
    const still = new GridGame({ cols: 20, rows: 7, nodes: game.nodes, levels: game.levels, count: 0 });
    still.heat.set(game.heat);
    run(still, 1, 1 / 100);
    expect(still.heat[e] / h0).toBeCloseTo(Math.exp(-1), 2);
  });
});
