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

  it('v3.1 zones: a grid sized for 64px snaps with no nudges, and flows carry their own margins', () => {
    // PROJECTS 3×2 at 256px × 192px, ABOUT ME a column 320px right of the last project column.
    const x0 = 200;
    const y0 = 170;
    const pts: MenuPoint[] = [
      ...[0, 1, 2, 3, 4, 5].map((k) => ({ x: x0 + (k % 3) * 256, y: y0 + Math.floor(k / 3) * 192, flow: 0 })),
      ...[0, 1, 2].map((k) => ({ x: x0 + 2 * 256 + 320, y: y0 + k * 192, flow: 1 })),
    ];
    const snap = snapMenu(pts, { anchorX: x0, min: 52, max: 76, prefer: 64 });
    expect(snap.spacing).toBe(64);
    for (const s of snap.snaps) {
      expect(Math.abs(s.dx)).toBeLessThan(1e-9);
      expect(s.dy).toBeLessThan(1e-9);
    }
    // Off the 64px fit (another root size), the ABOUT ME column's margins don't move the projects.
    const off = pts.map((p) => (p.flow === 1 && p.y > y0 ? { ...p, y: p.y + 10 } : p));
    const snap2 = snapMenu(off, { anchorX: x0, spacing: 64 });
    expect(snap2.snaps[3].dy).toBe(0);
    expect(snap2.snaps[7].dy).toBeCloseTo(54, 6);
    // Its next line already carries those 54px, which lands it exactly on a row (3 below).
    expect(snap2.snaps[8].dy).toBeCloseTo(0, 6);
    expect(snap2.snaps[8].row - snap2.snaps[7].row).toBe(3);
    expect(snap2.grow).toBeCloseTo(54, 6);
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

// ------------------------------------------------------------------ v3.2
import { MENU_PX, circuitPaths, circuitTransformers, menuLayout, type LatticeRect, type MenuLayout } from '../src/grid/game/decor';

const GUTTER = (w: number) => Math.min(32, Math.max(16, w * 0.03));

/** Plate box (lattice units, relative to the glyph's vertex) for a section's style. */
function plateBox(l: MenuLayout, sec: MenuLayout['about'], c: { col: number; row: number }): LatticeRect {
  const s = l.spacing;
  const g = MENU_PX.glyph / 2;
  if (sec.style === 'hang') {
    return { c0: c.col - sec.plateW / 2 / s, c1: c.col + sec.plateW / 2 / s, r0: c.row - g / s, r1: c.row + MENU_PX.hangH / s };
  }
  return {
    c0: c.col - g / s,
    c1: c.col + (g + MENU_PX.sideGap + sec.plateW) / s,
    r0: c.row - MENU_PX.sideH / 2 / s,
    r1: c.row + MENU_PX.sideH / 2 / s,
  };
}
const inside = (a: LatticeRect, b: LatticeRect) => a.c0 >= b.c0 && a.c1 <= b.c1 && a.r0 >= b.r0 && a.r1 <= b.r1;
const overlap = (a: LatticeRect, b: LatticeRect) => a.c0 < b.c1 && b.c0 < a.c1 && a.r0 < b.r1 && b.r0 < a.r1;
const isLines = (r: LatticeRect) => [r.c0, r.r0, r.c1, r.r1].every(Number.isInteger);

describe('menuLayout (v3.2 sections)', () => {
  for (const [w, mode] of [
    [1440, 'wide'],
    [1280, 'wide'],
    [1180, 'wide'],
    [1024, 'stacked'],
    [860, 'stacked'],
    [768, 'stacked'],
    [760, 'column'],
    [390, 'column'],
    [375, 'column'],
    [320, 'column'],
  ] as const) {
    it(`${w}px: ${mode}; fences on lattice lines, plates inside them, nothing overlaps, it fits`, () => {
      const l = menuLayout(w, { about: 3, projects: 6, gutter: GUTTER(w) });
      expect(l.mode).toBe(mode);
      expect(l.spacing).toBeGreaterThanOrEqual(52);
      expect(l.spacing).toBeLessThanOrEqual(64);
      expect((l.extent.c1 - l.extent.c0) * l.spacing).toBeLessThanOrEqual(w - 2 * GUTTER(w) + 1e-6);
      const boxes: LatticeRect[] = [];
      for (const sec of [l.about, l.projects]) {
        expect(isLines(sec.fence)).toBe(true);
        expect(isLines(sec.collapsed)).toBe(true);
        expect(inside(sec.collapsed, sec.fence)).toBe(true);
        // The switch sits inside both fences, on a vertex.
        const sw = { c0: sec.switch.col, c1: sec.switch.col, r0: sec.switch.row, r1: sec.switch.row };
        expect(inside(sw, sec.collapsed)).toBe(true);
        expect(sec.plateW).toBeGreaterThan(150);
        for (const c of sec.children) {
          expect(Number.isInteger(c.col) && Number.isInteger(c.row)).toBe(true);
          const box = plateBox(l, sec, c);
          expect(inside(box, sec.fence), `${w} ${c.col},${c.row}`).toBe(true);
          // Children are below the switch row: the collapsed fence holds none of them.
          expect(c.row).toBeGreaterThan(sec.collapsed.r1 - 1);
          for (const b of boxes) expect(overlap(box, b)).toBe(false);
          boxes.push(box);
        }
      }
      expect(overlap(l.about.fence, l.projects.fence)).toBe(false);
      // The root sits above both fences.
      expect(l.about.fence.r0).toBeGreaterThan(l.root.row);
      expect(l.projects.fence.r0).toBeGreaterThan(l.root.row);
      expect(l.about.children).toHaveLength(3);
      expect(l.projects.children).toHaveLength(6);
    });
  }

  it('a collapsed section moves what follows it up by whole rows (stacked, column); wide keeps everything', () => {
    for (const w of [1024, 768, 630, 375]) {
      const g = GUTTER(w);
      const open = menuLayout(w, { about: 3, projects: 6, gutter: g });
      const shut = menuLayout(w, { about: 3, projects: 6, gutter: g, collapsed: { about: true } });
      const up = open.about.fence.r1 - open.about.collapsed.r1;
      expect(up, `${w}`).toBeGreaterThan(0);
      expect(Number.isInteger(up)).toBe(true);
      // ABOUT ME itself and the root stay put.
      expect(shut.about).toEqual(open.about);
      expect(shut.root).toEqual(open.root);
      // PROJECTS (fence, switch, children) moves up by exactly those rows, still on vertices.
      expect(shut.projects.fence.r0).toBe(open.projects.fence.r0 - up);
      expect(shut.projects.collapsed.r1).toBe(open.projects.collapsed.r1 - up);
      expect(shut.projects.switch).toEqual({ ...open.projects.switch, row: open.projects.switch.row - up });
      shut.projects.children.forEach((c, k) => {
        expect(c.col).toBe(open.projects.children[k].col);
        expect(c.row).toBe(open.projects.children[k].row - up);
      });
      // It sits right under the collapsed switch area, with the same gap as before.
      expect(shut.projects.fence.r0 - shut.about.collapsed.r1).toBe(open.projects.fence.r0 - open.about.fence.r1);
      expect(shut.extent.r1).toBe(open.extent.r1 - up);
      // Collapsing PROJECTS (last) only shortens the menu.
      const both = menuLayout(w, { about: 3, projects: 6, gutter: g, collapsed: { about: true, projects: true } });
      expect(both.projects.switch).toEqual(shut.projects.switch);
      expect(both.extent.r1).toBe(shut.projects.collapsed.r1);
    }
    const wide = menuLayout(1440, { about: 3, projects: 6, gutter: 32 });
    const wideShut = menuLayout(1440, { about: 3, projects: 6, gutter: 32, collapsed: { about: true, projects: true } });
    expect(wideShut).toEqual(wide);
  });

  it('fenceTop moves everything but the root down a row', () => {
    const a = menuLayout(375, { about: 3, projects: 6, gutter: 16 });
    const b = menuLayout(375, { about: 3, projects: 6, gutter: 16, fenceTop: 2 });
    expect(b.root).toEqual(a.root);
    expect(b.about.fence.r0).toBe(a.about.fence.r0 + 1);
    expect(b.projects.children[5].row).toBe(a.projects.children[5].row + 1);
    expect(b.projects.collapsed.r1).toBe(a.projects.collapsed.r1 + 1);
    expect(b.extent.r1).toBe(a.extent.r1 + 1);
  });

  it('wide puts ABOUT ME left and PROJECTS right in 3×2; stacked and column put PROJECTS below', () => {
    const wide = menuLayout(1440, { about: 3, projects: 6, gutter: 32 });
    expect(wide.projects.fence.c0).toBeGreaterThan(wide.about.fence.c1 - 1);
    expect(new Set(wide.projects.children.map((c) => c.row)).size).toBe(2);
    expect(new Set(wide.projects.children.map((c) => c.col)).size).toBe(3);
    for (const w of [1024, 375]) {
      const l = menuLayout(w, { about: 3, projects: 6, gutter: GUTTER(w) });
      expect(l.projects.fence.r0).toBeGreaterThan(l.about.fence.r1 - 1);
    }
  });
});

/** The menu circuit on a real layout: root 0, switches 1–2, about children, then projects. */
function circuitGame(width: number) {
  const l = menuLayout(width, { about: 3, projects: 6, gutter: GUTTER(width) });
  // Lattice with the root at (2, 1), bleeding past the extent.
  const offC = 1 - l.extent.c0 + 1;
  const offR = 1;
  const cols = l.extent.c1 - l.extent.c0 + 4;
  const rows = l.extent.r1 + 3;
  const at = (p: { col: number; row: number }) => ({ col: p.col + offC, row: p.row + offR });
  const ids = ['root', 'sw-about', 'sw-projects', 'a0', 'a1', 'a2', 'p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
  const places = [l.root, l.about.switch, l.projects.switch, ...l.about.children, ...l.projects.children].map(at);
  const nodes = ids.map((id, i) => ({ id, kind: i === 0 ? ('plant' as const) : ('section' as const), ...places[i] }));
  const game = new GridGame({
    cols,
    rows,
    nodes,
    levels: [{ title: 'Menu', plants: ['root'], loads: ids.slice(1), budget: 0 }],
    count: 900,
    seed: 3,
    decorative: true,
  });
  const feeds = [
    { from: 0, to: 1 },
    { from: 0, to: 2 },
    ...[3, 4, 5].map((to) => ({ from: 1, to })),
    ...[6, 7, 8, 9, 10, 11].map((to) => ({ from: 2, to })),
  ];
  const vOf = (k: number) => game.board.vertex(nodes[k].col, nodes[k].row);
  game.setDecorTransformers(
    circuitTransformers(game.board, game.bounds, new Set(nodes.map((_, k) => vOf(k))), feeds.map((f) => ({ from: vOf(f.from), to: vOf(f.to) }))),
  );
  for (const f of feeds) if (f.from !== 0) game.setLoadSource(f.to, f.from);
  return { game, feeds, l };
}

describe('menu circuit (v3.2)', () => {
  for (const w of [1440, 1024, 375]) {
    it(`${w}px: the root feeds each switch at 345 kV, each switch its children`, () => {
      const { game, feeds } = circuitGame(w);
      expect(game.transformers).toHaveLength(12);
      const paths = circuitPaths(game, feeds);
      for (const p of paths) {
        const label = `${game.nodes[p.from].id}→${game.nodes[p.to].id}`;
        expect(p.steps.length, label).toBeGreaterThan(0);
        let at = game.board.vertex(game.nodes[p.from].col, game.nodes[p.from].row);
        for (const s of p.steps) {
          const { edgeA, edgeB } = game.board;
          expect([edgeA[s.edge], edgeB[s.edge]], label).toContain(at);
          at = edgeA[s.edge] === at ? edgeB[s.edge] : edgeA[s.edge];
        }
        expect(at, label).toBe(game.board.vertex(game.nodes[p.to].col, game.nodes[p.to].row));
        expect(p.steps[0].high, label).toBe(false);
        expect(p.steps[p.steps.length - 1].high, label).toBe(false);
        if (p.steps.length > 3) expect(p.steps.some((s) => s.high), label).toBe(true);
      }
      // Root → switch corridors are 345 kV for most of their length.
      for (const p of paths.slice(0, 2)) {
        if (p.steps.length > 3) expect(p.steps.filter((s) => s.high).length).toBeGreaterThanOrEqual(p.steps.length - 2);
      }
      // The longest branches are ~15 segments at 345 kV drift (plus the spawn spread).
      run(game, w < 720 ? 30 : 20);
      for (const k of game.activeLoads) expect(game.delivered[k], game.nodes[k].id).toBeGreaterThan(0);
    });
  }
});

describe('load switching', () => {
  it('disabled loads stop receiving packets, their branch drains, and they resume when enabled', () => {
    const { game } = circuitGame(1440);
    const kids = [6, 7, 8, 9, 10, 11];
    run(game, 4);
    for (const k of kids) expect(game.setLoadEnabled(k, false)).toBe(true);
    expect(game.isLoadEnabled(6)).toBe(false);
    // Packets already on the way arrive or fade out within the drain time; then nothing arrives.
    const visibleTo = () =>
      [...game.target].filter((t, i) => kids.includes(t) && !game.ambient[i] && game.bright[i] > 0).length;
    expect(visibleTo()).toBeGreaterThan(0);
    run(game, 3);
    expect(visibleTo()).toBe(0);
    const aimed = () => [...game.target].filter((t) => kids.includes(t)).length;
    const d0 = kids.map((k) => game.delivered[k]);
    run(game, 6);
    kids.forEach((k, i) => expect(game.delivered[k], game.nodes[k].id).toBe(d0[i]));
    // The other branch keeps flowing.
    const a0 = game.delivered[3];
    run(game, 3);
    expect(game.delivered[3]).toBeGreaterThan(a0);
    for (const k of kids) game.setLoadEnabled(k, true);
    run(game, 20);
    kids.forEach((k, i) => expect(game.delivered[k], game.nodes[k].id).toBeGreaterThan(d0[i]));
    expect(aimed()).toBeGreaterThan(0);
  });

  it('with every load disabled, packets wait hidden and leave once one is enabled', () => {
    const { game } = circuitGame(1440);
    for (const k of game.activeLoads) game.setLoadEnabled(k, false);
    // The packets already on their way (some still in the 3 s spawn spread) arrive or drain first.
    run(game, 6);
    for (let i = 0; i < game.count; i++) if (!game.ambient[i]) expect(game.bright[i]).toBe(0);
    run(game, 4);
    for (let i = 0; i < game.count; i++) if (!game.ambient[i]) expect(game.bright[i]).toBe(0);
    const d0 = game.delivered[1];
    game.setLoadEnabled(1, true);
    run(game, 6);
    expect(game.delivered[1]).toBeGreaterThan(d0);
    let lit = 0;
    for (let i = 0; i < game.count; i++) if (!game.ambient[i] && game.bright[i] > 0) lit++;
    expect(lit).toBeGreaterThan(20);
  });

  it('a load source makes its packets leave from that node; −1 restores the plant', () => {
    const { game } = circuitGame(1440);
    const sw = game.board.vertex(game.nodes[2].col, game.nodes[2].row);
    expect(game.setLoadSource(0, 1)).toBe(false); // the root isn't a load
    expect(game.setLoadSource(6, 99)).toBe(false);
    const root = game.board.vertex(game.nodes[0].col, game.nodes[0].row);
    for (const k of game.activeLoads) if (k !== 6) game.setLoadEnabled(k, false);
    run(game, 25);
    // Packets for p0 leave next to the projects switch. A few 345 kV packets wander widely
    // (their route costs barely differ), so one can pass the root, but none start there.
    const near = (i: number, v: number) =>
      Math.abs(game.x[i] - game.board.col(v)) + Math.abs(game.y[i] - game.board.row(v)) <= 1.01;
    let fromSwitch = 0;
    let fromRoot = 0;
    for (let f = 0; f < 30; f++) {
      run(game, 0.1);
      for (let i = 0; i < game.count; i++) {
        if (game.ambient[i] || game.bright[i] <= 0 || game.target[i] !== 6) continue;
        if (near(i, sw)) fromSwitch++;
        if (near(i, root)) fromRoot++;
      }
    }
    expect(fromSwitch).toBeGreaterThan(10);
    expect(fromRoot).toBeLessThan(fromSwitch / 4);
    expect(game.setLoadSource(6, -1)).toBe(true);
  });

  it('leaves the default flow untouched while every load stays enabled', () => {
    const a = circuitGame(1440).game;
    const b = circuitGame(1440).game;
    b.setLoadEnabled(6, true);
    run(a, 3);
    run(b, 3);
    expect([...b.x]).toEqual([...a.x]);
  });

  it('is refused for nodes that aren\'t active loads', () => {
    const { game } = circuitGame(1440);
    expect(game.setLoadEnabled(0, false)).toBe(false);
    expect(game.isLoadEnabled(0)).toBe(false);
    expect(game.setLoadEnabled(42, false)).toBe(false);
  });
});
