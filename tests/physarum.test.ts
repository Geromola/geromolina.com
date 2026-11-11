import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/energy/rounds';
import { AgentSim, PRESETS, attractField, lightGrid } from '../src/physarum/agents';
import { FlowNet } from '../src/physarum/flow';
import { CITIES, RAIL, kanto } from '../src/physarum/kanto';
import { bridgeCount, faultTolerance, meanFoodDistance, metrics, normalize, totalLength, type Network } from '../src/physarum/metrics';
import { delaunay, delaunayEdges, mst, mstEdges, steinerTree, type Point } from '../src/physarum/reference';
import { FlowRunner, type StateMsg } from '../src/physarum/runner';
import { REAL_SHUTTLE_SECONDS, SHUTTLE_SECONDS, WAVE_GROUPS, flakePoints, flakeShape, placeCallout, tradeoffLayout, waveGroup, waveSwell } from '../src/physarum/figures';
import { FILM, filmTubes, flowWeights, grow, growthAt, smoothAlong, startConductivity } from '../src/physarum/growth';
import { LEVELS, build, contract, emptyTrack, endAt, erase, measure, parseChallenge, record, score, serializeChallenge, trackNetwork, type Track } from '../src/physarum/challenge';
import { PROGRESS_KEY, TOUR, earn, maze, parseProgress, serializeProgress, stepIndex, type Reading } from '../src/physarum/tour';
import { decodeMask, emptyScene, encodeMask, isLit, lightPolygon, paintLight, sceneFromHash, sceneToHash, type Food } from '../src/physarum/scene';

const sceneWith = (foods: Food[]) => {
  const s = emptyScene();
  s.foods = foods;
  return s;
};

/** Every point along the network's links. */
const linkPoints = (net: Network) =>
  net.links.flatMap((l) => {
    const p = l.path ?? [net.nodes[l.a].x, net.nodes[l.a].y, net.nodes[l.b].x, net.nodes[l.b].y];
    const out: Point[] = [];
    for (let i = 0; i < p.length; i += 2) out.push({ x: p[i], y: p[i + 1] });
    return out;
  });

const rng = mulberry32(7);
const RANDOM20: Food[] = Array.from({ length: 20 }, () => ({ x: 0.05 + rng() * 0.9, y: 0.05 + rng() * 0.52 }));

describe('scene', () => {
  it('paints and reads light, and treats off-board as lit', () => {
    const s = emptyScene();
    expect(isLit(s, 0.5, 0.3)).toBe(false);
    paintLight(s, 0.5, 0.3, 0.05, 1);
    expect(isLit(s, 0.5, 0.3)).toBe(true);
    expect(isLit(s, 0.5, 0.4)).toBe(false);
    paintLight(s, 0.5, 0.3, 0.05, 0);
    expect(isLit(s, 0.5, 0.3)).toBe(false);
    expect(isLit(s, -0.01, 0.3)).toBe(true);
    lightPolygon(s, [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2]]);
    expect(isLit(s, 0.15, 0.15)).toBe(true);
    expect(isLit(s, 0.25, 0.15)).toBe(false);
  });

  it('round-trips a board through the URL hash', () => {
    const s = emptyScene();
    s.foods = [{ x: 0.1, y: 0.2 }, { x: 0.734, y: 0.5 }];
    paintLight(s, 0.5, 0.3, 0.08, 1);
    const back = sceneFromHash(`#${sceneToHash(s, 2.5)}`)!;
    expect(back.i0).toBe(2.5);
    expect(back.scene.foods).toEqual(s.foods);
    expect(Array.from(back.scene.light.data)).toEqual(Array.from(s.light.data));
    // Portrait boards keep their shape.
    const p = emptyScene(0.625, 1, 160);
    p.foods = [{ x: 0.3, y: 0.9 }];
    expect(sceneFromHash(sceneToHash(p, 1))!.scene.height).toBe(1);
  });

  it('rejects hashes that do not fit', () => {
    expect(sceneFromHash('#p=glider')).toBeNull();
    const s = emptyScene();
    expect(decodeMask('zz.zz.zz', s.light)).toBe(false);
    expect(s.light.data.every((v) => v === 0)).toBe(true);
    expect(decodeMask(encodeMask(s.light), s.light)).toBe(true);
    // Off-board foods are dropped.
    expect(sceneFromHash('#n=0.5,0.3;4,4;nan,1')!.scene.foods).toEqual([{ x: 0.5, y: 0.3 }]);
  });
});

describe('agents (Jones 2010)', () => {
  const scene = () => {
    const s = emptyScene();
    s.foods = [{ x: 0.25, y: 0.3 }, { x: 0.75, y: 0.3 }];
    return s;
  };

  it('is deterministic per seed', () => {
    const a = new AgentSim(160, 100, 2000, PRESETS.tendrils, 5);
    const b = new AgentSim(160, 100, 2000, PRESETS.tendrils, 5);
    for (let i = 0; i < 30; i++) {
      a.step();
      b.step();
    }
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.trail)).toEqual(Array.from(b.trail));
  });

  it('keeps trail mass bounded by deposit / decay, and leaves lit cells dark', () => {
    const s = scene();
    lightPolygon(s, [[0.45, 0], [0.55, 0], [0.55, 0.625], [0.45, 0.625]]);
    const sim = new AgentSim(160, 100, 3000, PRESETS.tendrils, 2);
    sim.lit = lightGrid(s, 160, 100);
    sim.spawn();
    for (let i = 0; i < 200; i++) sim.step();
    const p = PRESETS.tendrils;
    expect(sim.mass()).toBeLessThanOrEqual((3000 * p.deposit) / p.decay + 1e-6);
    for (let c = 0; c < sim.trail.length; c++) if (sim.lit[c]) expect(sim.trail[c]).toBe(0);
    for (let k = 0; k < sim.count; k++) expect(sim.lit[Math.floor(sim.y[k]) * 160 + Math.floor(sim.x[k])]).toBe(0);
  });

  it('gathers round food', () => {
    const s = scene();
    const sim = new AgentSim(160, 100, 4000, PRESETS.tendrils, 3);
    sim.attract = attractField(s, 160, 100, PRESETS.tendrils);
    const near = () => {
      let n = 0;
      for (let k = 0; k < sim.count; k++) {
        const x = sim.x[k] / 160, y = (sim.y[k] / 100) * 0.625;
        if (s.foods.some((f) => Math.hypot(f.x - x, f.y - y) < 0.06)) n++;
      }
      return n;
    };
    const before = near();
    for (let i = 0; i < 300; i++) sim.step();
    expect(near()).toBeGreaterThan(before * 2);
  });

  it('draws tubes into the attractant by conductivity', () => {
    const s = emptyScene();
    const tubes = { vx: [0.1, 0.9], vy: [0.3, 0.3], ea: [0], eb: [1], weight: [0.5] };
    const f = attractField(s, 100, 62, PRESETS.tendrils, tubes);
    const j = Math.floor(0.3 * (62 / 0.625));
    expect(f[j * 100 + 50]).toBeCloseTo(PRESETS.tendrils.tubes * 0.5);
    expect(f[(j + 5) * 100 + 50]).toBe(0);
  });
});

