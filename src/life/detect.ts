/**
 * What the board is doing (the status chip): empty, still life, oscillator, spaceship,
 * a steady output (a gun whose stream leaves through the border), or still evolving.
 * Each generation is hashed twice: by shape alone (translation-invariant) and by place.
 */
import type { LifeBoard, Rect } from './engine';

export type Status =
  | { kind: 'empty' }
  | { kind: 'still' }
  | { kind: 'oscillator'; period: number }
  | { kind: 'spaceship'; period: number; dx: number; dy: number }
  | { kind: 'output'; period: number }
  | { kind: 'evolving' }
  /** Not enough history yet (just loaded or edited). */
  | { kind: 'new' };

interface Frame {
  gen: number;
  shape: number;
  x: number;
  y: number;
  pop: number;
  absorbed: number;
}

/** Longest period the detector looks for. */
export const MAX_PERIOD = 120;

export function shapeHash(board: LifeBoard, b: Rect): number {
  let h = 0x811c9dc5 ^ (b.x1 - b.x0) ^ ((b.y1 - b.y0) << 12);
  const { w } = board;
  board.forEachLive((i) => {
    const x = i % w,
      y = (i - x) / w;
    h ^= (x - b.x0) | ((y - b.y0) << 12);
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 15;
  });
  return h >>> 0;
}

export class Detector {
  private frames: Frame[] = [];
  status: Status = { kind: 'empty' };

  reset() {
    this.frames = [];
    this.status = { kind: 'empty' };
  }

  /** Call once per generation, after `step()` (and once after any edit, after `reset()`). */
  observe(board: LifeBoard): Status {
    const b = board.bounds();
    if (!b) {
      this.frames = [];
      return (this.status = { kind: 'empty' });
    }
    const f: Frame = {
      gen: board.generation,
      shape: shapeHash(board, b),
      x: b.x0,
      y: b.y0,
      pop: board.population,
      absorbed: board.absorbed,
    };
    // Same shape, same population, some period ago: compare offsets.
    this.status = this.frames.length ? { kind: 'evolving' } : { kind: 'new' };
    for (let k = this.frames.length - 1; k >= 0; k--) {
      const g = this.frames[k];
      const period = f.gen - g.gen;
      if (period > MAX_PERIOD) break;
      if (g.shape !== f.shape || g.pop !== f.pop) continue;
      const dx = f.x - g.x,
        dy = f.y - g.y;
      // Anything absorbed within the period means the pattern is feeding the border.
      let leaking = f.absorbed > 0;
      for (let j = k + 1; j < this.frames.length && !leaking; j++) leaking = this.frames[j].absorbed > 0;
      if (dx === 0 && dy === 0) {
        this.status = leaking ? { kind: 'output', period } : period === 1 ? { kind: 'still' } : { kind: 'oscillator', period };
      } else if (!leaking) {
        this.status = { kind: 'spaceship', period, dx, dy };
      }
      break;
    }
    this.frames.push(f);
    if (this.frames.length > MAX_PERIOD + 1) this.frames.shift();
    return this.status;
  }
}

/** Whether any cell in the rectangle is alive (the receiver's detector window). */
export function occupied(board: LifeBoard, r: Rect): boolean {
  const { w, cells } = board;
  for (let y = r.y0; y < r.y1; y++) {
    const row = y * w;
    for (let x = r.x0; x < r.x1; x++) if (cells[row + x]) return true;
  }
  return false;
}

/** Speed as Life notation: c/4 for a glider, (2,1)c/6 for a knightship. */
export function speed(period: number, dx: number, dy: number): string {
  const ax = Math.abs(dx),
    ay = Math.abs(dy);
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  if (ax === 0 || ay === 0 || ax === ay) {
    const d = Math.max(ax, ay);
    const g = gcd(d, period);
    return `${d / g === 1 ? '' : d / g}c/${period / g}`;
  }
  return `(${Math.max(ax, ay)},${Math.min(ax, ay)})c/${period}`;
}
