/**
 * Conway's Life (B3/S23) on a bounded board with an absorbing border (SPEC "Conway's Life").
 * DOM-free. Cells live in a Uint8 buffer. Each row keeps the span of its live cells, so a step
 * only scans each row's span (grown by one, and by the spans of the last TRAIL generations so
 * trails fade): a long diagonal glider stream costs its length, not its bounding box.
 *
 * An object that touches the border band is erased whole (every live cell within two cells of
 * it, recursively), so gliders and gun streams leave cleanly instead of wrapping round or
 * leaving clipped debris.
 *
 * `shade` is what the renderer draws, one byte per cell:
 * - 128 + age (0…127) for a live cell, where age is generations since birth;
 * - 1…TRAIL for a cell that died recently (TRAIL = just died);
 * - 0 for empty.
 */

export const LIVE = 128;
export const TRAIL = 6;
/** Width of the band at the edge: an object that enters it is erased. */
export const BORDER = 4;

export interface Rect {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number; // exclusive
}

/** Live spans per row (inclusive; empty when lo > hi), and the rows that have any. */
interface Spans {
  lo: Int32Array;
  hi: Int32Array;
  y0: number;
  y1: number;
}

export class LifeBoard {
  readonly w: number;
  readonly h: number;
  readonly cells: Uint8Array;
  private next: Uint8Array;
  /** Per-cell render value (see the file comment). */
  readonly shade: Uint8Array;
  generation = 0;
  population = 0;
  /** Cells the border erased in the last step. */
  absorbed = 0;
  /** Births and deaths in the last step. */
  births = 0;
  deaths = 0;
  /** Whether births flash and deaths leave a trail (off under reduced motion). */
  trails = true;
  /** This generation's live spans (a superset after the border erases something). */
  private live: Spans;
  /** Live spans of the last TRAIL generations, newest last. */
  private past: Spans[] = [];
  private pool: Spans[] = [];
  // Live bounding box columns (inclusive); rows come from `live`.
  private bx0 = 1;
  private bx1 = 0;
  // Region of `shade` that changed since the renderer last uploaded (inclusive).
  private sx0 = 1;
  private sy0 = 1;
  private sx1 = 0;
  private sy1 = 0;
  /** The span each row was scanned over in the last step. */
  private scanLo: Int32Array;
  private scanHi: Int32Array;

  constructor(w = 1024, h = w) {
    this.w = w;
    this.h = h;
    this.cells = new Uint8Array(w * h);
    this.next = new Uint8Array(w * h);
    this.shade = new Uint8Array(w * h);
    this.scanLo = new Int32Array(h);
    this.scanHi = new Int32Array(h);
    this.live = this.spans();
  }

  get(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.cells[y * this.w + x] === 1;
  }

  /** Whether (x, y) is inside the playable area (outside the border band). */
  inside(x: number, y: number): boolean {
    return x >= BORDER && y >= BORDER && x < this.w - BORDER && y < this.h - BORDER;
  }

  set(x: number, y: number, alive: boolean) {
    if (!this.inside(x, y)) return;
    const i = y * this.w + x;
    if ((this.cells[i] === 1) === alive) return;
    this.cells[i] = alive ? 1 : 0;
    this.population += alive ? 1 : -1;
    // Cells placed by hand or by a scene are drawn settled (cyan); only births by the rule flash.
    this.shade[i] = alive ? 255 : this.trails ? TRAIL : 0;
    if (alive) {
      widen(this.live, x, y);
      if (this.bx0 > this.bx1) this.bx0 = this.bx1 = x;
      else {
        this.bx0 = Math.min(this.bx0, x);
        this.bx1 = Math.max(this.bx1, x);
      }
    } else if (this.trails) {
      // Keep the erased cell in a past span so its trail fades.
      if (!this.past.length) this.past.push(this.spans());
      widen(this.past[this.past.length - 1], x, y);
    }
    this.touch(x, y, x, y);
  }

  clear() {
    this.cells.fill(0);
    this.shade.fill(0);
    this.population = this.births = this.deaths = this.absorbed = 0;
    this.generation = 0;
    this.reset(this.live);
    for (const s of this.past) this.pool.push(s);
    this.past = [];
    this.bx0 = 1;
    this.bx1 = 0;
    this.touch(0, 0, this.w - 1, this.h - 1);
  }

