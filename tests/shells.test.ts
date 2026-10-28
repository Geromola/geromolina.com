import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/shells/catalog';
import { MATCH_MAX, cubeDistance, identifyFromCache } from '../src/shells/identify';
import { LESSONS, parseProgress, serializeProgress } from '../src/shells/lessons';
import {
  ShellMesh,
  INDEX_COUNT,
  VERTEX_COUNT,
  IDENTITY,
  multiply,
  orbitCamera,
  transform,
} from '../src/shells/mesh';
import {
  D_MAX,
  PRESETS,
  REGIONS,
  T_MAX,
  W_MAX,
  W_MIN,
  centre,
  classify,
  coilKind,
  formatParam,
  fromPos,
  parseParams,
  serializeParams,
  surfacePoint,
  toPos,
  touchBoundaryD,
  whorlCount,
  whorlsTouch,
} from '../src/shells/model';
import { boundaryPolyline, fromMap, fromStrip, mapPoint, randomEmptyPoint, regionSlices, stripPos } from '../src/shells/morphospace';

const TAU = Math.PI * 2;
const dist = (p: number[]) => Math.hypot(p[0], p[1]);

describe('Raup model', () => {
  it('D is the inner edge over the outer edge', () => {
    for (const D of [0, 0.2, 0.5, 0.9]) {
      const p = { W: 2, D, T: 0 };
      const outer = dist(surfacePoint(p, -1, 0));
      const inner = dist(surfacePoint(p, -1, Math.PI));
      expect(inner / outer).toBeCloseTo(D, 10);
    }
  });

  it('D = 0 puts the inner edge on the axis', () => {
    expect(dist(surfacePoint({ W: 3, D: 0, T: 0.5 }, -2, Math.PI))).toBeCloseTo(0, 10);
  });

  it('is self-similar: one turn later every point is W times further out', () => {
    const p = { W: 2.5, D: 0.3, T: 1.4 };
    for (const phi of [0, 1, 2.5]) {
      const a = surfacePoint(p, -3, phi);
      const b = surfacePoint(p, -3 + TAU, phi);
      for (let k = 0; k < 3; k++) expect(b[k]).toBeCloseTo(a[k] * p.W, 9);
    }
  });

  it('T is axial translation per unit of distance from the axis', () => {
    const p = { W: 2, D: 0.2, T: 1.7 };
    const c = centre(p, -1.3);
    expect(-c[2] / dist(c)).toBeCloseTo(p.T, 10);
  });

  it('whorls touch below Raup’s hyperbola W·D = 1 when T = 0', () => {
    for (const W of [1.5, 2, 4, 10, 1000]) {
      expect(touchBoundaryD(W, 0)).toBeCloseTo(1 / W, 10);
      expect(whorlsTouch({ W, D: (1 / W) * 0.98, T: 0 })).toBe(true);
      expect(whorlsTouch({ W, D: Math.min(D_MAX, (1 / W) * 1.02), T: 0 })).toBe(false);
    }
  });

  it('a tall spire pulls whorls apart, and the boundary moves with T', () => {
    expect(touchBoundaryD(2, 2)).toBeLessThan(touchBoundaryD(2, 0));
    expect(whorlsTouch({ W: 2, D: 0, T: 0 })).toBe(true);
    expect(whorlsTouch({ W: 4, D: 0, T: 4 })).toBe(false);
    // Boundary agrees with the predicate.
    for (const [W, T] of [[1.3, 1], [3, 0.5], [8, 2]]) {
      const Db = touchBoundaryD(W, T);
      if (Db > 0.01) expect(whorlsTouch({ W, D: Db * 0.99, T })).toBe(true);
      expect(whorlsTouch({ W, D: Db * 1.01 + 1e-6, T })).toBe(false);
    }
  });

  it('draws at most 8 whorls, and less than one once W reaches 10³', () => {
    expect(whorlCount(1.01)).toBe(8);
    expect(whorlCount(2)).toBe(8);
    expect(whorlCount(1e3)).toBeCloseTo(1, 10);
    expect(whorlCount(1e5)).toBeLessThan(1);
    expect(whorlCount(W_MAX)).toBeCloseTo(0.5, 10);
  });

  it('places every preset in its region', () => {
    for (const p of PRESETS) expect(classify(p)?.id, p.id).toBe(p.group);
  });

  it('round-trips control positions and ticks span the track', () => {
    for (const k of ['W', 'D', 'T'] as const) {
      for (const t of [0, 0.25, 0.5, 1]) expect(toPos(k, fromPos(k, t))).toBeCloseTo(t, 10);
    }
    expect(fromPos('W', 0)).toBeCloseTo(W_MIN, 10);
    expect(fromPos('W', 1)).toBeCloseTo(W_MAX, 4);
    expect(fromPos('D', 2)).toBe(D_MAX);
    expect(fromPos('T', -1)).toBe(0);
  });

  it('formats readouts', () => {
    expect(formatParam('W', 2)).toBe('2.00');
    expect(formatParam('W', 300.4)).toBe('300');
    expect(formatParam('W', 12345)).toBe('12,000');
    expect(formatParam('W', W_MAX)).toBe('1,000,000');
    expect(formatParam('D', 0.333)).toBe('0.33');
  });

  it('round-trips the URL hash and rejects partial or bad hashes', () => {
    const p = { W: 2.2, D: 0.1, T: 1.2 };
    expect(parseParams(`#${serializeParams(p)}`)).toEqual(p);
    expect(parseParams('#W=2&D=0.1')).toBeNull();
    expect(parseParams('#W=x&D=0&T=0')).toBeNull();
    expect(parseParams('#W=1e9&D=3&T=-2')).toEqual({ W: W_MAX, D: D_MAX, T: 0 });
    expect(parseParams(`#${serializeParams({ W: 12345, D: 0, T: 0 })}`)?.W).toBe(12300);
  });
});

