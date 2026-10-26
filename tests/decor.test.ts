import { describe, expect, it } from 'vitest';
import { decorLattice, decorLevel, layoutDecor, type DecorCard } from '../src/grid/game/decor';
import { GridGame } from '../src/grid/game/engine';
import { layoutGame } from '../src/grid/game/layout';
import { toPx } from '../src/grid/layout';
import { NODES } from './fixtures/nodes';

function run(game: GridGame, seconds: number, dt = 1 / 30) {
  for (let t = 0; t < seconds; t += dt) game.step(dt);
}

/** Card dots the way the projects hero lays them out: 2 columns, then the strip, centred. */
function dots(width: number, twoCols: boolean): DecorCard[] {
  const gap = 16;
  const wrap = Math.min(960, width - 2 * 21);
  const left = (width - wrap) / 2;
  const cardW = twoCols ? (wrap - gap) / 2 : wrap;
  const cx = (col: number) => left + col * (cardW + gap) + cardW / 2;
  const top = 340;
  const rowH = 192;
  const ids = ['custom-llm', 'spotify-insight', 'personal-wiki', 'pacman-dqn'];
  const cards = ids.map((id, i) => ({
    id,
    live: i < 2,
    x: twoCols ? cx(i % 2) : cx(0),
    y: top + (twoCols ? Math.floor(i / 2) : i) * rowH,
  }));
  const stripY = top + (twoCols ? 2 : 4) * rowH;
  return [...cards, { id: 'networking-tracker', live: false, x: width / 2, y: stripY }];
}

function decorGame(width: number, height: number, twoCols: boolean, count = 900) {
  const d = layoutDecor(dots(width, twoCols), width, height);
  return new GridGame({
    cols: d.lattice.cols,
    rows: d.lattice.rows,
    nodes: d.nodes,
    bounds: d.bounds,
    levels: [d.level!],
    count,
    seed: 11,
    decorative: true,
  });
}

describe('decorative lattice', () => {
  for (const [w, h, two] of [
    [1280, 900, true],
    [1440, 960, true],
    [760, 1100, true],
    [375, 1400, false],
    [320, 1500, false],
  ] as const) {
    it(`puts every dot column on a conductor and the first dot on a vertex: ${w}×${h}`, () => {
      const cards = dots(w, two);
      const lat = decorLattice(w, h, cards);
      expect(lat.spacing).toBeGreaterThanOrEqual(52);
      expect(lat.spacing).toBeLessThanOrEqual(96);
      // Bleeds past every edge.
      expect(lat.ox).toBeLessThanOrEqual(0);
      expect(lat.oy).toBeLessThanOrEqual(0);
      expect(lat.ox + (lat.cols - 1) * lat.spacing).toBeGreaterThanOrEqual(w);
      expect(lat.oy + (lat.rows - 1) * lat.spacing).toBeGreaterThanOrEqual(h);
      const off = (v: number, o: number) => {
        const d = (v - o) / lat.spacing;
        return Math.abs(d - Math.round(d)) * lat.spacing;
      };
      for (const c of cards) expect(off(c.x, lat.ox)).toBeLessThanOrEqual(1);
      expect(off(cards[0].y, lat.oy)).toBeLessThan(1e-6);
    });
  }

  it('falls back to the plain lattice with no dots', () => {
    const lat = decorLattice(800, 600, []);
    expect(lat.spacing).toBe(Math.round(Math.min(96, Math.max(52, 600 / 8.5))));
  });

  it('anchors are distinct vertices near their dots', () => {
    for (const [w, h, two] of [
      [1280, 900, true],
      [375, 1400, false],
    ] as const) {
      const cards = dots(w, two);
      const d = layoutDecor(cards, w, h);
      const verts = new Set(d.nodes.map((n) => `${n.col},${n.row}`));
      expect(verts.size).toBe(cards.length);
      d.nodes.forEach((n, i) => {
        const p = toPx(d.lattice, n.col, n.row);
        expect(Math.hypot(p.x - cards[i].x, p.y - cards[i].y)).toBeLessThanOrEqual(d.lattice.spacing * 0.75);
        expect(n.kind).toBe(cards[i].live ? 'plant' : 'section');
      });
    }
  });

  it('two cards on one vertex: the second moves to a free neighbour', () => {
    const d = layoutDecor(
      [
        { id: 'a', live: true, x: 200, y: 200 },
        { id: 'b', live: false, x: 201, y: 201 },
      ],
      800,
      600,
    );
    expect(`${d.nodes[0].col},${d.nodes[0].row}`).not.toBe(`${d.nodes[1].col},${d.nodes[1].row}`);
  });
});