describe('flow runner', () => {
  it('builds the mesh, runs within its budget and reports the network', () => {
    const s = emptyScene();
    s.foods = [{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }];
    const r = new FlowRunner();
    const mesh = r.handle({ type: 'init', scene: s })!;
    expect(mesh.ea.length).toBe(r.net!.edgeCount);
    expect(r.tick(1, 50)).toBe(0); // not running yet
    expect(r.takeGrowth()?.type).toBe('growth');
    expect(r.takeGrowth()).toBeNull();
    r.handle({ type: 'run', running: true, rate: 200, grow: 1 });
    // First the strands spread, with the flow model held.
    expect(r.tick(0.5, 50)).toBe(1);
    const half = r.state()!;
    expect(half.stage).toBe('spread');
    expect(half.grow!.tau).toBeCloseTo(half.grow!.end / 2);
    expect(half.metrics.connected).toBe(false);
    expect(r.tick(0.6, 50)).toBe(1);
    expect(r.state()!.grow).toBeNull();
    expect(r.net!.steps).toBe(0);
    expect(r.tick(0.1, 50)).toBe(20);
    r.handle({ type: 'converge', steps: 800 });
    let st: StateMsg | null = null;
    // Settling needs a few model-time samples.
    for (let i = 0; i < 12; i++) {
      r.handle({ type: 'converge', steps: 20 });
      st = r.state();
    }
    expect(st!.metrics.connected).toBe(true);
    expect(st!.settled).toBe(true);
    expect(st!.D.length).toBe(mesh.ea.length);
    // Any change unsettles it.
    r.handle({ type: 'params', i0: 4 });
    expect(r.state()!.settled).toBe(false);
    expect(r.net!.params.i0).toBe(4);
  });

  it('names the stage: spreading, then thinning, then settled', () => {
    const r = new FlowRunner();
    r.handle({ type: 'init', scene: sceneWith([{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }]), params: { i0: 1 } });
    expect(r.state()!.stage).toBe('spread');
    const seen: string[] = [];
    for (let i = 0; i < 60 && r.state()!.stage !== 'settled'; i++) {
      r.handle({ type: 'converge', steps: 20 });
      const stage = r.state()!.stage;
      if (seen[seen.length - 1] !== stage) seen.push(stage);
    }
    expect(seen).toEqual(['spread', 'thin', 'settled']);
    // Starting over goes back to the fresh web.
    r.handle({ type: 'reset' });
    expect(r.state()!.stage).toBe('spread');
  });

  it('waits for two foods before it grows, and regrows on Start over', () => {
    const r = new FlowRunner();
    r.handle({ type: 'init', scene: sceneWith([{ x: 0.3, y: 0.3 }]) });
    r.handle({ type: 'run', running: true, rate: 200, grow: 1 });
    expect(r.tick(5, 50)).toBe(0);
    expect(r.state()!.grow!.tau).toBe(0);
    r.takeGrowth();
    // A second food mid-growth: the strands are grown again from both.
    r.handle({ type: 'foods', foods: [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }] });
    const g = r.takeGrowth()!.growth;
    expect(g.order.length).toBeGreaterThan(100);
    expect(r.tick(2, 50)).toBe(1);
    expect(r.state()!.grow).toBeNull();
    r.handle({ type: 'reset' });
    expect(r.state()!.grow!.tau).toBe(0);
    expect(r.takeGrowth()).not.toBeNull();
  });

  it('grows the Kanto board from Tokyo alone', () => {
    const r = new FlowRunner();
    const sc = kanto(1, 0.625, 128).scene;
    r.handle({ type: 'init', scene: sc });
    const g = r.takeGrowth()!.growth;
    const roots = [...g.order].filter((v) => g.parent[v] < 0);
    expect(roots).toEqual([r.net!.foodVertex(sc.origin!)]);
    expect(g.fuse.length).toBe(0);
  });

  it('tags each state with the board it follows', () => {
    const r = new FlowRunner();
    r.handle({ type: 'init', scene: sceneWith([{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.4 }]), gen: 4 });
    expect(r.state()?.gen).toBe(4);
  });

  it('follows food and light changes', () => {
    const s = emptyScene();
    s.foods = [{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }];
    const r = new FlowRunner();
    r.handle({ type: 'init', scene: s });
    r.handle({ type: 'foods', foods: [...s.foods, { x: 0.5, y: 0.55 }] });
    expect(r.net!.foodCount).toBe(3);
    const light = emptyScene().light;
    light.data.fill(1, 0, light.w * 20);
    r.handle({ type: 'light', light });
    expect(r.net!.blocked.some((b) => b === 1)).toBe(true);
  });
});

