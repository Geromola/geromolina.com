import { describe, expect, it } from 'vitest';
import { corridorPaths, corridorTransformers, menuLattice, snapMenu, type MenuPoint } from '../src/grid/game/decor';
import { GridGame } from '../src/grid/game/engine';
import { visibleBounds } from '../src/grid/game/layout';
import { LIT_THRESHOLD } from '../src/grid/game/physics';
import { layoutGame } from '../src/grid/game/layout';
import { toPx } from '../src/grid/layout';
import { NODES } from './fixtures/nodes';

/** The node menu (SPEC "Home hero v3"): plants first, then the loads, as NodeMenu.astro orders them. */
const IDS = [
  'spotify-insight',
  'custom-llm',
  'personal-wiki',
  'pacman-dqn',
  'ballpark',
  'networking-tracker',
  'about',
  'off-the-grid',
  'contact',
];
const PLANTS = 2;

/** Glyph centres the way the CSS lays the rows out on desktop: centred, 2 / 3 / 4 per row. */
function desktop(width: number): MenuPoint[] {
  const cx = width / 2;
  return [
    { x: cx - 192, y: 404 },
    { x: cx + 192, y: 404 },
    { x: cx - 336, y: 655 },
    { x: cx, y: 655 },
    { x: cx + 336, y: 655 },
    { x: cx - 300, y: 842 },
    { x: cx - 110, y: 842 },
    { x: cx + 75, y: 842 },
    { x: cx + 260, y: 842 },
  ];
}

/** Phones: one column on the spine, short gaps between the small pills. */
function phone(): MenuPoint[] {
  return [380, 572, 764, 900, 1032, 1110, 1166, 1222, 1278].map((y) => ({ x: 44, y }));
}

function onVertex(lat: { ox: number; oy: number; spacing: number }, x: number, y: number) {
  const off = (v: number, o: number) => {
    const d = (v - o) / lat.spacing;
    return Math.abs(d - Math.round(d)) * lat.spacing;
  };
  return off(x, lat.ox) < 1e-6 && off(y, lat.oy) < 1e-6;
}

/** Apply a snap the way the page does: x nudges, and each line's margin pushes everything below it. */
function snapped(points: MenuPoint[], snap: ReturnType<typeof snapMenu>) {
  const order = points.map((_, i) => i).sort((a, b) => points[a].y - points[b].y);
  const out = points.map((p) => ({ ...p }));
  let carry = 0;
  let lastY = -Infinity;
  for (const i of order) {
    if (points[i].y - lastY > 2) {
      carry += snap.snaps[i].dy;
      lastY = points[i].y;
    }
    out[i] = { x: points[i].x + snap.snaps[i].dx, y: points[i].y + carry };
  }
  return out;
}

function menuGame(points: MenuPoint[], anchorX: number, width: number, opts: { spacing?: number; corridors?: boolean } = {}) {
  const snap = snapMenu(points, { anchorX, spacing: opts.spacing });
  const height = Math.max(...points.map((p) => p.y)) + snap.grow + 160;
  const lattice = menuLattice(snap, width, height);
  const bounds = visibleBounds(lattice, width, height);
  const nodes = IDS.map((id, i) => ({ id, kind: i < PLANTS ? ('plant' as const) : ('section' as const), ...snap.snaps[i] }));
  const game = new GridGame({
    cols: lattice.cols,
    rows: lattice.rows,
    nodes,
    bounds,
    levels: [{ title: 'Menu', plants: IDS.slice(0, PLANTS), loads: IDS.slice(PLANTS), budget: 0 }],
    count: 900,
    seed: 7,
    decorative: true,
  });
  if (opts.corridors !== false) {
    const verts = new Set(nodes.map((n) => game.board.vertex(n.col, n.row)));
    const at = (k: number) => game.board.vertex(nodes[k].col, nodes[k].row);
    game.setDecorTransformers(
      corridorTransformers(
        game.board,
        bounds,
        verts,
        game.activePlants.map(at),
        game.activeLoads.map(at),
      ),
    );
  }
  return { game, snap, lattice };
}