describe('mesh', () => {
  const extremes = [
    { W: W_MIN, D: 0, T: 0 },
    { W: W_MIN, D: D_MAX, T: T_MAX },
    { W: 2, D: D_MAX, T: 0 },
    { W: W_MAX, D: 0, T: 0 },
    { W: W_MAX, D: D_MAX, T: T_MAX },
    { W: 1.25, D: 0.05, T: T_MAX },
  ];

  it('has fixed topology and valid indices', () => {
    const m = new ShellMesh();
    expect(m.indices.length).toBe(INDEX_COUNT);
    expect(m.positions.length).toBe(VERTEX_COUNT * 3);
    let max = 0;
    for (const i of m.indices) max = Math.max(max, i);
    expect(max).toBe(VERTEX_COUNT - 1);
    expect(VERTEX_COUNT).toBeLessThan(65536);
  });

  it('builds finite positions and unit normals at the extremes of the cube', () => {
    const m = new ShellMesh();
    for (const p of extremes) {
      m.build(p);
      for (const v of m.positions) expect(Number.isFinite(v)).toBe(true);
      for (let k = 0; k < m.normals.length; k += 3) {
        expect(Math.hypot(m.normals[k], m.normals[k + 1], m.normals[k + 2])).toBeCloseTo(1, 4);
      }
      expect(m.bounds.radius).toBeGreaterThan(0);
      expect(m.bounds.centre.every(Number.isFinite)).toBe(true);
    }
  });

  it('ends at the aperture: the last row is the generating circle at θ = 0', () => {
    const m = new ShellMesh();
    const p = { W: 2, D: 0.3, T: 1 };
    m.build(p);
    const k = (VERTEX_COUNT - 33) * 3; // first vertex of the last row
    const want = surfacePoint(p, 0, 0);
    for (let c = 0; c < 3; c++) expect(m.positions[k + c]).toBeCloseTo(want[c], 4);
    expect(m.uv[k]).toBe(1);
    // At θ = 0, φ = 0 (outer edge) the normal points away from the axis.
    expect(m.normals[k]).toBeGreaterThan(0.5);
  });

  it('mirrored bounds are symmetric in y', () => {
    const m = new ShellMesh();
    m.build({ W: 300, D: 0.1, T: 0.25 }, true);
    expect(m.bounds.centre[1]).toBeCloseTo(0, 6);
  });

  it('the orbit camera keeps the bounding sphere in view', () => {
    const m = new ShellMesh();
    for (const p of extremes) {
      m.build(p);
      for (const aspect of [0.5, 1, 2]) {
        const cam = orbitCamera(m.bounds.centre, m.bounds.radius, 0.7, 0.4, aspect);
        const mvp = multiply(cam.proj, multiply(cam.view, IDENTITY));
        for (let k = 0; k < m.positions.length; k += 99) {
          const [x, y, z, w] = transform(mvp, m.positions[k], m.positions[k + 1], m.positions[k + 2]);
          expect(w).toBeGreaterThan(0);
          for (const c of [x / w, y / w, z / w]) expect(Math.abs(c)).toBeLessThanOrEqual(1.0001);
        }
      }
    }
  });
});