describe('growth', () => {
  const net = new FlowNet(sceneWith([{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }]));
  const origins = [net.foodVertex(0), net.foodVertex(1)];
  const g = grow(net, origins, 3);

  it('grows a tree from each food over every reachable tube', () => {
    const open = new Set<number>();
    for (let e = 0; e < net.edgeCount; e++) if (net.alive[e]) open.add(net.ea[e]).add(net.eb[e]);
    expect(g.order.length).toBe(open.size);
    for (const v of g.order) {
      const p = g.parent[v];
      if (p < 0) {
        expect(origins).toContain(v);
        continue;
      }
      const e = g.via[v];
      expect([net.ea[e], net.eb[e]].sort()).toEqual([p, v].sort());
      expect(g.reach[v]).toBeCloseTo(g.reach[p] + g.cost[e]);
      expect(g.owner[v]).toBe(g.owner[p]);
    }
    // Both trees get a share of the board, and they fuse where they meet.
    const own0 = [...g.owner].filter((o) => o === 0).length;
    expect(own0 / net.vertexCount).toBeGreaterThan(0.3);
    expect(own0 / net.vertexCount).toBeLessThan(0.7);
    expect(g.fuse.length).toBeGreaterThan(0);
    expect(g.fuse.length).toBeLessThanOrEqual(3);
    for (const e of g.fuse) expect(g.owner[net.ea[e]]).not.toBe(g.owner[net.eb[e]]);
  });

  it('is the same for the same seed and differs for another', () => {
    expect(grow(net, origins, 3).reach).toEqual(g.reach);
    expect(grow(net, origins, 4).reach).not.toEqual(g.reach);
  });

  it('keeps out of the light', () => {
    const s = sceneWith([{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }]);
    paintLight(s, 0.5, 0.3, 0.08, 1);
    const lit = new FlowNet(s);
    const lg = grow(lit, [lit.foodVertex(0), lit.foodVertex(1)], 1);
    for (const v of lg.order) if (lg.via[v] >= 0) expect(lit.blocked[lg.via[v]]).toBe(0);
  });

  it('advances its tips over time and thickens toward the food', () => {
    const none = growthAt(g, net, 0);
    expect(Math.max(...none.fromA, ...none.fromB)).toBe(0);
    const mid = growthAt(g, net, g.end / 2);
    const done = growthAt(g, net, g.end);
    let grownMid = 0, grownEnd = 0;
    for (let e = 0; e < net.edgeCount; e++) {
      grownMid += mid.fromA[e] + mid.fromB[e];
      grownEnd += done.fromA[e] + done.fromB[e];
      // Never more than one tube's worth, and fused tubes meet exactly.
      expect(done.fromA[e] + done.fromB[e]).toBeLessThanOrEqual(1 + 1e-6);
      expect(done.weight[e]).toBeGreaterThanOrEqual(mid.weight[e]);
    }
    expect(grownMid).toBeGreaterThan(0);
    expect(grownMid).toBeLessThan(grownEnd);
    for (const e of g.fuse) expect(done.fromA[e] + done.fromB[e]).toBeCloseTo(1);
    // The tubes leaving a food feed far more than the tips.
    const trunk = Math.max(...g.order.filter((v) => origins.includes(g.parent[v])).map((v) => done.weight[g.via[v]]));
    const tip = g.order[g.order.length - 1];
    expect(trunk).toBeGreaterThan(done.weight[g.via[tip]] * 3);
  });

  it('hands the flow model thick strands and a thin film', () => {
    const full = 0.75;
    const D = startConductivity(g, net, full, 5);
    const film = filmTubes(g, net.edgeCount);
    for (let e = 0; e < net.edgeCount; e++) {
      if (!net.alive[e]) expect(D[e]).toBe(0);
      else if (film[e]) {
        expect(D[e]).toBeGreaterThanOrEqual(FILM * full * 0.75 - 1e-9);
        expect(D[e]).toBeLessThanOrEqual(FILM * full * 1.25 + 1e-9);
      } else expect(D[e]).toBeGreaterThanOrEqual(0.5);
    }
    // Strands are a tree per food plus the fusions: about one tube per vertex.
    expect(film.length - film.reduce((a, b) => a + b, 0)).toBe(g.order.length - origins.length + g.fuse.length);
  });

  it('draws the measured network, never the unused film', () => {
    const D = [0.01, 0.01, 0.5, 0.5, 0.002, 0.1, 0.4];
    const film = [0, 1, 1, 0, 0, 1, 1];
    const inNet = [1, 0, 0, 0, 0, 1, 1];
    const w = flowWeights(D, 0.5, film, inNet, false);
    expect(w[0]).toBeCloseTo(0.15); // a strand in the network: at least faint
    expect(w[1]).toBe(0); // unused film
    expect(w[2]).toBe(0); // film the network does not use, however thick
    expect(w[3]).toBe(1);
    expect(w[4]).toBe(0); // a strand nearly gone
    expect(w[5]).toBe(0); // film still at its starting share: hidden even in the network
    expect(w[6]).toBeCloseTo(Math.sqrt(0.8)); // film the flow has thickened
    // Later, film still in the network is there on merit and shows like any tube.
    const later = flowWeights(D, 0.5, film, inNet, true);
    expect(later[5]).toBeCloseTo(Math.sqrt(0.2));
    expect(later[2]).toBe(0);
  });

  it('smooths a zigzag chain into a curve but holds its ends', () => {
    const x = [0, 1, 2, 3, 4, 5];
    const y = [0, 1, 0, 1, 0, 1];
    const chain = { ea: [0, 1, 2, 3, 4], eb: [1, 2, 3, 4, 5] };
    const s = smoothAlong(x, y, chain, [1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0]);
    expect(s.x[0]).toBe(0);
    expect(s.y[5]).toBe(1);
    const wiggle = (ys: ArrayLike<number>) => Math.abs(ys[2] - ys[1]) + Math.abs(ys[3] - ys[2]);
    expect(wiggle(s.y)).toBeLessThan(wiggle(y) * 0.5);
  });
});