function run(game: GridGame, seconds: number, dt = 1 / 30) {
  for (let t = 0; t < seconds; t += dt) game.step(dt);
}

describe('snapMenu', () => {
  for (const width of [1280, 1440, 1024]) {
    it(`desktop ${width}: every glyph on a vertex, rows kept in order, small symmetric nudges`, () => {
      const pts = desktop(width);
      const snap = snapMenu(pts, { anchorX: width / 2 });
      expect(snap.spacing).toBeGreaterThanOrEqual(56);
      expect(snap.spacing).toBeLessThanOrEqual(76);
      expect(snap.ox).toBeLessThanOrEqual(0);
      expect(snap.oy).toBeLessThanOrEqual(0);
      const after = snapped(pts, snap);
      after.forEach((p, i) => {
        expect(onVertex(snap, p.x, p.y), `point ${i}`).toBe(true);
        const v = toPx(menuLattice(snap, width, 2000), snap.snaps[i].col, snap.snaps[i].row);
        expect(v.x).toBeCloseTo(p.x, 6);
        expect(v.y).toBeCloseTo(p.y, 6);
        expect(Math.abs(snap.snaps[i].dx)).toBeLessThanOrEqual(snap.spacing / 2 + 1e-9);
        expect(snap.snaps[i].dy).toBeGreaterThanOrEqual(0);
        expect(snap.snaps[i].dy).toBeLessThan(snap.spacing);
      });
      // The featured row doesn't move down; each later row lands on a lower lattice row.
      expect(snap.snaps[0].dy).toBe(0);
      expect(snap.snaps[2].row).toBeGreaterThan(snap.snaps[0].row);
      expect(snap.snaps[5].row).toBeGreaterThan(snap.snaps[2].row);
      // Symmetric pairs stay symmetric.
      expect(snap.snaps[0].dx).toBeCloseTo(-snap.snaps[1].dx, 6);
      expect(snap.snaps[2].dx).toBeCloseTo(-snap.snaps[4].dx, 6);
      expect(snap.snaps[3].dx).toBeCloseTo(0, 6);
      const verts = new Set(snap.snaps.map((s) => `${s.col},${s.row}`));
      expect(verts.size).toBe(pts.length);
    });
  }

  it('phones: one spine column, distinct rows in order, never moved sideways', () => {
    const pts = phone();
    const snap = snapMenu(pts, { anchorX: 44, spacing: 58 });
    expect(snap.spacing).toBe(58);
    const cols = new Set(snap.snaps.map((s) => s.col));
    expect(cols.size).toBe(1);
    snap.snaps.forEach((s, i) => {
      expect(s.dx).toBe(0);
      if (i) expect(s.row).toBeGreaterThan(snap.snaps[i - 1].row);
    });
    snapped(pts, snap).forEach((p) => expect(onVertex(snap, p.x, p.y)).toBe(true));
  });

  it('never picks a spacing that puts two glyphs of a row on one vertex', () => {
    const pts = [
      { x: 470, y: 300 },
      { x: 530, y: 300 },
    ];
    const snap = snapMenu(pts, { anchorX: 500 });
    expect(snap.snaps[0].col).not.toBe(snap.snaps[1].col);
  });
});

