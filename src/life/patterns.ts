/**
 * The library (SPEC "Conway's Life"): small patterns with who found them and why they matter.
 * Every period, speed and lifespan below is checked in `tests/life.test.ts`.
 */
import { parseRLE, type Pattern } from './rle';

export type Group = 'still' | 'oscillator' | 'ship' | 'methuselah' | 'growth';

export interface LibraryEntry {
  id: string;
  name: string;
  group: Group;
  rle: string;
  by?: string;
  year?: number;
  /** Mono label: a period, a speed or a lifespan. */
  meta: string;
  why: string;
  /** Playback speed in generations per second. */
  speed: number;
  /** Where its top-left goes, relative to the board centre (ships start off-centre to cross the view). */
  at?: [number, number];
  /** Cells to keep in view around the pattern when the camera fits it. */
  room?: number;
}

export const GROUPS: { id: Group; title: string; blurb: string }[] = [
  { id: 'still', title: 'Still lifes', blurb: 'Every cell has two or three neighbours and no dead cell has three. Nothing changes.' },
  { id: 'oscillator', title: 'Oscillators', blurb: 'They return to the same shape after a fixed number of generations, the period.' },
  { id: 'ship', title: 'Spaceships', blurb: 'They return to the same shape somewhere else, so they travel.' },
  { id: 'methuselah', title: 'Methuselahs', blurb: 'A handful of cells that take thousands of generations to settle.' },
  { id: 'growth', title: 'Infinite growth', blurb: 'Patterns whose population grows forever.' },
];

