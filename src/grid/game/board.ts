/**
 * The lattice as a graph. Vertices are `row * cols + col`; each unit segment
 * between neighbouring vertices is an edge. Horizontal edges come first
 * (`row * (cols - 1) + col` joins (col, row)–(col + 1, row)), then vertical
 * ones (`H + row * cols + col` joins (col, row)–(col, row + 1)).
 */

export interface Bounds {
  minC: number;
  maxC: number;
  minR: number;
  maxR: number;
}

export class Board {
  readonly cols: number;
  readonly rows: number;
  /** Vertex count. */
  readonly V: number;
  /** Edge count. */
  readonly E: number;
  /** Endpoints of each edge, as vertex indices (edgeA < edgeB). */
  readonly edgeA: Int32Array;
  readonly edgeB: Int32Array;
  /** Up to 4 neighbours per vertex: `nbrV[v * 4 + k]` (−1 if none) through edge `nbrE[v * 4 + k]`. */
  readonly nbrV: Int32Array;
  readonly nbrE: Int32Array;

  constructor(cols: number, rows: number) {
    if (cols < 1 || rows < 1) throw new Error('Board needs at least one vertex');
    this.cols = cols;
    this.rows = rows;
    this.V = cols * rows;
    const H = (cols - 1) * rows;
    this.E = H + cols * (rows - 1);
    this.edgeA = new Int32Array(this.E);
    this.edgeB = new Int32Array(this.E);
    this.nbrV = new Int32Array(this.V * 4).fill(-1);
    this.nbrE = new Int32Array(this.V * 4).fill(-1);
    const deg = new Uint8Array(this.V);
    const link = (e: number, a: number, b: number) => {
      this.edgeA[e] = a;
      this.edgeB[e] = b;
      this.nbrV[a * 4 + deg[a]] = b;
      this.nbrE[a * 4 + deg[a]++] = e;
      this.nbrV[b * 4 + deg[b]] = a;
      this.nbrE[b * 4 + deg[b]++] = e;
    };
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols - 1; c++) link(r * (cols - 1) + c, r * cols + c, r * cols + c + 1);
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols; c++) link(H + r * cols + c, r * cols + c, (r + 1) * cols + c);
  }

  vertex(col: number, row: number): number {
    return row * this.cols + col;
  }

  col(v: number): number {
    return v % this.cols;
  }

  row(v: number): number {
    return Math.floor(v / this.cols);
  }

  inLattice(col: number, row: number): boolean {
    return Number.isInteger(col) && Number.isInteger(row) && col >= 0 && row >= 0 && col < this.cols && row < this.rows;
  }

  /** The two endpoints of an edge in lattice coordinates. */
  edgeVertices(e: number): { c0: number; r0: number; c1: number; r1: number } {
    const a = this.edgeA[e];
    const b = this.edgeB[e];
    return { c0: this.col(a), r0: this.row(a), c1: this.col(b), r1: this.row(b) };
  }

  /** Edge joining two vertices, or −1 if they aren't neighbours. */
  edgeBetween(a: number, b: number): number {
    for (let k = 0; k < 4; k++) if (this.nbrV[a * 4 + k] === b) return this.nbrE[a * 4 + k];
    return -1;
  }
}

export function inBounds(b: Bounds, col: number, row: number): boolean {
  return col >= b.minC && col <= b.maxC && row >= b.minR && row <= b.maxR;
}