describe('morphospace', () => {
  it('round-trips map and strip positions', () => {
    const p = { W: 37, D: 0.42 };
    const [x, y] = mapPoint(p);
    const q = fromMap(x, y);
    expect(q.W).toBeCloseTo(p.W, 8);
    expect(q.D).toBeCloseTo(p.D, 10);
    expect(fromStrip(stripPos(2.5))).toBeCloseTo(2.5, 10);
    expect(fromMap(-1, 2)).toEqual({ W: W_MIN, D: D_MAX });
  });

  it('the boundary falls as W grows and sits at 1/W for T = 0', () => {
    const line = boundaryPolyline(0);
    for (let i = 1; i < line.length; i++) expect(line[i][1]).toBeLessThanOrEqual(line[i - 1][1] + 1e-12);
    const [x, y] = line[80];
    expect(y * D_MAX).toBeCloseTo(1 / fromMap(x, 0).W, 8);
  });

  it('slices regions by T', () => {
    const flat = regionSlices(0);
    expect(flat.find((s) => s.region.id === 'gastropods')?.active).toBe(false);
    expect(flat.find((s) => s.region.id === 'cephalopods')?.active).toBe(true);
    expect(regionSlices(2).find((s) => s.region.id === 'gastropods')?.active).toBe(true);
    for (const s of flat) {
      const [x0, y0, x1, y1] = s.rect;
      expect(x0).toBeLessThan(x1);
      expect(y0).toBeLessThan(y1);
    }
  });

  it('random empty points are empty, deterministic and readable', () => {
    for (let seed = 1; seed < 200; seed++) {
      const p = randomEmptyPoint(seed);
      expect(classify(p)).toBeNull();
      expect(p.D).toBeLessThanOrEqual(0.85);
      expect(p.W).toBeGreaterThanOrEqual(1.1);
    }
    expect(randomEmptyPoint(7)).toEqual(randomEmptyPoint(7));
  });

  it('every region is non-empty and inside the cube', () => {
    for (const r of REGIONS) {
      expect(r.logW[0]).toBeLessThan(r.logW[1]);
      expect(r.D[1]).toBeLessThanOrEqual(D_MAX);
      expect(r.T[1]).toBeLessThanOrEqual(T_MAX);
    }
  });
});

describe('lessons', () => {
  it('target valid shells and controls', () => {
    expect(LESSONS.length).toBe(6);
    for (const l of LESSONS) {
      expect([null, 'W', 'D', 'T']).toContain(l.focus);
      expect(l.target.W).toBeGreaterThanOrEqual(W_MIN);
      expect(l.target.W).toBeLessThanOrEqual(W_MAX);
      expect(l.target.D).toBeLessThanOrEqual(D_MAX);
      expect(l.target.T).toBeLessThanOrEqual(T_MAX);
    }
    expect(LESSONS.at(-1)?.revealCube).toBe(true);
  });

  it('tell the truth about their shells', () => {
    const byId = Object.fromEntries(LESSONS.map((l) => [l.id, l]));
    expect(classify(byId.tube.target)?.id).toBe('cephalopods');
    expect(whorlsTouch(byId.D.target)).toBe(true);
    expect(classify(byId.T.target)?.id).toBe('gastropods');
    expect(classify(byId.clam.target)?.id).toBe('bivalves');
    expect(whorlCount(byId.clam.target.W)).toBeLessThan(1.25);
  });

  it('parses progress defensively', () => {
    expect(parseProgress(null)).toEqual({ step: 0, cubeSeen: false });
    expect(parseProgress('{bad')).toEqual({ step: 0, cubeSeen: false });
    expect(parseProgress('{"step":99,"cubeSeen":true}')).toEqual({ step: 5, cubeSeen: true });
    const p = { step: 3, cubeSeen: false };
    expect(parseProgress(serializeProgress(p))).toEqual(p);
  });
});