export const LIBRARY: LibraryEntry[] = [
  { id: 'block', name: 'Block', group: 'still', rle: '2o$2o!', meta: 'still', why: 'The most common object left behind when a random soup settles.', speed: 6 },
  { id: 'beehive', name: 'Beehive', group: 'still', rle: 'b2o$o2bo$b2o!', meta: 'still', why: 'The second most common still life.', speed: 6 },
  { id: 'loaf', name: 'Loaf', group: 'still', rle: 'b2o$o2bo$bobo$2bo!', meta: 'still', why: 'Seven cells in perfect balance.', speed: 6 },
  { id: 'boat', name: 'Boat', group: 'still', rle: '2o$obo$bo!', meta: 'still', why: 'Add one cell to a glider’s shape and it stops for good.', speed: 6 },

  { id: 'blinker', name: 'Blinker', group: 'oscillator', rle: '3o!', meta: 'p2', why: 'Three in a row: the smallest and most common oscillator.', speed: 4 },
  { id: 'toad', name: 'Toad', group: 'oscillator', rle: 'b3o$3o!', by: 'Simon Norton', year: 1970, meta: 'p2', why: 'Two staggered blinkers that breathe in and out.', speed: 4 },
  { id: 'beacon', name: 'Beacon', group: 'oscillator', rle: '2o2b$2o2b$2b2o$2b2o!', meta: 'p2', why: 'Two blocks that blink where their corners touch.', speed: 4 },
  {
    id: 'pulsar',
    name: 'Pulsar',
    group: 'oscillator',
    rle: '2b3o3b3o2b2$o4bobo4bo$o4bobo4bo$o4bobo4bo$2b3o3b3o2b2$2b3o3b3o2b$o4bobo4bo$o4bobo4bo$o4bobo4bo2$2b3o3b3o!',
    by: 'John Conway',
    year: 1970,
    meta: 'p3',
    why: 'Four-fold symmetric, and the most common period-3 oscillator.',
    speed: 5,
  },
  {
    id: 'pentadecathlon',
    name: 'Pentadecathlon',
    group: 'oscillator',
    rle: '2bo4bo2b$2ob4ob2o$2bo4bo!',
    by: 'John Conway',
    year: 1970,
    meta: 'p15',
    why: 'Starts as ten cells in a row and takes 15 generations to come back.',
    speed: 10,
  },

  { id: 'glider', name: 'Glider', group: 'ship', rle: 'bo$2bo$3o!', by: 'Richard Guy', year: 1970, meta: 'c/4 diagonal', why: 'Five cells that walk one cell diagonally every four generations. The star of Life.', speed: 10, at: [-30, -30], room: 40 },
  { id: 'lwss', name: 'Lightweight spaceship', group: 'ship', rle: 'bo2bo$o4b$o3bo$4o!', by: 'John Conway', year: 1970, meta: 'c/2', why: 'Moves at half the speed of light, the fastest an orthogonal ship can go.', speed: 12, at: [40, 0], room: 50 },
  { id: 'mwss', name: 'Middleweight spaceship', group: 'ship', rle: '3bo2b$bo3bo$o5b$o4bo$5o!', by: 'John Conway', year: 1970, meta: 'c/2', why: 'The lightweight ship stretched by one column.', speed: 12, at: [40, 0], room: 50 },
  { id: 'hwss', name: 'Heavyweight spaceship', group: 'ship', rle: '3b2o2b$bo4bo$o6b$o5bo$6o!', by: 'John Conway', year: 1970, meta: 'c/2', why: 'One column longer again. Any longer and it falls apart.', speed: 12, at: [40, 0], room: 50 },
  {
    id: 'copperhead',
    name: 'Copperhead',
    group: 'ship',
    rle: 'b2o2b2o$3b2o$3b2o$obo2bobo$o6bo2$o6bo$b2o2b2o$2b4o2$3b2o$3b2o!',
    by: 'zdr',
    year: 2016,
    meta: 'c/10',
    why: 'Found by an amateur in 2016, 46 years in: Life still has new ships to give.',
    speed: 20,
    at: [0, 30],
    room: 40,
  },

  { id: 'r-pentomino', name: 'R-pentomino', group: 'methuselah', rle: 'b2o$2o$bo!', by: 'John Conway', year: 1970, meta: '1103 gens', why: 'Five cells that churn for 1103 generations and leave 116 cells, six of them gliders.', speed: 40, room: 70 },
  { id: 'diehard', name: 'Diehard', group: 'methuselah', rle: '6bob$2o6b$bo3b3o!', meta: 'dies at 130', why: 'Seven cells that vanish completely at generation 130.', speed: 20, room: 30 },
  { id: 'acorn', name: 'Acorn', group: 'methuselah', rle: 'bo5b$3bo3b$2o2b3o!', by: 'Charles Corderman', year: 1971, meta: '5206 gens', why: 'Seven cells that run for 5206 generations and end as 633, thirteen of them gliders.', speed: 60, room: 110 },

  {
    id: 'gosper-gun',
    name: 'Gosper glider gun',
    group: 'growth',
    rle: '24bo$22bobo$12b2o6b2o12b2o$11bo3bo4b2o12b2o$2o8bo5bo3b2o$2o8bo3bob2o4bobo$10bo5bo7bo$11bo3bo$12b2o!',
    by: 'Bill Gosper',
    year: 1970,
    meta: 'p30',
    why: 'Conway bet $50 that no pattern grows forever. This gun, firing a glider every 30 generations, won it.',
    speed: 20,
    at: [-40, -30],
    room: 6,
  },
  {
    id: 'simkin-gun',
    name: 'Simkin glider gun',
    group: 'growth',
    rle: '2o5b2o$2o5b2o2$4b2o$4b2o5$22b2ob2o$21bo5bo$21bo6bo2b2o$21b3o3bo3b2o$26bo4$20b2o$20bo$21b3o$23bo!',
    by: 'Michael Simkin',
    year: 2015,
    meta: 'p120',
    why: 'Found in 2015, 45 years after Gosper’s: another 36-cell gun, built a different way, that fires every 120 generations.',
    speed: 30,
    at: [10, 10],
    room: 8,
  },
  {
    id: 'puffer',
    name: 'Puffer train',
    group: 'growth',
    rle: '3bo$4bo$o3bo$b4o4$o$b2o$2bo$2bo$bo3$3bo$4bo$o3bo$b4o!',
    by: 'Bill Gosper',
    year: 1971,
    meta: 'c/2',
    why: 'Two spaceships escort a burning fuse and leave a trail of debris behind them.',
    speed: 20,
    at: [-60, -9],
    room: 60,
  },
  {
    id: 'ten-cell',
    name: 'Ten-cell growth',
    group: 'growth',
    rle: '6bob$4bob2o$4bobo$4bo$2bo$obo!',
    by: 'Paul Callahan',
    year: 1997,
    meta: 'infinite',
    why: 'The smallest known pattern that grows forever: it becomes an engine that lays blocks.',
    speed: 40,
    room: 80,
  },
];

export const EATER = parseRLE('2o$obo$2bo$2b2o!');
export const GLIDER = parseRLE('bo$2bo$3o!');
export const GOSPER = parseRLE(LIBRARY.find((e) => e.id === 'gosper-gun')!.rle);

const parsed = new Map<string, Pattern>();
export function patternOf(id: string): Pattern {
  let p = parsed.get(id);
  if (!p) {
    const e = LIBRARY.find((x) => x.id === id);
    if (!e) throw new Error(`No pattern ${id}`);
    p = parseRLE(e.rle);
    parsed.set(id, p);
  }
  return p;
}

export function getEntry(id: string): LibraryEntry | undefined {
  return LIBRARY.find((e) => e.id === id);
}
