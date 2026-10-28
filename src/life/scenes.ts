/**
 * Composite scenes: the tour's gardens and the Signals series (SPEC "Conway's Life").
 *
 * The signal machinery is two Gosper guns at 90°. Gun A (the clock) fires south-east. Gun B,
 * mirrored, fires south-west across A's stream; at the offset below, every B glider meets an
 * A glider at the crossing and both vanish. Take B's gliders away and A's get through, so the
 * crossing is a NOT gate: out = NOT data.
 *
 * To send data, B is placed K × (15, −15) cells further up its line (its gliders then arrive
 * 60K generations later, a whole number of periods), both guns run for 60K generations, gun B
 * is removed, and the gliders of its train are deleted wherever the data says "no eraser".
 * What is left is a real Life pattern: a clock, a tape of erasers and a receiver.
 */
import { LifeBoard, type Rect } from './engine';
import { EATER, GLIDER, GOSPER, getEntry, patternOf } from './patterns';
import { transform, type Pattern } from './rle';

export interface Label {
  x: number;
  y: number;
  text: string;
}

export interface Receiver {
  /** The 2×2 detector window just before the eater. */
  window: Rect;
  /** Generation at which bit 0 arrives; bit j arrives PERIOD × j later. */
  first: number;
  /** The bits the receiver should read (shown as lamps). */
  bits: number;
  /** For the NOT gate: the data bits fed in, to fill the truth table. */
  data?: boolean[];
}

export interface SceneInfo {
  /** Region the camera fits. */
  focus: Rect;
  room: number;
  speed: number;
  labels: Label[];
  receiver?: Receiver;
}

export const PERIOD = 30;
/** Gun B's offset from gun A in the annihilating configuration (found by search, tested). */
export const B_OFFSET: [number, number] = [64, 13];
/** Where the two streams cross, relative to gun A. */
export const CROSSING: [number, number] = [55, 41];
/** The detector window and the receiver eater, relative to gun A, on A's stream. */
const WINDOW_AT: [number, number] = [86, 72];
const EATER_AT: [number, number] = [98, 84];
/** Bit 0 reaches the window this many generations after the scene starts. */
export const FIRST_FRAME = 215;
export const MAX_CHARS = 4;

const MIRROR = transform(GOSPER, 0, true);

export function place(board: LifeBoard, p: Pattern, x: number, y: number) {
  for (const [cx, cy] of p.cells) board.set(x + cx, y + cy, true);
}

/** The board centre, where single patterns go. */
export const centre = (board: LifeBoard): [number, number] => [board.w >> 1, board.h >> 1];

/** Objects on the board: live cells chained within two cells, like the border's eraser. */
export function objects(board: LifeBoard): { cells: number[]; box: Rect }[] {
  const b = board.bounds();
  if (!b) return [];
  const { w, cells } = board;
  const seen = new Uint8Array(cells.length);
  const out: { cells: number[]; box: Rect }[] = [];
  for (let y = b.y0; y < b.y1; y++)
    for (let x = b.x0; x < b.x1; x++) {
      const start = y * w + x;
      if (!cells[start] || seen[start]) continue;
      seen[start] = 1;
      const stack = [start];
      const found: number[] = [];
      const box = { x0: x, y0: y, x1: x + 1, y1: y + 1 };
      while (stack.length) {
        const i = stack.pop()!;
        found.push(i);
        const ix = i % w,
          iy = (i - ix) / w;
        box.x0 = Math.min(box.x0, ix);
        box.y0 = Math.min(box.y0, iy);
        box.x1 = Math.max(box.x1, ix + 1);
        box.y1 = Math.max(box.y1, iy + 1);
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const j = (iy + dy) * w + ix + dx;
            if (j >= 0 && j < cells.length && cells[j] && !seen[j]) {
              seen[j] = 1;
              stack.push(j);
            }
          }
      }
      out.push({ cells: found, box });
    }
  return out;
}