describe('catalog and identifier', () => {
  it('every entry is a valid shell with facts, a credit and a source', () => {
    const ids = new Set<string>();
    for (const e of CATALOG) {
      expect(ids.has(e.id), e.id).toBe(false);
      ids.add(e.id);
      expect(e.W).toBeGreaterThanOrEqual(W_MIN);
      expect(e.W).toBeLessThanOrEqual(W_MAX);
      expect(e.D).toBeGreaterThanOrEqual(0);
      expect(e.D).toBeLessThanOrEqual(D_MAX);
      expect(e.T).toBeGreaterThanOrEqual(0);
      expect(e.T).toBeLessThanOrEqual(T_MAX);
      expect(e.facts).toHaveLength(3);
      for (const f of [e.habitat, e.use, ...e.facts]) expect(f.length).toBeGreaterThan(10);
      expect(e.image.author.length).toBeGreaterThan(0);
      expect(e.image.license).toMatch(/^(CC BY|Public domain)/);
      expect(e.image.source).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
      expect(e.wiki).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\//);
    }
    expect(CATALOG.length).toBe(16);
  });

  it('presets are catalog entries', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(5);
    for (const p of PRESETS) expect(CATALOG).toContain(p);
  });

  it('every entry identifies as itself, and the others are told apart', () => {
    for (const e of CATALOG) {
      const id = identifyFromCache(e);
      expect(id.entry.id, e.id).toBe(e.id);
      expect(id.tier).toBe('match');
      expect(id.distance).toBe(0);
    }
    // No two entries are so close that one could never be told from the other.
    for (const a of CATALOG) for (const b of CATALOG) if (a !== b) expect(cubeDistance(a, b), `${a.id}/${b.id}`).toBeGreaterThan(MATCH_MAX / 2);
  });

  it('runners-up are the next two, distinct and in order', () => {
    const p = { W: 2.1, D: 0.2, T: 0.4 };
    const id = identifyFromCache(p);
    const all = [id.entry, ...id.runnersUp];
    expect(new Set(all.map((e) => e.id)).size).toBe(3);
    const d = all.map((e) => cubeDistance(p, e));
    expect(d[0]).toBeLessThanOrEqual(d[1]);
    expect(d[1]).toBeLessThanOrEqual(d[2]);
  });

  it('a shell far from every real one and outside the regions is flagged', () => {
    const p = { W: 1e3, D: 0.85, T: 3.5 };
    expect(classify(p)).toBeNull();
    const id = identifyFromCache(p);
    expect(id.tier).toBe('none');
    expect(id.distance).toBeGreaterThan(4);
  });

  it('a near miss resembles its neighbour', () => {
    const id = identifyFromCache({ W: 2.6, D: 0.1, T: 1.6 });
    expect(id.entry.id).toBe('garden-snail');
    expect(id.tier).not.toBe('none');
  });
});

describe('coil kind', () => {
  it('agrees with whorlsTouch: loose exactly when whorls do not touch', () => {
    for (const W of [1.05, 1.4, 2, 3, 10, 300]) {
      for (const D of [0, 0.1, 0.3, 0.5, 0.7, 0.9]) {
        for (const T of [0, 0.5, 2, 4]) {
          const p = { W, D, T };
          expect(coilKind(p) === 'loose', JSON.stringify(p)).toBe(!whorlsTouch(p));
        }
      }
    }
  });

  it('names the classic shells', () => {
    const by = Object.fromEntries(CATALOG.map((e) => [e.id, e]));
    expect(coilKind(by.nautilus)).toBe('involute');
    expect(coilKind(by['garden-snail'])).toBe('overlapping');
    expect(coilKind(by.spirula)).toBe('loose');
    expect(coilKind(by.wentletrap)).toBe('loose');
  });
});