describe('decorative level', () => {
  it('live cards are plants, the rest loads; degenerate sets still have both', () => {
    expect(decorLevel([{ id: 'a', live: true }, { id: 'b', live: false }])).toMatchObject({ plants: ['a'], loads: ['b'] });
    expect(decorLevel([{ id: 'a', live: false }, { id: 'b', live: false }])).toMatchObject({ plants: ['a'], loads: ['b'] });
    expect(decorLevel([{ id: 'a', live: true }, { id: 'b', live: true }])).toMatchObject({ plants: ['a'], loads: ['b'] });
    expect(decorLevel([{ id: 'a', live: true }])).toBeNull();
  });
});

describe('decorative engine', () => {
  it('flows card to card with no loss, no heat and nothing placeable', () => {
    const game = decorGame(1280, 900, true);
    expect(game.decorative).toBe(true);
    expect(game.faulted.every((f) => f === 0)).toBe(true);
    for (let r = game.bounds.minR; r <= game.bounds.maxR; r++) {
      for (let c = game.bounds.minC; c <= game.bounds.maxC; c++) expect(game.canPlace(c, r)).toBe(false);
    }
    expect(game.placeTransformer(game.bounds.minC + 1, game.bounds.minR + 1)).toBe(false);
    run(game, 8);
    expect(game.heat.every((v) => v === 0)).toBe(true);
    for (let i = 0; i < game.count; i++) {
      if (game.ambient[i]) continue;
      expect(game.energy[i]).toBe(1);
      expect(Math.abs(game.hue[i])).toBe(0);
    }
    for (const k of game.activeLoads) expect(game.delivered[k], game.nodes[k].id).toBeGreaterThan(0);
    // Every load is reached at full efficiency from some plant (lossless).
    for (const r of game.routes) expect(r.plant).toBeGreaterThanOrEqual(0);
  });

  it('runs on a phone-tall single column too', () => {
    const game = decorGame(375, 1400, false, 600);
    run(game, 8);
    for (const k of game.activeLoads) expect(game.delivered[k]).toBeGreaterThan(0);
  });
});

describe('focus', () => {
  const deliveredTo = (game: GridGame, k: number, seconds: number) => {
    const d0 = game.delivered[k];
    run(game, seconds);
    return game.delivered[k] - d0;
  };

  it('pulls the flow toward the focused node, a load or a plant', () => {
    for (const k of [3, 0]) {
      const plain = decorGame(1280, 900, true);
      const pulled = decorGame(1280, 900, true);
      run(plain, 4);
      run(pulled, 4);
      pulled.setFocus(k, 0.6);
      expect(pulled.focus).toBe(k);
      const a = deliveredTo(plain, k, 6);
      const b = deliveredTo(pulled, k, 6);
      expect(b, `node ${k}`).toBeGreaterThan(a * 1.4 + 5);
    }
  });

  it('moving the focus retargets packets; clearing it stops new ones', () => {
    // Nodes 0 and 1 are the plants: no packet targets them without a focus.
    const game = decorGame(1280, 900, true);
    const aimed = (k: number) => [...game.target].filter((t) => t === k).length;
    game.setFocus(0);
    run(game, 3);
    expect(aimed(0)).toBeGreaterThan(0);
    game.setFocus(1);
    expect(aimed(0)).toBe(0);
    expect(aimed(1)).toBeGreaterThan(0);
    const before = aimed(1);
    game.setFocus(-1);
    expect(game.focus).toBe(-1);
    run(game, 12);
    // A few stragglers can still be wandering back from the lattice edge.
    expect(aimed(1)).toBeLessThanOrEqual(Math.max(3, before * 0.02));
  });

  it('ignores out-of-range nodes', () => {
    const game = decorGame(1280, 900, true);
    game.setFocus(99);
    expect(game.focus).toBe(-1);
    game.setFocus(1.5);
    expect(game.focus).toBe(-1);
  });

  it('leaves the default flow untouched until a focus is set', () => {
    const make = () => GridGame.fromLayout(layoutGame(NODES, 1440, 900), { count: 500, seed: 5 });
    const a = make();
    const b = make();
    b.setFocus(3);
    b.setFocus(-1); // set and cleared before any spawn: no random numbers drawn
    run(a, 3);
    run(b, 3);
    expect([...b.x]).toEqual([...a.x]);
    expect([...b.delivered]).toEqual([...a.delivered]);
  });

  it('works in the game too: focus on a load raises its deliveries', () => {
    const plain = GridGame.fromLayout(layoutGame(NODES, 1440, 900), { count: 800, seed: 5 });
    const pulled = GridGame.fromLayout(layoutGame(NODES, 1440, 900), { count: 800, seed: 5 });
    const k = plain.nodeIndex('contact');
    pulled.setFocus(k, 0.5);
    run(plain, 8);
    run(pulled, 8);
    // Not a level target, so only focus packets reach it.
    expect(plain.delivered[k]).toBe(0);
    expect(pulled.delivered[k] + pulled.sparked[k]).toBeGreaterThan(0);
  });
});