/** 8-bit ASCII, most significant bit first. Only printable characters, at most MAX_CHARS. */
export function encodeText(text: string): boolean[] {
  const bits: boolean[] = [];
  for (const ch of cleanText(text)) {
    const c = ch.charCodeAt(0);
    for (let k = 7; k >= 0; k--) bits.push(((c >> k) & 1) === 1);
  }
  return bits;
}

export function decodeBits(bits: readonly (boolean | null)[]): string {
  let out = '';
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    const byte = bits.slice(i, i + 8);
    if (byte.some((b) => b === null)) break;
    out += String.fromCharCode(byte.reduce((n, b) => (n << 1) | (b ? 1 : 0), 0));
  }
  return out;
}

export function cleanText(text: string): string {
  return [...text]
    .filter((c) => c >= ' ' && c <= '~')
    .slice(0, MAX_CHARS)
    .join('');
}

/** Gun A's top-left for the signal scenes, so the whole machine sits round the board centre. */
function gunA(board: LifeBoard): [number, number] {
  const [cx, cy] = centre(board);
  return [cx - 60, cy - 50];
}

/**
 * The clock, a tape of erasers and the receiver. `data[j]` true keeps eraser j (so bit j
 * comes out 0); false deletes it (bit j comes out 1).
 */
function signalLine(board: LifeBoard, data: boolean[]): Receiver {
  const [ax, ay] = gunA(board);
  const K = Math.ceil((data.length + 1) / 2);
  const bx = ax + B_OFFSET[0] + 15 * K,
    by = ay + B_OFFSET[1] - 15 * K;
  board.clear();
  place(board, GOSPER, ax, ay);
  place(board, MIRROR, bx, by);
  const old = board.trails;
  board.trails = false;
  for (let i = 0; i < 60 * K; i++) board.step();
  board.trails = old;
  const train: { cells: number[]; y: number }[] = [];
  const del: number[] = [];
  for (const o of objects(board)) {
    const { box } = o;
    // Gun B and anything attached to it goes.
    if (box.x1 > bx - 1 && box.x0 < bx + MIRROR.w + 1 && box.y1 > by - 1 && box.y0 < by + MIRROR.h + 1) del.push(...o.cells);
    else if (o.cells.length === 5 && Math.abs(box.x0 + box.y0 - (bx + by + 19)) <= 3) train.push({ cells: o.cells, y: box.y0 });
  }
  // The glider furthest along was fired first, so it meets the clock first.
  train.sort((p, q) => q.y - p.y);
  train.forEach((t, j) => {
    if (!(data[j] ?? false)) del.push(...t.cells);
  });
  // Clock gliders already past the receiver's spot would fly on to the border: drop them.
  for (const o of objects(board)) if (onClockLine(o.box, ax, ay) && o.box.x0 > ax + EATER_AT[0] - 6) del.push(...o.cells);
  removeCells(board, del);
  place(board, EATER, ax + EATER_AT[0], ay + EATER_AT[1]);
  const wx = ax + WINDOW_AT[0],
    wy = ay + WINDOW_AT[1];
  return { window: { x0: wx, y0: wy, x1: wx + 2, y1: wy + 2 }, first: FIRST_FRAME, bits: data.length };
}

/** Whether an object sits on gun A's stream (top-left y − x = −14 relative to the gun). */
function onClockLine(box: Rect, ax: number, ay: number): boolean {
  return Math.abs(box.y0 - ay - (box.x0 - ax) + 14) <= 3;
}

function removeCells(board: LifeBoard, del: number[]) {
  const gone = new Set(del);
  board.restore(board.snapshot().filter((i) => !gone.has(i)));
}

export interface SceneDef {
  id: string;
  build(board: LifeBoard, arg?: string): SceneInfo;
}

const rectAround = (x: number, y: number, w: number, h: number): Rect => ({ x0: x, y0: y, x1: x + w, y1: y + h });