  /** Live cells as flat indices (for undo snapshots and the URL). */
  snapshot(): Uint32Array {
    const out = new Uint32Array(this.population);
    let n = 0;
    this.forEachLive((i) => {
      out[n++] = i;
    });
    return n === out.length ? out : out.slice(0, n);
  }

  restore(cells: ArrayLike<number>, generation = 0) {
    this.clear();
    const old = this.trails;
    this.trails = false;
    for (let k = 0; k < cells.length; k++) this.set(cells[k] % this.w, Math.floor(cells[k] / this.w), true);
    this.trails = old;
    this.generation = generation;
  }

  /** Calls `fn` with the flat index of every live cell, row by row. */
  forEachLive(fn: (i: number) => void) {
    const { lo, hi, y0, y1 } = this.live;
    for (let y = y0; y <= y1; y++) {
      const row = y * this.w;
      for (let x = lo[y]; x <= hi[y]; x++) if (this.cells[row + x]) fn(row + x);
    }
  }

  /** Live bounding box, or null when the board is empty. */
  bounds(): Rect | null {
    if (!this.population) return null;
    return { x0: this.bx0, y0: this.live.y0, x1: this.bx1 + 1, y1: this.live.y1 + 1 };
  }

  /** The region of `shade` that changed since `clean()`, or null. */
  dirty(): Rect | null {
    if (this.sx0 > this.sx1) return null;
    return { x0: this.sx0, y0: this.sy0, x1: this.sx1 + 1, y1: this.sy1 + 1 };
  }

  /** Call after the renderer has uploaded `dirty()`. */
  clean() {
    this.sx0 = this.sy0 = 1;
    this.sx1 = this.sy1 = 0;
  }

