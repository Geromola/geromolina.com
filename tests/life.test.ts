import { describe, expect, it } from 'vitest';
import { Detector, occupied, speed } from '../src/life/detect';
import { BORDER, LIVE, LifeBoard, TRAIL } from '../src/life/engine';
import { LIBRARY, EATER, GOSPER, patternOf } from '../src/life/patterns';
import { normalize, parseRLE, toRLE, transform } from '../src/life/rle';
import {
  FIRST_FRAME,
  PERIOD,
  ReceiverReader,
  cleanText,
  decodeBits,
  encodeText,
  getScene,
  objects,
  place,
} from '../src/life/scenes';
import { TOUR, parseProgress, serializeProgress } from '../src/life/tour';
import { fit, screenToCell, cellToScreen, zoomAt } from '../src/life/view';

const at = (id: string, size = 512) => {
  const b = new LifeBoard(size);
  place(b, patternOf(id), size >> 1, size >> 1);
  return b;
};
const run = (b: LifeBoard, n: number) => {
  for (let i = 0; i < n; i++) b.step();
  return b;
};
/** Runs a board with a detector and returns the status after n generations. */
const statusAfter = (b: LifeBoard, n: number) => {
  const d = new Detector();
  d.observe(b);
  for (let i = 0; i < n; i++) {
    b.step();
    d.observe(b);
  }
  return d.status;
};

describe('B3/S23', () => {
  it('keeps a block still', () => {
    const b = at('block');
    const before = b.snapshot();
    run(b, 5);
    expect(b.snapshot()).toEqual(before);
  });

  it('flips a blinker with period 2', () => {
    const b = at('blinker');
    const s0 = b.snapshot();
    run(b, 1);
    expect(b.snapshot()).not.toEqual(s0);
    expect(b.population).toBe(3);
    run(b, 1);
    expect(b.snapshot()).toEqual(s0);
  });

  it('moves a glider one cell diagonally every 4 generations', () => {
    const b = at('glider');
    const b0 = b.bounds()!;
    run(b, 4);
    const b1 = b.bounds()!;
    expect([b1.x0 - b0.x0, b1.y0 - b0.y0]).toEqual([1, 1]);
    expect(b.population).toBe(5);
  });

  it('reports fate and neighbours for the inspector', () => {
    const b = at('blinker'); // three across at (256..258, 256)
    expect(b.neighbours(257, 255)).toBe(3);
    expect(b.fate(257, 255)).toBe('born');
    expect(b.fate(256, 256)).toBe('dies');
    expect(b.fate(257, 256)).toBe('survives');
    expect(b.fate(250, 250)).toBe('empty');
  });

  it('previews the next generation without stepping', () => {
    const b = at('blinker');
    const out = new Uint8Array(b.w * b.h);
    b.preview(out);
    expect(out[255 * b.w + 257]).toBe(1);
    expect(out[256 * b.w + 256]).toBe(2);
    expect(b.generation).toBe(0);
  });

  it('flashes births and leaves fading trails', () => {
    const b = at('blinker');
    run(b, 1);
    expect(b.shade[255 * b.w + 257]).toBe(LIVE);
    expect(b.shade[256 * b.w + 256]).toBe(TRAIL);
    expect(b.shade[256 * b.w + 257]).toBe(255); // placed cells are drawn settled
    run(b, 1);
    expect(b.shade[255 * b.w + 257]).toBe(TRAIL); // born, then died
    expect(b.shade[256 * b.w + 256]).toBe(LIVE); // reborn this generation
  });

  it('fades every trail behind a glider', () => {
    const b = at('glider');
    run(b, 200);
    let stray = 0;
    for (let i = 0; i < b.shade.length; i++) if (b.shade[i] && b.shade[i] < LIVE && !b.cells[i] && b.shade[i] > TRAIL) stray++;
    const box = b.bounds()!;
    let farTrails = 0;
    for (let i = 0; i < b.shade.length; i++) {
      if (!b.shade[i] || b.cells[i]) continue;
      const x = i % b.w,
        y = Math.floor(i / b.w);
      if (x < box.x0 - TRAIL || y < box.y0 - TRAIL) farTrails++;
    }
    expect(stray).toBe(0);
    expect(farTrails).toBe(0);
  });
});

describe('absorbing border', () => {
  it('erases gliders and spaceships whole, in every direction and phase', () => {
    let leftovers = 0;
    for (const id of ['glider', 'lwss', 'hwss']) {
      for (let r = 0; r < 4; r++)
        for (let ph = 0; ph < 4; ph++) {
          const b = new LifeBoard(128);
          place(b, transform(patternOf(id), r), 60 + ph, 62);
          run(b, ph);
          run(b, 700);
          leftovers += b.population;
        }
    }
    expect(leftovers).toBe(0);
  });

  it('turns a gun into a steady output with period 30', () => {
    const b = new LifeBoard(320);
    place(b, GOSPER, 40, 40);
    expect(statusAfter(b, 1500)).toEqual({ kind: 'output', period: 30 });
  });

  it('never lets a cell live in the border band', () => {
    const b = new LifeBoard(128);
    b.set(1, 1, true);
    expect(b.population).toBe(0);
    b.set(BORDER, BORDER, true);
    expect(b.population).toBe(1);
  });
});