describe('figures', () => {
  it('runs the streaming wave slowly through every phase group', () => {
    expect(SHUTTLE_SECONDS).toBeLessThan(REAL_SHUTTLE_SECONDS);
    const groups = new Set<number>();
    for (let x = 0; x <= 1; x += 0.01) groups.add(waveGroup(x, 0.3, 1));
    expect(groups.size).toBe(WAVE_GROUPS);
    for (let g = 0; g < WAVE_GROUPS; g++) {
      for (let t = 0; t < SHUTTLE_SECONDS; t += 0.5) {
        const w = waveSwell(g, t);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
      }
      // One full period later, the same swell.
      expect(waveSwell(g, 1.3 + SHUTTLE_SECONDS)).toBeCloseTo(waveSwell(g, 1.3));
    }
    // The wave travels: neighbouring groups are out of step.
    expect(waveSwell(0, 1)).not.toBeCloseTo(waveSwell(1, 1));
  });

  it('gives each oat flake its own, steady, irregular outline', () => {
    const a = flakeShape(3);
    expect(flakeShape(3)).toEqual(a);
    expect(flakeShape(4)).not.toEqual(a);
    for (const r of a.radii) {
      expect(r).toBeGreaterThanOrEqual(0.72);
      expect(r).toBeLessThanOrEqual(1.12);
    }
    const pts = flakePoints(10, 20, 5, a);
    expect(pts).toHaveLength(a.radii.length * 2);
    for (let i = 0; i < pts.length; i += 2) expect(Math.hypot(pts[i] - 10, pts[i + 1] - 20)).toBeLessThanOrEqual(5 * 1.12 + 1e-9);
  });

  it('puts callouts inside the board, on the roomier side, and draws the same leader each time', () => {
    const board = [0, 0, 400, 250] as const;
    for (const [ax, ay] of [[20, 20], [380, 230], [200, 125], [390, 10]]) {
      const c = placeCallout(ax, ay, ...board, 70, 2);
      expect(c.lx).toBeGreaterThanOrEqual(0);
      expect(c.lx).toBeLessThanOrEqual(400);
      expect(c.ly).toBeGreaterThanOrEqual(0);
      expect(c.ly).toBeLessThanOrEqual(250);
      expect(c.align).toBe(ax < 200 ? 'left' : 'right');
      expect(c.leader).toHaveLength(22);
      // The leader ends just short of what it points at.
      const ex = c.leader[20], ey = c.leader[21];
      expect(Math.hypot(ex - ax, ey - ay)).toBeLessThan(10);
      expect(placeCallout(ax, ay, ...board, 70, 2)).toEqual(c);
    }
  });

  it('lays out cost against resilience with the tree bottom left and labels apart', () => {
    const L = tradeoffLayout(
      [
        { id: 'mst', label: 'Spanning tree', cost: 1, robust: 0 },
        { id: 'steiner', label: 'Steiner tree', cost: 0.95, robust: 0 },
        { id: 'delaunay', label: 'Delaunay mesh', cost: 4.4, robust: 1 },
        { id: 'mold', label: 'The mold', cost: 1.5, robust: 0.8 },
        { id: 'bad', label: 'Unconnected', cost: Infinity, robust: 0 },
      ],
      320,
      190,
    );
    expect(L.points.map((p) => p.id)).toEqual(['mst', 'steiner', 'delaunay', 'mold']);
    const at = (id: string) => L.points.find((p) => p.id === id)!;
    expect(at('mst').y).toBeCloseTo(L.y1);
    expect(at('delaunay').y).toBeCloseTo(L.y0);
    expect(at('delaunay').x).toBeLessThanOrEqual(L.x1);
    expect(at('delaunay').anchor).toBe('end');
    expect(at('mold').x).toBeGreaterThan(at('mst').x);
    // Two trees at nearly the same spot: their labels are stepped apart.
    expect(Math.abs(at('mst').ly - at('steiner').ly)).toBeGreaterThanOrEqual(11);
    // So are labels that would run into each other from opposite sides on one line.
    const top = tradeoffLayout(
      [
        { id: 'rail', label: 'Tokyo rail (2010)', cost: 1.8, robust: 0.96 },
        { id: 'delaunay', label: 'Delaunay mesh', cost: 3.4, robust: 1 },
      ],
      320,
      190,
    ).points;
    expect(Math.abs(top[0].ly - top[1].ly)).toBeGreaterThanOrEqual(11);
    // And a label steps off another network's point rather than covering it.
    const near = tradeoffLayout(
      [
        { id: 'rail', label: 'Tokyo rail (2010)', cost: 1.8, robust: 0.96 },
        { id: 'mold', label: 'The mold', cost: 1.55, robust: 1 },
      ],
      320,
      190,
    ).points;
    const [rail, mold] = near;
    const overRail = mold.lx < rail.x + 5 && mold.lx + mold.label.length * 5.2 > rail.x - 5 && Math.abs(rail.y - (mold.ly - 3.5)) < 8;
    expect(overRail).toBe(false);
    expect(L.ticks[0].value).toBe(1);
    expect(L.ticks[L.ticks.length - 1].value).toBeGreaterThanOrEqual(4.4);
  });
});

describe('metrics', () => {
  // A square with one diagonal: 5 links, 4 foods.
  const square: Network = {
    nodes: [
      { x: 0, y: 0, food: 0 },
      { x: 1, y: 0, food: 1 },
      { x: 1, y: 1, food: 2 },
      { x: 0, y: 1, food: 3 },
    ],
    links: [
      { a: 0, b: 1, length: 1 },
      { a: 1, b: 2, length: 1 },
      { a: 2, b: 3, length: 1 },
      { a: 3, b: 0, length: 1 },
      { a: 0, b: 2, length: Math.SQRT2 },
    ],
  };

  it('measures cost, mean distance and fault tolerance', () => {
    expect(totalLength(square)).toBeCloseTo(4 + Math.SQRT2);
    // Pairs: four sides of 1, the diagonal √2, and 1–3 at 2.
    expect(meanFoodDistance(square)).toBeCloseTo((4 + Math.SQRT2 + 2) / 6);
    expect(bridgeCount(square)).toBe(0);
    expect(faultTolerance(square)).toBe(1);
  });

  it('scores a tree 0 on fault tolerance and a pendant link as a bridge', () => {
    const tree: Network = { nodes: square.nodes, links: square.links.slice(0, 3) };
    expect(faultTolerance(tree)).toBe(0);
    const pendant: Network = {
      nodes: [...square.nodes, { x: 2, y: 0, food: 4 }],
      links: [...square.links, { a: 1, b: 4, length: 1 }],
    };
    expect(bridgeCount(pendant)).toBe(1);
    expect(faultTolerance(pendant)).toBeCloseTo(5 / 6);
  });

  it('reports a cut-off food as disconnected', () => {
    const cut: Network = { nodes: square.nodes, links: [square.links[0]] };
    const m = metrics(cut);
    expect(m.connected).toBe(false);
    expect(m.md).toBe(Infinity);
  });

  it('normalizes TL and MD to the MST', () => {
    const pts = square.nodes;
    const n = normalize(metrics(square), metrics(mst(pts)));
    expect(n.tlMst).toBeCloseTo((4 + Math.SQRT2) / 3);
    expect(n.mdMst).toBeLessThan(1);
  });
});