  neighbours(x: number, y: number): number {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && this.get(x + dx, y + dy)) n++;
    return n;
  }

  /** What (x, y) does next generation. */
  fate(x: number, y: number): 'born' | 'survives' | 'dies' | 'empty' {
    const n = this.neighbours(x, y);
    if (this.get(x, y)) return n === 2 || n === 3 ? 'survives' : 'dies';
    return n === 3 ? 'born' : 'empty';
  }

  /**
   * The next generation without stepping: writes 1 (born) or 2 (dies) into `out`
   * (length w × h, zero elsewhere) and returns the region it wrote, or null.
   */
  preview(out: Uint8Array): Rect | null {
    const b = this.bounds();
    if (!b) return null;
    const { w, cells } = this;
    const x0 = Math.max(1, b.x0 - 1),
      y0 = Math.max(1, b.y0 - 1),
      x1 = Math.min(w - 1, b.x1 + 1),
      y1 = Math.min(this.h - 1, b.y1 + 1);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        const n = cells[i - w - 1] + cells[i - w] + cells[i - w + 1] + cells[i - 1] + cells[i + 1] + cells[i + w - 1] + cells[i + w] + cells[i + w + 1];
        out[i] = cells[i] ? (n === 2 || n === 3 ? 0 : 2) : n === 3 ? 1 : 0;
      }
    return { x0, y0, x1, y1 };
  }

  step() {
    const { w, h, cells, next, shade, live, past } = this;
    const trails = this.trails;
    this.births = this.deaths = this.absorbed = 0;
    const nl = this.spans();
    // Rows to scan: live rows ± 1, and every row a recent trail may sit on.
    let ry0 = live.y0 - 1,
      ry1 = live.y1 + 1;
    for (const p of past) {
      ry0 = Math.min(ry0, p.y0);
      ry1 = Math.max(ry1, p.y1);
    }
    ry0 = Math.max(1, ry0);
    ry1 = Math.min(h - 2, ry1);
    const edge: number[] = [];
    const bx0 = BORDER,
      by0 = BORDER,
      bx1 = w - BORDER,
      by1 = h - BORDER;
    let pop = 0,
      cx0 = w,
      cx1 = -1;
    const scanLo = this.scanLo,
      scanHi = this.scanHi;
    for (let y = ry0; y <= ry1; y++) {
      let lo = Math.min(live.lo[y - 1], live.lo[y], live.lo[y + 1]) - 1;
      let hi = Math.max(live.hi[y - 1], live.hi[y], live.hi[y + 1]) + 1;
      for (const p of past) {
        if (p.lo[y] < lo) lo = p.lo[y];
        if (p.hi[y] > hi) hi = p.hi[y];
      }
      lo = Math.max(1, lo);
      hi = Math.min(w - 2, hi);
      scanLo[y] = lo;
      scanHi[y] = hi;
      if (lo > hi) continue;
      if (lo < cx0) cx0 = lo;
      if (hi > cx1) cx1 = hi;
      const row = y * w;
      for (let x = lo; x <= hi; x++) {
        const i = row + x;
        const n = cells[i - w - 1] + cells[i - w] + cells[i - w + 1] + cells[i - 1] + cells[i + 1] + cells[i + w - 1] + cells[i + w] + cells[i + w + 1];
        const was = cells[i];
        const now = was ? (n === 2 || n === 3 ? 1 : 0) : n === 3 ? 1 : 0;
        next[i] = now;
        if (now) {
          pop++;
          widen(nl, x, y);
          if (x < bx0 || y < by0 || x >= bx1 || y >= by1) edge.push(i);
          if (was) {
            if (shade[i] < 255) shade[i]++;
          } else {
            this.births++;
            shade[i] = trails ? LIVE : 255;
          }
        } else if (was) {
          this.deaths++;
          shade[i] = trails ? TRAIL : 0;
        } else if (shade[i]) {
          shade[i]--;
        }
      }
    }
    // Copy the scanned spans back (`next` is stale outside them).
    for (let y = ry0; y <= ry1; y++) {
      const lo = scanLo[y],
        hi = scanHi[y];
      if (lo <= hi) cells.set(next.subarray(y * w + lo, y * w + hi + 1), y * w + lo);
    }
    if (cx0 <= cx1) this.touch(cx0, ry0, cx1, ry1);
    // The old live spans become the newest trail spans.
    past.push(live);
    if (past.length > TRAIL) this.pool.push(past.shift()!);
    this.live = nl;
    for (const i of edge) if (cells[i]) pop -= this.erase(i);
    this.population = pop;
    this.bx0 = w;
    this.bx1 = -1;
    if (pop) {
      for (let y = nl.y0; y <= nl.y1; y++) {
        if (nl.lo[y] < this.bx0) this.bx0 = nl.lo[y];
        if (nl.hi[y] > this.bx1) this.bx1 = nl.hi[y];
      }
    } else this.reset(nl);
    this.generation++;
  }

  private spans(): Spans {
    const s = this.pool.pop() ?? { lo: new Int32Array(this.h + 2), hi: new Int32Array(this.h + 2), y0: 0, y1: 0 };
    this.reset(s);
    return s;
  }

  private reset(s: Spans) {
    s.lo.fill(this.w);
    s.hi.fill(-1);
    s.y0 = this.h;
    s.y1 = -1;
  }

  /** Erases the object containing cell i (live cells chained within two cells); returns its size. */
  private erase(start: number): number {
    const { w, h, cells, shade } = this;
    const stack = [start];
    cells[start] = 0;
    let n = 0;
    while (stack.length) {
      const i = stack.pop()!;
      shade[i] = 0;
      n++;
      const x = i % w,
        y = (i - x) / w;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (cells[j]) {
            cells[j] = 0;
            stack.push(j);
          }
        }
      }
    }
    this.absorbed += n;
    return n;
  }

  private touch(x0: number, y0: number, x1: number, y1: number) {
    if (this.sx0 > this.sx1) {
      this.sx0 = x0;
      this.sy0 = y0;
      this.sx1 = x1;
      this.sy1 = y1;
      return;
    }
    if (x0 < this.sx0) this.sx0 = x0;
    if (y0 < this.sy0) this.sy0 = y0;
    if (x1 > this.sx1) this.sx1 = x1;
    if (y1 > this.sy1) this.sy1 = y1;
  }
}

function widen(s: Spans, x: number, y: number) {
  if (x < s.lo[y]) s.lo[y] = x;
  if (x > s.hi[y]) s.hi[y] = x;
  if (y < s.y0) s.y0 = y;
  if (y > s.y1) s.y1 = y;
}
