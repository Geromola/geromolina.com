import { describe, expect, it } from 'vitest';
import { GridSim, meterReading, PLANT_POWER, type SimNode } from '../src/grid/sim';

const nodes: SimNode[] = [
  { kind: 'plant', col: 2, row: 2 },
  { kind: 'plant', col: 12, row: 3 },
  { kind: 'section', col: 4, row: 8 },
  { kind: 'section', col: 14, row: 8 },
  { kind: 'substation', col: 9, row: 6 },
];

const make = (count = 1500) => new GridSim({ cols: 16, rows: 10, nodes, count, seed: 42 });

function run(sim: GridSim, seconds: number, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) sim.step(dt);
}

describe('meter', () => {
  it('conserves power across the transformer', () => {
    for (const mode of ['up', 'down'] as const) {
      for (const s of [0, 0.25, 0.5, 1]) {
        const { power } = meterReading(mode, s);
        expect(Math.abs(power - PLANT_POWER) / PLANT_POWER).toBeLessThan(0.01);
      }
    }
    expect(meterReading('up', 1).voltage).toBeCloseTo(345_000, -2);
    expect(meterReading('down', 1).voltage).toBeCloseTo(480, 0);
  });
});

describe('transformer field', () => {
  it('step-up makes nearby electrons brighter and slower', () => {
    const sim = make();
    sim.pointer = { x: 8, y: 5 };
    sim.mode = 'up';
    run(sim, 2);
    let inB = 0, inK = 0, inN = 0, outB = 0, outK = 0, outN = 0;
    for (let i = 0; i < sim.count; i++) {
      if (sim.ambient[i] === 0) continue;
      const d = Math.hypot(sim.x[i] - 8, sim.y[i] - 5);
      if (d < 1) { inB += sim.bright[i]; inK += sim.k[i]; inN++; }
      else if (d > 4) { outB += sim.bright[i]; outK += sim.k[i]; outN++; }
    }
    expect(inN).toBeGreaterThan(5);
    expect(inB / inN).toBeGreaterThan((outB / outN) * 1.5);
    // speed ∝ 1/k, so higher k inside means slower drift
    expect(inK / inN).toBeGreaterThan(1.5);
    expect(outK / outN).toBeLessThan(1.1);
  });

  it('step-down makes nearby electrons dimmer and amber', () => {
    const sim = make();
    sim.pointer = { x: 8, y: 5 };
    sim.mode = 'down';
    run(sim, 2);
    const near = [...sim.k.keys()].filter((i) => Math.hypot(sim.x[i] - 8, sim.y[i] - 5) < 1.4);
    expect(near.length).toBeGreaterThan(5);
    const meanK = near.reduce((a, i) => a + sim.k[i], 0) / near.length;
    const meanHue = near.reduce((a, i) => a + sim.hue[i], 0) / near.length;
    expect(meanK).toBeLessThan(0.7);
    expect(meanHue).toBeLessThan(-0.3);
  });
});

describe('AC', () => {
  it('has ~zero net drift over a full period once settled', () => {
    const sim = make(400);
    sim.setAC(true);
    run(sim, 6); // let drift spring settle to 0
    const before = Float32Array.from(sim.x);
    const beforeY = Float32Array.from(sim.y);
    run(sim, 1 / 1.5, 1 / 600); // one visual AC period
    let total = 0;
    for (let i = 0; i < sim.count; i++) total += Math.hypot(sim.x[i] - before[i], sim.y[i] - beforeY[i]);
    expect(total / sim.count).toBeLessThan(0.02);
  });
});

describe('routing', () => {
  it('hovering a node pulls flow toward it', () => {
    const base = make();
    run(base, 8);
    const hovered = make();
    hovered.hover = 3;
    run(hovered, 8);
    expect(hovered.absorbed[3]).toBeGreaterThan(base.absorbed[3] * 2);
  });
});