describe('reference networks', () => {
  it('builds the minimum spanning tree', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 5 }];
    const edges = mstEdges(pts);
    expect(edges).toHaveLength(3);
    expect(totalLength(mst(pts))).toBeCloseTo(2 + 5);
  });

  it('triangulates: a convex quad gets 5 edges, and every MST edge is a Delaunay edge', () => {
    expect(delaunayEdges([{ x: 0, y: 0 }, { x: 1, y: 0.1 }, { x: 1.1, y: 1 }, { x: 0, y: 0.9 }])).toHaveLength(5);
    const key = ([a, b]: [number, number]) => (a < b ? `${a},${b}` : `${b},${a}`);
    const del = new Set(delaunayEdges(RANDOM20).map(key));
    for (const e of mstEdges(RANDOM20)) expect(del.has(key(e))).toBe(true);
    // Euler: a triangulation of n points with h on the hull has 3n − 3 − h edges.
    expect(delaunay(RANDOM20).links.length).toBeLessThanOrEqual(3 * 20 - 6);
  });

  it('finds the Steiner point of an equilateral triangle, and never beats it elsewhere by growing', () => {
    const tri = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: Math.sqrt(3) / 2 }];
    const st = steinerTree(tri);
    expect(totalLength(st)).toBeCloseTo(Math.sqrt(3), 4);
    const j = st.nodes.find((n) => n.food < 0)!;
    expect(j.x).toBeCloseTo(0.5, 3);
    expect(j.y).toBeCloseTo(Math.sqrt(3) / 6, 3);
    const tl = totalLength(steinerTree(RANDOM20));
    expect(tl).toBeLessThanOrEqual(totalLength(mst(RANDOM20)) + 1e-9);
    // Steiner trees save at most 1 − √3/2 ≈ 13.4% over the MST (Du and Hwang, 1990).
    expect(tl).toBeGreaterThan(totalLength(mst(RANDOM20)) * (Math.sqrt(3) / 2));
  });
});

describe('flow model (Tero et al. 2010)', () => {
  it('conserves flux: Kirchhoff holds at every junction and I₀ leaves the source', () => {
    const net = new FlowNet(sceneWith([{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.4 }]));
    const { Q, residual } = net.flux(0, 1);
    expect(residual).toBeLessThan(1e-6);
    let out = 0;
    const src = net.foodVertex(0);
    for (let e = 0; e < net.edgeCount; e++) {
      if (net.ea[e] === src) out += Q[e];
      if (net.eb[e] === src) out -= Q[e];
    }
    expect(out).toBeCloseTo(net.params.i0, 4);
  });

  it('thins two foods down to a near-straight tube', () => {
    const foods = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.45 }];
    const net = new FlowNet(sceneWith(foods));
    net.step(800);
    const m = metrics(net.extractNetwork());
    const straight = Math.hypot(0.6, 0.25);
    expect(m.connected).toBe(true);
    expect(m.md).toBeGreaterThanOrEqual(straight * 0.999);
    expect(m.md).toBeLessThan(straight * 1.05);
  });

  it('is deterministic per seed', () => {
    const a = new FlowNet(sceneWith(RANDOM20.slice(0, 6)), { seed: 3 });
    const b = new FlowNet(sceneWith(RANDOM20.slice(0, 6)), { seed: 3 });
    a.step(150);
    b.step(150);
    expect(Array.from(a.D)).toEqual(Array.from(b.D));
  });

  it('solves the maze: of two gaps in a wall, the tube takes the shorter way', () => {
    const s = sceneWith([{ x: 0.2, y: 0.15 }, { x: 0.8, y: 0.15 }]);
    // A wall down the middle with a gap near the foods and one far from them.
    lightPolygon(s, [[0.47, 0], [0.53, 0], [0.53, 0.08], [0.47, 0.08]]);
    lightPolygon(s, [[0.47, 0.2], [0.53, 0.2], [0.53, 0.45], [0.47, 0.45]]);
    lightPolygon(s, [[0.47, 0.53], [0.53, 0.53], [0.53, 0.625], [0.47, 0.625]]);
    const net = new FlowNet(s);
    net.step(1200);
    const n = net.extractNetwork();
    expect(metrics(n).connected).toBe(true);
    const pts = linkPoints(n);
    // Through the near gap (0.08–0.2), never the far one (0.45–0.53).
    const crossing = pts.filter((p) => p.x > 0.47 && p.x < 0.53);
    expect(crossing.length).toBeGreaterThan(0);
    for (const p of crossing) expect(p.y).toBeLessThan(0.25);
    for (const p of pts) expect(isLit(s, p.x, p.y)).toBe(false);
  });

  it('reroutes round a cut', () => {
    const net = new FlowNet(sceneWith([{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }]));
    net.step(800);
    const before = metrics(net.extractNetwork());
    expect(net.cut(0.5, 0.15, 0.5, 0.45)).toBeGreaterThan(0);
    expect(metrics(net.extractNetwork()).connected).toBe(false);
    net.step(600);
    const after = metrics(net.extractNetwork());
    expect(after.connected).toBe(true);
    expect(after.md).toBeGreaterThan(before.md);
    // Round an end of the cut, not through it (smoothing may round the corner by a cell).
    for (const p of linkPoints(net.extractNetwork())) {
      if (Math.abs(p.x - 0.5) < 0.01) expect(p.y < 0.15 + 0.03 || p.y > 0.45 - 0.03).toBe(true);
    }
  });

  it('turns I₀ into the trade-off: low gives a cheap tree, high a robust, faster web', () => {
    const run = (i0: number) => {
      const net = new FlowNet(sceneWith(RANDOM20), { i0 });
      net.step(1200);
      return normalize(metrics(net.extractNetwork()), metrics(mst(RANDOM20)));
    };
    const low = run(0.5);
    const high = run(6);
    expect(low.connected && high.connected).toBe(true);
    expect(low.ft).toBe(0);
    expect(low.tlMst).toBeLessThan(1.2);
    expect(high.ft).toBeGreaterThan(0.8);
    expect(high.tlMst).toBeGreaterThan(2);
    expect(high.mdMst).toBeLessThan(low.mdMst);
  }, 30_000);

  it('keeps a step within budget once the network has formed', () => {
    const net = new FlowNet(sceneWith(RANDOM20));
    net.step(600);
    const t0 = performance.now();
    net.step(100);
    expect((performance.now() - t0) / 100).toBeLessThan(8);
  }, 30_000);
});