describe('corridors', () => {
  for (const [label, pts, anchor, width, spacing] of [
    ['desktop 1280', desktop(1280), 640, 1280, undefined],
    ['desktop 1440', desktop(1440), 720, 1440, undefined],
    ['phone 375', phone(), 44, 375, 58],
  ] as const) {
    it(`${label}: hidden transformers light every node, along 345 kV corridors`, () => {
      const { game } = menuGame([...pts], anchor, width, { spacing });
      expect(game.transformers.length).toBe(IDS.length);
      // Hidden transformers never sit on a node.
      for (const t of game.transformers) expect(game.nodeAtVertex(t.col, t.row)).toBe(-1);
      const ev = game.evaluate();
      for (const l of ev.perLoad) expect(l.efficiency, l.id).toBeGreaterThanOrEqual(LIT_THRESHOLD);

      const paths = corridorPaths(game);
      expect(paths).toHaveLength(IDS.length - PLANTS);
      for (const p of paths) {
        const id = game.nodes[p.load].id;
        expect(p.plant, id).toBeGreaterThanOrEqual(0);
        expect(p.plant, id).toBeLessThan(PLANTS);
        // Path is connected, starts at the plant and ends at the load.
        let at = game.board.vertex(game.nodes[p.plant].col, game.nodes[p.plant].row);
        for (const s of p.steps) {
          const { edgeA, edgeB } = game.board;
          expect([edgeA[s.edge], edgeB[s.edge]], id).toContain(at);
          at = edgeA[s.edge] === at ? edgeB[s.edge] : edgeA[s.edge];
        }
        expect(at, id).toBe(game.board.vertex(game.nodes[p.load].col, game.nodes[p.load].row));
        // Cyan out of the plant and into the load, white-hot in between.
        expect(p.steps[0].high, id).toBe(false);
        expect(p.steps[p.steps.length - 1].high, id).toBe(false);
        if (p.steps.length > 3) expect(p.steps.some((s) => s.high), id).toBe(true);
      }

      // The phone spine is long: the farthest node is ~14 segments down at 345 kV drift.
      run(game, width < 720 ? 16 : 8);
      for (const k of game.activeLoads) {
        expect(game.delivered[k], game.nodes[k].id).toBeGreaterThan(0);
        expect(game.sparked[k], game.nodes[k].id).toBeLessThanOrEqual(game.delivered[k] * 0.05);
      }
      let hot = 0;
      for (let i = 0; i < game.count; i++) if (!game.ambient[i] && game.hue[i] === 1) hot++;
      expect(hot).toBeGreaterThan(20);
      expect(game.heat.every((v) => v === 0)).toBe(true);
    });
  }

  it('without them, the same board has no 345 kV flow', () => {
    const { game } = menuGame(desktop(1280), 640, 1280, { corridors: false });
    run(game, 4);
    for (let i = 0; i < game.count; i++) expect(game.hue[i]).toBeLessThanOrEqual(0);
  });

  it('focus still pulls the flow, through the hidden transformers', () => {
    const a = menuGame(desktop(1280), 640, 1280).game;
    const b = menuGame(desktop(1280), 640, 1280).game;
    const k = b.nodeIndex('about');
    run(a, 3);
    run(b, 3);
    b.setFocus(k, 0.6);
    const d0a = a.delivered[k];
    const d0b = b.delivered[k];
    run(a, 6);
    run(b, 6);
    expect(b.delivered[k] - d0b).toBeGreaterThan((a.delivered[k] - d0a) * 1.4 + 5);
  });
});

describe('setDecorTransformers', () => {
  it('is refused by the game, which keeps its transformers', () => {
    const game = GridGame.fromLayout(layoutGame(NODES, 1440, 900), { count: 100 });
    const spot = game.solverPlacement[0];
    expect(game.placeTransformer(spot.col, spot.row)).toBe(true);
    expect(game.setDecorTransformers([{ col: 1, row: 1 }])).toBe(false);
    expect(game.transformers).toEqual([spot]);
  });

  it('skips nodes, duplicates and vertices off the lattice, and replaces the previous set', () => {
    const { game } = menuGame(desktop(1280), 640, 1280, { corridors: false });
    const node = game.nodes[0];
    const free = { col: node.col + 2, row: node.row + 1 };
    expect(game.setDecorTransformers([{ col: node.col, row: node.row }, free, free, { col: -1, row: 0 }])).toBe(true);
    expect(game.transformers).toEqual([free]);
    expect(game.canPlace(free.col + 1, free.row)).toBe(false);
    game.setDecorTransformers([]);
    expect(game.transformers).toEqual([]);
  });
});