function single(id: string): SceneDef {
  return {
    id,
    build(board) {
      const e = getEntry(id)!;
      const p = patternOf(id);
      const [cx, cy] = centre(board);
      const x = cx - (p.w >> 1) + (e.at?.[0] ?? 0),
        y = cy - (p.h >> 1) + (e.at?.[1] ?? 0);
      board.clear();
      place(board, p, x, y);
      const r = rectAround(x, y, p.w, p.h);
      // Ships: fit the path they will travel, not just where they start.
      const focus = e.at ? { x0: Math.min(r.x0, cx - 4), y0: Math.min(r.y0, cy - 4), x1: Math.max(r.x1, cx + 4), y1: Math.max(r.y1, cy + 4) } : r;
      return { focus, room: e.room ?? 8, speed: e.speed, labels: [] };
    },
  };
}

function compose(id: string, items: [string, number, number, number?][], speed: number, room = 6): SceneDef {
  return {
    id,
    build(board) {
      const [cx, cy] = centre(board);
      board.clear();
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      const labels: Label[] = [];
      for (const [pid, dx, dy, rot] of items) {
        const p = rot ? transform(patternOf(pid), rot) : patternOf(pid);
        const x = cx + dx,
          y = cy + dy;
        place(board, p, x, y);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + p.w);
        y1 = Math.max(y1, y + p.h);
        labels.push({ x: x + p.w / 2, y: y + p.h + 1.5, text: getEntry(pid)!.name });
      }
      return { focus: { x0, y0, x1, y1 }, room, speed, labels };
    },
  };
}

const SCENES: SceneDef[] = [
  compose(
    'garden',
    [
      ['block', -34, -12],
      ['beehive', -22, -12],
      ['loaf', -8, -12],
      ['boat', 6, -12],
      ['blinker', 18, -11],
      ['toad', -34, 6],
      ['beacon', -22, 5],
      ['pulsar', -8, 2],
      ['pentadecathlon', 14, 7],
    ],
    4,
  ),
  compose(
    'flotilla',
    [
      ['glider', 30, -24, 2],
      ['lwss', 30, -12],
      ['mwss', 30, -2],
      ['hwss', 30, 9],
    ],
    10,
    30,
  ),
  {
    id: 'bit',
    build(board) {
      const [cx, cy] = centre(board);
      board.clear();
      place(board, GLIDER, cx - 40, cy - 40);
      return {
        focus: { x0: cx - 42, y0: cy - 42, x1: cx + 40, y1: cy + 40 },
        room: 4,
        speed: 12,
        labels: [{ x: cx - 39, y: cy - 35, text: '1 bit' }],
      };
    },
  },
  {
    id: 'clock',
    build(board) {
      const [ax, ay] = gunA(board);
      board.clear();
      place(board, GOSPER, ax, ay);
      return {
        focus: { x0: ax, y0: ay, x1: ax + 110, y1: ay + 100 },
        room: 4,
        speed: 20,
        labels: [{ x: ax + 18, y: ay - 2, text: 'Clock · a glider every 30' }],
      };
    },
  },
  {
    id: 'eater',
    build(board) {
      const [ax, ay] = gunA(board);
      board.clear();
      place(board, GOSPER, ax, ay);
      place(board, EATER, ax + EATER_AT[0], ay + EATER_AT[1]);
      return {
        focus: { x0: ax, y0: ay, x1: ax + EATER_AT[0] + 6, y1: ay + EATER_AT[1] + 6 },
        room: 6,
        speed: 20,
        labels: [
          { x: ax + 18, y: ay - 2, text: 'Clock' },
          { x: ax + EATER_AT[0] + 2, y: ay + EATER_AT[1] + 7, text: 'Eater · receiver' },
        ],
      };
    },
  },
  {
    id: 'two-guns',
    build(board) {
      const [ax, ay] = gunA(board);
      board.clear();
      place(board, GOSPER, ax, ay);
      place(board, MIRROR, ax + B_OFFSET[0], ay + B_OFFSET[1]);
      // Pre-roll until both streams meet, then drop the few gliders that crossed before it.
      const old = board.trails;
      board.trails = false;
      for (let i = 0; i < 240; i++) board.step();
      board.trails = old;
      const onB = (r: Rect) => Math.abs(r.x0 - ax + (r.y0 - ay) - (B_OFFSET[0] + B_OFFSET[1] + 19)) <= 3;
      const early = objects(board).filter(
        (o) => (onClockLine(o.box, ax, ay) && o.box.x0 > ax + CROSSING[0] + 4) || (onB(o.box) && o.box.y0 > ay + CROSSING[1] + 4),
      );
      removeCells(board, early.flatMap((o) => o.cells));
      return {
        focus: { x0: ax, y0: ay, x1: ax + B_OFFSET[0] + MIRROR.w, y1: ay + CROSSING[1] + 8 },
        room: 8,
        speed: 20,
        labels: [
          { x: ax + 18, y: ay - 2, text: 'Gun A' },
          { x: ax + B_OFFSET[0] + 18, y: ay + B_OFFSET[1] - 2, text: 'Gun B' },
          { x: ax + CROSSING[0] + 1, y: ay + CROSSING[1] + 6, text: 'They cancel here' },
        ],
      };
    },
  },
  {
    id: 'not-gate',
    build(board) {
      const data = [true, false, true, true, false, false, true, false];
      const receiver = { ...signalLine(board, data), data };
      return signalInfo(board, receiver, 'Data · erasers');
    },
  },
  {
    id: 'message',
    build(board, arg) {
      const bits = encodeText(arg && cleanText(arg) ? arg : 'LIFE');
      // Keep an eraser wherever the message has a 0.
      const receiver = signalLine(
        board,
        bits.map((b) => !b),
      );
      return signalInfo(board, receiver, 'Sender · tape');
    },
  },
];