describe('Kanto (stylized)', () => {
  const boards = [
    ['landscape', kanto(1, 0.625, 256)],
    ['portrait', kanto(0.625, 1, 160)],
  ] as const;

  it.each(boards)('puts every city on the %s board, in the dark', (_, k) => {
    expect(k.scene.foods).toHaveLength(CITIES.length);
    for (const f of k.scene.foods) {
      expect(f.x).toBeGreaterThan(0);
      expect(f.y).toBeGreaterThan(0);
      expect(f.x).toBeLessThan(k.scene.width);
      expect(f.y).toBeLessThan(k.scene.height);
      expect(isLit(k.scene, f.x, f.y), f.label).toBe(false);
    }
    expect(k.scene.foods.find((f) => f.label === 'Tokyo')?.weight).toBe(7);
  });

  it.each(boards)('lights the sea, the bay, the lake and the mountains on the %s board', (_, k) => {
    const lit = (lon: number, lat: number) => isLit(k.scene, ...k.project(lon, lat));
    expect(lit(139.88, 35.5)).toBe(true); // Tokyo Bay
    expect(lit(139.4, 35.25)).toBe(true); // Sagami Bay
    expect(lit(140.33, 36.06)).toBe(true); // Kasumigaura
    expect(lit(139.05, 35.7)).toBe(true); // the western mountains
    expect(lit(139.6, 35.75)).toBe(false); // the plain
  });

  it('sketches a rail network that is connected, robust and dearer than the tree', () => {
    const names = new Set(CITIES.map((c) => c.name));
    for (const [a, b] of RAIL) expect(names.has(a) && names.has(b), `${a}-${b}`).toBe(true);
    const k = kanto();
    const n = normalize(metrics(k.rail), metrics(mst(k.scene.foods)));
    expect(n.connected).toBe(true);
    expect(n.tlMst).toBeGreaterThan(1.5);
    expect(n.tlMst).toBeLessThan(2.6);
    expect(n.mdMst).toBeLessThan(1);
    expect(n.ft).toBeGreaterThan(0.85);
  });

  it('grows a connected network round the bay, cheaper than the rail sketch', () => {
    const k = kanto();
    const net = new FlowNet(k.scene);
    net.step(1200);
    const n = normalize(metrics(net.extractNetwork()), metrics(mst(k.scene.foods)));
    const rail = normalize(metrics(k.rail), metrics(mst(k.scene.foods)));
    expect(n.connected).toBe(true);
    expect(n.tlMst).toBeGreaterThan(1.1);
    expect(n.tlMst).toBeLessThan(rail.tlMst);
    expect(n.ft).toBeGreaterThan(0.5);
    for (const p of linkPoints(net.extractNetwork())) expect(isLit(k.scene, p.x, p.y)).toBe(false);
  }, 30_000);
});