describe('RLE', () => {
  it('round-trips every library pattern', () => {
    for (const e of LIBRARY) {
      const p = parseRLE(e.rle);
      expect(parseRLE(toRLE(p))).toEqual(p);
    }
  });

  it('skips header and comment lines', () => {
    expect(parseRLE('#N Glider\nx = 3, y = 3, rule = B3/S23\nbo$2bo$3o!').cells).toHaveLength(5);
  });

  it('has 8 symmetries that preserve the cell count', () => {
    const g = patternOf('glider');
    const shapes = new Set<string>();
    for (let r = 0; r < 4; r++) for (const f of [false, true]) shapes.add(toRLE(transform(g, r, f)));
    expect(shapes.size).toBe(8);
    expect(transform(g, 4)).toEqual(normalize(g.cells));
  });
});

describe('library claims', () => {
  it('still lifes are still and oscillators have their periods', () => {
    const want: Record<string, string> = { block: 'still', beehive: 'still', loaf: 'still', boat: 'still' };
    const periods: Record<string, number> = { blinker: 2, toad: 2, beacon: 2, pulsar: 3, pentadecathlon: 15 };
    for (const id of Object.keys(want)) expect(statusAfter(at(id), 4).kind).toBe('still');
    for (const [id, p] of Object.entries(periods)) expect(statusAfter(at(id), 40)).toEqual({ kind: 'oscillator', period: p });
  });

  it('spaceships travel at their speeds', () => {
    const want: Record<string, string> = { glider: 'c/4', lwss: 'c/2', mwss: 'c/2', hwss: 'c/2', copperhead: 'c/10' };
    for (const [id, v] of Object.entries(want)) {
      const s = statusAfter(at(id), 60);
      expect(s.kind).toBe('spaceship');
      if (s.kind === 'spaceship') expect(speed(s.period, s.dx, s.dy)).toBe(v);
    }
  });

  it('every meta label matches', () => {
    for (const e of LIBRARY) {
      if (e.group === 'oscillator') expect(e.meta).toMatch(/^p\d+$/);
      if (e.group === 'still') expect(e.meta).toBe('still');
    }
  });

  it('R-pentomino settles at generation 1103 with 116 cells', () => {
    const b = at('r-pentomino', 1024);
    run(b, 1102);
    const p1102 = b.population;
    run(b, 1);
    expect(b.population).toBe(116);
    expect(p1102).not.toBe(116);
    run(b, 40);
    expect(b.population).toBe(116);
  });

  it('Diehard vanishes at generation 130', () => {
    const b = at('diehard');
    run(b, 129);
    expect(b.population).toBeGreaterThan(0);
    run(b, 1);
    expect(b.population).toBe(0);
  });

  it('Gosper gun fires one glider every 30 generations', () => {
    const b = new LifeBoard(512);
    place(b, GOSPER, 40, 40);
    run(b, 300);
    const gliders = objects(b).filter((o) => o.cells.length === 5).length;
    run(b, 30);
    expect(objects(b).filter((o) => o.cells.length === 5).length).toBe(gliders + 1);
  });

  it('Simkin gun fires once every 120 generations', () => {
    const b = new LifeBoard(512);
    place(b, patternOf('simkin-gun'), 300, 300);
    run(b, 600);
    const n = objects(b).filter((o) => o.cells.length === 5).length;
    run(b, 120);
    expect(objects(b).filter((o) => o.cells.length === 5).length).toBe(n + 1);
    expect(patternOf('simkin-gun').cells.length).toBe(36);
    expect(GOSPER.cells.length).toBe(36);
  });

  it('the puffer and the ten-cell seed keep growing', () => {
    for (const id of ['puffer', 'ten-cell']) {
      const b = at(id, 1024);
      run(b, 200);
      const p200 = b.population;
      run(b, 300);
      expect(b.population).toBeGreaterThan(p200);
    }
    expect(patternOf('ten-cell').cells.length).toBe(10);
  });
});