function signalInfo(board: LifeBoard, receiver: Receiver, tape: string): SceneInfo {
  const [ax, ay] = gunA(board);
  return {
    focus: { x0: ax, y0: ay - 20, x1: ax + EATER_AT[0] + 6, y1: ay + EATER_AT[1] + 6 },
    room: 6,
    speed: 30,
    labels: [
      { x: ax + 18, y: ay - 2, text: 'Clock' },
      { x: ax + CROSSING[0] + 14, y: ay + CROSSING[1] - 14, text: tape },
      { x: ax + CROSSING[0] - 1, y: ay + CROSSING[1] + 6, text: 'NOT' },
      { x: ax + EATER_AT[0] + 2, y: ay + EATER_AT[1] + 7, text: 'Receiver' },
    ],
    receiver,
  };
}

const ALL = new Map<string, SceneDef>(SCENES.map((s) => [s.id, s]));

export function getScene(id: string): SceneDef | undefined {
  return ALL.get(id) ?? (getEntry(id) ? single(id) : undefined);
}

/**
 * Reads the receiver: a glider entering the window (after a quiet spell) is an arrival,
 * filed under the nearest frame. A frame with no arrival by mid-period is a 0.
 */
export class ReceiverReader {
  readonly bits: (boolean | null)[];
  private last = -99;

  constructor(readonly rx: Receiver) {
    this.bits = new Array(rx.bits).fill(null);
  }

  /** Call once per generation. Returns the index of a bit that was just decided, or -1. */
  observe(board: LifeBoard): number {
    const g = board.generation;
    const { window: w, first } = this.rx;
    let hit = false;
    for (let y = w.y0; y < w.y1 && !hit; y++) for (let x = w.x0; x < w.x1 && !hit; x++) hit = board.get(x, y);
    if (hit) {
      const arrival = g - this.last > 12;
      this.last = g;
      if (arrival) {
        const j = Math.round((g - first) / PERIOD);
        if (j >= 0 && j < this.bits.length && this.bits[j] === null) {
          this.bits[j] = true;
          return j;
        }
      }
    }
    // Past mid-period with nothing: a 0.
    const j = Math.floor((g - first - PERIOD / 2) / PERIOD);
    if (j >= 0 && j < this.bits.length && this.bits[j] === null) {
      this.bits[j] = false;
      return j;
    }
    return -1;
  }

  get done(): boolean {
    return this.bits.every((b) => b !== null);
  }
}