describe('tour', () => {
  it('looks through one of the three lenses at every step, and all three overall', () => {
    for (const s of TOUR) expect(['nature', 'math', 'engineering']).toContain(s.lens);
    expect(new Set(TOUR.map((s) => s.lens)).size).toBe(3);
  });

  const boards = [
    ['landscape', 1, 0.625, 256],
    ['portrait', 0.625, 1, 160],
  ] as const;
  const board = (id: string, w = 1, h = 0.625, m = 256) => {
    const b = TOUR.find((s) => s.id === id)!.board;
    if (typeof b !== 'function') throw new Error(id);
    return b(w, h, m);
  };
  const settle = (id: string, steps = 1200) => {
    const step = TOUR.find((s) => s.id === id)!;
    const sc = board(id);
    const net = new FlowNet(sc, { i0: step.i0, ...(step.gamma ? { gamma: step.gamma } : {}) });
    net.step(steps);
    return { sc, net, n: normalize(metrics(net.extractNetwork()), metrics(mst(sc.foods))) };
  };

  it.each(boards)('puts every food in the dark on the %s board', (_, w, h, m) => {
    for (const step of TOUR) {
      if (typeof step.board !== 'function') continue;
      const sc = step.board(w, h, m);
      expect(sc.width).toBe(w);
      expect(sc.foods.length, step.id).toBeGreaterThanOrEqual(2);
      for (const f of sc.foods) expect(isLit(sc, f.x, f.y), step.id).toBe(false);
    }
  });

  it('transposes a board for portrait, walls and all', () => {
    const l = board('maze');
    const p = board('maze', 0.625, 1, 160);
    expect(p.foods.map((f) => [f.y, f.x])).toEqual(l.foods.map((f) => [f.x, f.y]));
    const pts = [[0.4, 0.1], [0.5, 0.21], [0.3, 0.3], [0.143, 0.05], [0.6, 0.3125]];
    for (const [x, y] of pts) expect(isLit(p, y, x)).toBe(isLit(l, x, y));
    expect(pts.some(([x, y]) => isLit(l, x, y))).toBe(true);
    expect(maze().walls.length).toBeGreaterThan(10);
  });

  it('thins two foods to one straight tube', () => {
    const { n } = settle('two', 800);
    expect(n.connected).toBe(true);
    expect(n.tlMst).toBeLessThan(1.05);
    expect(n.ft).toBe(0);
  });

  it('solves the maze the short way, and takes the long way once that is cut', () => {
    const { sc, net, n } = settle('maze', 800);
    expect(n.connected).toBe(true);
    expect(n.ft).toBe(0);
    // Smoothing may round a wall's corner, but never runs through a wall.
    const deep = (x: number, y: number) => [[0, 0], [0.012, 0], [-0.012, 0], [0, 0.012], [0, -0.012]].every(([dx, dy]) => isLit(sc, x + dx, y + dy));
    for (const p of linkPoints(net.extractNetwork())) expect(deep(p.x, p.y)).toBe(false);
    const short = metrics(net.extractNetwork()).md;
    // The short way's last stretch runs along the third row; the long way goes round the top.
    expect(net.cut(5 / 7, 0.3125 - 0.02, 5 / 7, 0.46875 + 0.02)).toBeGreaterThan(0);
    net.step(600);
    const long = metrics(net.extractNetwork());
    expect(long.connected).toBe(true);
    expect(long.md).toBeGreaterThan(short * 1.4);
  }, 30_000);

  it('grows a junction for three foods, cheaper than the tree', () => {
    const { net, n } = settle('three', 800);
    expect(n.connected).toBe(true);
    expect(n.tlMst).toBeLessThan(0.95);
    expect(net.extractNetwork().nodes.some((v) => v.food < 0)).toBe(true);
  }, 30_000);

  it('settles the I₀ board cheaper at low I₀, and robust and quicker at high', () => {
    const sc = board('knob');
    const ref = metrics(mst(sc.foods));
    const run = (i0: number) => {
      const net = new FlowNet(sc, { i0 });
      net.step(1000);
      return normalize(metrics(net.extractNetwork()), ref);
    };
    const low = run(0.3);
    const high = run(5);
    expect(low.connected && high.connected).toBe(true);
    expect(low.tlMst).toBeLessThan(1.3);
    expect(high.tlMst).toBeGreaterThan(low.tlMst * 1.4);
    expect(high.ft).toBeGreaterThan(Math.max(0.5, low.ft));
    expect(high.mdMst).toBeLessThan(low.mdMst);
  }, 30_000);

  it('sends the tube round light painted across it', () => {
    const { sc, net } = settle('terrain', 600);
    const before = metrics(net.extractNetwork());
    for (let k = 0; k <= 10; k++) paintLight(sc, 0.5, 0.2 + k * 0.025, 0.035, 1);
    net.setLight(sc);
    net.step(900);
    const after = metrics(net.extractNetwork());
    expect(after.connected).toBe(true);
    expect(after.md).toBeGreaterThan(before.md * 1.1);
  }, 30_000);

  it('meets a goal once every mark it needs is earned, over several readings', () => {
    const knob = TOUR.find((s) => s.id === 'knob')!;
    const r: Reading = { settled: true, connected: true, tl: 1, md: 1, ft: 0, i0: 0.3, painted: false };
    const a = earn(knob, new Set(), r);
    expect([...a.marks]).toEqual(['low']);
    expect(a.met).toBe(false);
    expect(earn(knob, a.marks, { ...r, i0: 2 }).met).toBe(false);
    expect(earn(knob, a.marks, { ...r, i0: 5, settled: false }).met).toBe(false);
    expect(earn(knob, a.marks, { ...r, i0: 5 }).met).toBe(true);
    const terrain = TOUR.find((s) => s.id === 'terrain')!;
    expect(earn(terrain, new Set(), r).met).toBe(false);
    expect(earn(terrain, new Set(), { ...r, painted: true }).met).toBe(true);
  });

  it('saves progress, keeps other keys, and shrugs off junk', () => {
    expect(PROGRESS_KEY).toBe('physarum-progress');
    expect(parseProgress(null)).toEqual({ at: 'two', done: [] });
    expect(parseProgress('{not json')).toEqual({ at: 'two', done: [] });
    expect(parseProgress('{"tour":{"at":"nope","done":["maze",3,"bogus","maze"]}}')).toEqual({ at: 'two', done: ['maze'] });
    const text = serializeProgress({ at: 'knob', done: ['three', 'two'] }, '{"challenge":{"best":2}}');
    expect(JSON.parse(text)).toEqual({ challenge: { best: 2 }, tour: { at: 'knob', done: ['two', 'three'] } });
    expect(parseProgress(text)).toEqual({ at: 'knob', done: ['two', 'three'] });
    expect(stepIndex('tokyo')).toBe(5);
    expect(stepIndex('missing')).toBe(0);
  });
});