describe('scenes', () => {
  it('builds every tour scene and library entry', () => {
    for (const s of TOUR) expect(getScene(s.load)).toBeDefined();
    for (const e of LIBRARY) {
      const b = new LifeBoard(1024);
      const info = getScene(e.id)!.build(b);
      expect(b.population).toBe(patternOf(e.id).cells.length);
      expect(info.focus.x1).toBeGreaterThan(info.focus.x0);
    }
  });

  it('the garden keeps every object (period 30 = 2, 3 and 15)', () => {
    const b = new LifeBoard(1024);
    getScene('garden')!.build(b);
    expect(statusAfter(b, 120)).toEqual({ kind: 'oscillator', period: 30 });
  });

  it('the flotilla flies apart cleanly', () => {
    const b = new LifeBoard(1024);
    getScene('flotilla')!.build(b);
    const pop = b.population;
    run(b, 80);
    expect(objects(b)).toHaveLength(4);
    expect(b.population).toBeGreaterThan(pop - 10);
  });

  it('an eater swallows a gun stream forever', () => {
    const b = new LifeBoard(1024);
    getScene('eater')!.build(b);
    expect(statusAfter(b, 600)).toEqual({ kind: 'oscillator', period: 30 });
  });

  it('two guns at 90° cancel stream for stream', () => {
    const b = new LifeBoard(1024);
    getScene('two-guns')!.build(b);
    expect(statusAfter(b, 600)).toEqual({ kind: 'oscillator', period: 30 });
  });

  const read = (id: string, arg?: string) => {
    const b = new LifeBoard(1024);
    const info = getScene(id)!.build(b, arg);
    const r = new ReceiverReader(info.receiver!);
    for (let g = 0; g < FIRST_FRAME + PERIOD * (info.receiver!.bits + 1) && !r.done; g++) {
      b.step();
      r.observe(b);
    }
    return { r, info, b };
  };

  it('the NOT gate inverts its data', () => {
    const { r, info } = read('not-gate');
    expect(r.done).toBe(true);
    expect(r.bits).toEqual(info.receiver!.data!.map((d) => !d));
  });

  it('a message survives the trip', () => {
    for (const word of ['LIFE', 'HI', 'Gero', '42!']) {
      const { r } = read('message', word);
      expect(decodeBits(r.bits)).toBe(word);
    }
  });

  it('the receiver is fed and the board stays clean after the message', () => {
    const { b } = read('message', 'OK');
    run(b, 400);
    // Only the clock, the eater and the stream between them are left.
    expect(statusAfter(b, 300)).toEqual({ kind: 'oscillator', period: 30 });
    expect(occupied(b, { x0: 0, y0: 0, x1: b.w, y1: b.h })).toBe(true);
  });

  it('encodes printable ASCII only, at most four characters', () => {
    expect(cleanText('Hello\n')).toBe('Hell');
    expect(encodeText('A')).toEqual([false, true, false, false, false, false, false, true]);
    expect(decodeBits(encodeText('Zz 9'))).toBe('Zz 9');
    expect(decodeBits([true, null, false])).toBe('');
  });

  it('builds the message scene quickly enough to feel instant', () => {
    const t = performance.now();
    getScene('message')!.build(new LifeBoard(1024), 'LIFE');
    expect(performance.now() - t).toBeLessThan(1500);
  });

  it('the eater pattern is Eater 1', () => {
    expect(EATER.cells).toHaveLength(7);
  });
});

describe('detector', () => {
  it('names empty boards and things still evolving', () => {
    expect(statusAfter(new LifeBoard(64), 3).kind).toBe('empty');
    expect(statusAfter(at('r-pentomino'), 20).kind).toBe('evolving');
  });

  it('writes speeds the Life way', () => {
    expect(speed(4, 1, 1)).toBe('c/4');
    expect(speed(4, -2, 0)).toBe('c/2');
    expect(speed(6, 2, 1)).toBe('(2,1)c/6');
  });
});

describe('camera', () => {
  it('round-trips screen and cell coordinates', () => {
    const cam = { cx: 100, cy: 50, scale: 8 };
    const [x, y] = screenToCell(cam, 800, 600, 123, 456);
    expect(cellToScreen(cam, 800, 600, x, y)).toEqual([123, 456]);
  });

  it('zooms around the pointer', () => {
    const cam = { cx: 100, cy: 50, scale: 8 };
    const before = screenToCell(cam, 800, 600, 200, 100);
    const after = screenToCell(zoomAt(cam, 800, 600, 200, 100, 16), 800, 600, 200, 100);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });

  it('fits a pattern into the free area beside the panel', () => {
    const cam = fit({ x0: 0, y0: 0, x1: 10, y1: 10 }, 0, 1000, 600, { top: 0, right: 400, bottom: 0, left: 0 });
    const [sx] = cellToScreen(cam, 1000, 600, 5, 5);
    expect(sx).toBeCloseTo(300);
  });
});

describe('tour progress', () => {
  it('round-trips and clamps', () => {
    expect(parseProgress(serializeProgress({ step: 3, seen: 5 }))).toEqual({ step: 3, seen: 5 });
    expect(parseProgress('{"step":99}')).toEqual({ step: TOUR.length - 1, seen: TOUR.length - 1 });
    expect(parseProgress('nope')).toEqual({ step: 0, seen: 0 });
    expect(parseProgress(null)).toEqual({ step: 0, seen: 0 });
  });
});
