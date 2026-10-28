/**
 * Run-length encoded Life patterns (the format LifeWiki and Golly use), plus the eight
 * symmetries. A pattern is a list of live cells relative to its top-left corner.
 */

export type Cell = [number, number];

export interface Pattern {
  w: number;
  h: number;
  cells: Cell[];
}

/** Parses an RLE body (`bo$2bo$3o!`); a header line (`x = 3, y = 3`) and `#` lines are skipped. */
export function parseRLE(text: string): Pattern {
  const body = text
    .split('\n')
    .filter((l) => !l.startsWith('#') && !/^\s*x\s*=/.test(l))
    .join('');
  const cells: Cell[] = [];
  let x = 0,
    y = 0,
    run = '';
  for (const ch of body) {
    if (ch >= '0' && ch <= '9') {
      run += ch;
      continue;
    }
    const n = run ? parseInt(run, 10) : 1;
    run = '';
    if (ch === 'b' || ch === '.') x += n;
    else if (ch === 'o' || ch === 'A') {
      for (let k = 0; k < n; k++) cells.push([x + k, y]);
      x += n;
    } else if (ch === '$') {
      y += n;
      x = 0;
    } else if (ch === '!') break;
  }
  return normalize(cells);
}

/** Moves the cells so the top-left of their box is (0, 0). */
export function normalize(cells: Cell[]): Pattern {
  if (!cells.length) return { w: 0, h: 0, cells: [] };
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of cells) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const out = cells.map(([x, y]) => [x - x0, y - y0] as Cell);
  out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, cells: out };
}

export function toRLE(p: Pattern): string {
  const rows: string[] = [];
  const live = new Set(p.cells.map(([x, y]) => y * p.w + x));
  let out = '';
  let blankRows = 0;
  const emit = (n: number, c: string) => (n === 1 ? c : `${n}${c}`);
  for (let y = 0; y < p.h; y++) {
    let line = '';
    let x = 0;
    while (x < p.w) {
      const alive = live.has(y * p.w + x);
      let n = 1;
      while (x + n < p.w && live.has(y * p.w + x + n) === alive) n++;
      if (alive || x + n < p.w) line += emit(n, alive ? 'o' : 'b');
      x += n;
    }
    rows.push(line);
  }
  for (let y = 0; y < rows.length; y++) {
    if (!rows[y]) {
      blankRows++;
      continue;
    }
    if (out) out += emit(blankRows + 1, '$');
    else if (blankRows) out += emit(blankRows, '$');
    blankRows = 0;
    out += rows[y];
  }
  return out + '!';
}

/** One of the 8 symmetries: `rot` quarter turns clockwise, then a horizontal flip. */
export function transform(p: Pattern, rot: number, flip = false): Pattern {
  const r = ((rot % 4) + 4) % 4;
  const cells = p.cells.map(([x, y]) => {
    let c: Cell = [x, y];
    for (let k = 0; k < r; k++) c = [-c[1], c[0]];
    if (flip) c = [-c[0], c[1]];
    return c;
  });
  return normalize(cells);
}