describe('challenge (You vs the mold)', () => {
  const boards = [
    ['landscape', 1, 0.625, 256],
    ['portrait', 0.625, 1, 160],
  ] as const;
  const at = (_: ReturnType<typeof sceneWith>, i: number) => ({ kind: 'node' as const, i });
  /** Track along the towns' MST, built one link at a time. */
  const mstTrack = (sc: ReturnType<typeof sceneWith>, budget = Infinity) => {
    let t: Track = emptyTrack();
    for (const l of mst(sc.foods).links) {
      const next = build(sc, t, at(sc, l.a), at(sc, l.b), budget);
      if (typeof next === 'string') throw new Error(next);
      t = next;
    }
    return t;
  };

  it.each(boards)('lays every level out on the %s board with its towns in the dark', (_, w, h, m) => {
    for (const level of LEVELS) {
      const sc = level.board(w, h, m);
      expect(sc.foods.length, level.id).toBeGreaterThanOrEqual(5);
      for (const f of sc.foods) expect(isLit(sc, f.x, f.y), level.id).toBe(false);
      expect(level.budget).toBeGreaterThan(1.3);
    }
  });

  it('builds links between towns, through junctions and by branching off a line', () => {
    const sc = sceneWith([{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.5, y: 0.5 }]);
    let t = build(sc, emptyTrack(), at(sc, 0), at(sc, 1), 10) as Track;
    expect(t.links).toEqual([[0, 1]]);
    // From the third town onto the middle of that line: a junction splits it.
    const mid = endAt(sc, t, 0.5, 0.205, 0.02);
    expect(mid.kind).toBe('link');
    t = build(sc, t, at(sc, 2), mid, 10) as Track;
    expect(t.junctions).toHaveLength(1);
    expect(t.links).toHaveLength(3);
    const m = measure(sc, t);
    expect(m.connected).toBe(true);
    // Into open ground makes a junction too.
    const open = endAt(sc, t, 0.5, 0.58, 0.02);
    expect(open.kind).toBe('open');
    const spur = build(sc, t, at(sc, 2), open, 10) as Track;
    expect(spur.junctions).toHaveLength(2);
    // The spur costs, but it is a dead end: robust ignores it.
    expect(measure(sc, spur).tl).toBeGreaterThan(m.tl);
    expect(measure(sc, spur).ft).toBe(m.ft);
  });

  it('refuses track over light, over budget, or of no length', () => {
    const sc = sceneWith([{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }]);
    paintLight(sc, 0.5, 0.3, 0.05, 1);
    expect(build(sc, emptyTrack(), at(sc, 0), at(sc, 1), 10)).toBe('light');
    const clear = sceneWith([{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }]);
    expect(build(clear, emptyTrack(), at(clear, 0), at(clear, 1), 0.5)).toBe('budget');
    expect(build(clear, emptyTrack(), at(clear, 0), at(clear, 0), 10)).toBe('short');
  });

  it('erases a line or a junction, and drops junctions left with nothing', () => {
    const sc = sceneWith([{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.5, y: 0.5 }]);
    let t = build(sc, emptyTrack(), at(sc, 0), { kind: 'open', x: 0.5, y: 0.3 }, 10) as Track;
    t = build(sc, t, at(sc, 1), { kind: 'node', i: 3 }, 10) as Track;
    t = build(sc, t, at(sc, 2), { kind: 'node', i: 3 }, 10) as Track;
    expect(t.links).toHaveLength(3);
    const noJunction = erase(sc, t, 0.5, 0.3, 0.02)!;
    expect(noJunction.links).toHaveLength(0);
    expect(noJunction.junctions).toHaveLength(0);
    const oneLine = erase(sc, t, 0.35, 0.25, 0.02)!;
    expect(oneLine.links).toHaveLength(2);
    expect(erase(sc, t, 0.9, 0.55, 0.02)).toBeNull();
    // A branch point on a straight line: erasing it takes the branch and leaves the line whole.
    let split = build(sc, emptyTrack(), at(sc, 0), at(sc, 1), 10) as Track;
    split = build(sc, split, at(sc, 2), endAt(sc, split, 0.5, 0.2, 0.02), 10) as Track;
    expect(erase(sc, split, 0.5, 0.2, 0.02)).toEqual({ junctions: [], links: [[0, 1]] });
    // So does erasing the branch itself.
    expect(erase(sc, split, 0.5, 0.4, 0.02)).toEqual({ junctions: [], links: [[0, 1]] });
  });

  it('contracts two-link junctions and prunes dead ends for robust', () => {
    const net = {
      nodes: [{ x: 0, y: 0, food: 0 }, { x: 1, y: 0, food: 1 }, { x: 0.5, y: 0, food: -1 }, { x: 0.5, y: 1, food: -1 }],
      links: [{ a: 0, b: 2, length: 0.5 }, { a: 2, b: 1, length: 0.5 }, { a: 2, b: 3, length: 1 }],
    };
    const c = contract(net);
    expect(c.nodes).toHaveLength(2);
    expect(c.links).toEqual([{ a: 0, b: 1, length: 1 }]);
  });

  it('scores the MST against the mold as cheaper but slower and fragile', () => {
    const level = LEVELS[0];
    const sc = level.board(1, 0.625, 256);
    const ref = metrics(mst(sc.foods));
    const you = measure(sc, mstTrack(sc, level.budget * ref.tl), ref);
    expect(you.tlMst).toBeCloseTo(1, 5);
    expect(you.ft).toBe(0);
    const net = new FlowNet(sc, { i0: 2 });
    net.step(1500);
    const mold = normalize(metrics(net.extractNetwork()), ref);
    expect(mold.connected).toBe(true);
    expect(mold.tlMst).toBeLessThan(level.budget);
    const s = score(you, mold);
    expect(s.cost).toBe('win');
    expect(s.robust).toBe('lose');
    expect(s.verdict).toBe('tradeoff');
  }, 30_000);

  it('gives every level a budget above its race mold, grown as the page grows it', () => {
    for (const level of LEVELS) {
      const sc = level.board(1, 0.625, 256);
      const r = new FlowRunner();
      r.handle({ type: 'init', scene: sc, params: { i0: 2 } });
      let st = r.state()!;
      for (let i = 0; i < 150 && !st.settled && r.net!.steps < 1500; i++) {
        r.handle({ type: 'converge', steps: 10 });
        st = r.state()!;
      }
      const mold = normalize(st.metrics, metrics(mst(sc.foods)));
      expect(mold.connected).toBe(true);
      expect(mold.tlMst).toBeLessThan(level.budget);
    }
  }, 60_000);

  it('calls ties within 2%, and an unconnected track unfinished', () => {
    const base = { tl: 1, md: 1, ft: 0.5, connected: true, tlMst: 1.3, mdMst: 0.85 };
    expect(score({ ...base, tlMst: 1.31 }, base).verdict).toBe('tie');
    expect(score({ ...base, mdMst: 0.8 }, base).verdict).toBe('beat');
    expect(score({ ...base, ft: 0.4 }, base).verdict).toBe('lost');
    expect(score({ ...base, connected: false }, base).verdict).toBe('unfinished');
  });

  it('keeps the best result per level, beside the tour', () => {
    let p = parseChallenge(null);
    expect(p.at).toBe('five');
    const win = score({ tl: 1, md: 1, ft: 0.6, connected: true, tlMst: 1.2, mdMst: 0.9 }, { tl: 1, md: 1, ft: 0.5, connected: true, tlMst: 1.3, mdMst: 0.9 });
    const loss = score({ tl: 1, md: 1, ft: 0.1, connected: true, tlMst: 1.4, mdMst: 0.9 }, { tl: 1, md: 1, ft: 0.5, connected: true, tlMst: 1.3, mdMst: 0.9 });
    p = record(p, 'five', win);
    p = record(p, 'five', loss);
    expect(p.best.five).toEqual({ margin: 2, beat: true });
    const text = serializeChallenge(p, serializeProgress({ at: 'maze', done: ['two'] }));
    expect(parseChallenge(text).best.five).toEqual({ margin: 2, beat: true });
    expect(parseProgress(text)).toEqual({ at: 'maze', done: ['two'] });
    expect(parseChallenge('{"challenge":{"at":"nope","best":{"five":{"margin":"x"},"bogus":{"margin":1}}}}')).toEqual({ at: 'five', best: {} });
    expect(trackNetwork(sceneWith([{ x: 0.1, y: 0.1 }]), emptyTrack()).nodes).toHaveLength(1);
  });
});
