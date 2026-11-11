/**
 * The Physarum flow model of Tero et al., "Rules for biologically inspired adaptive network
 * design", Science 327 (2010), SPEC "Physarum". DOM-free.
 *
 * The plasmodium starts as a fine mesh of thin tubes: here a jittered triangular lattice over
 * the board, minus the edges under light. Each tube (edge) has a length L and a conductivity D.
 * Per the paper, at each time step:
 * - a random food source is the source, with inflow I₀, and a second random one is the sink;
 * - Kirchhoff (flow is conserved at every other junction) gives the pressures p, and
 *   Poiseuille gives the flux through each tube, Q = D / L · (pᵢ − pⱼ);
 * - each tube adapts as dD/dt = f(|Q|) − D, with f(Q) = Q^γ / (1 + Q^γ): busy tubes thicken,
 *   idle ones constrict and die.
 * Raising I₀ (or lowering γ) keeps more cross-links; lowering I₀ drives the mesh toward a tree.
 *
 * Solving: the system is linear in the sources, so each food k keeps a potential φₖ with
 * L φₖ = eₖ − e_root (the root is the first food in its component), and the pair (a, b) has
 * p = I₀ (φₐ − φ_b). D changes a little per step, so refreshing φₐ and φ_b by Jacobi-
 * preconditioned conjugate gradient, warm-started from their last value, takes a few
 * iterations. A tube never thins below `floor`: a film of plasmodium stays, so when a tube is
 * cut the flux leaks round through the film and a new route can thicken.
 */
import { mulberry32, type Rng } from '../energy/rounds';
import { dist, type Network } from './metrics';
import { isLit, type Scene } from './scene';

export interface FlowParams {
  /** Flux driven from source to sink. */
  i0: number;
  /** Nonlinearity of the tube response. */
  gamma: number;
  /** Euler step of dD/dt. */
  dt: number;
  /** Lattice spacing in board units. */
  spacing: number;
  /** Vertex jitter, as a share of the spacing. */
  jitter: number;
  /** The thinnest a tube gets (the film that lets the mold reroute). */
  floor: number;
  /** Relative residual each step's solves stop at. */
  tol: number;
  seed: number;
}

export const DEFAULT_FLOW: FlowParams = {
  i0: 2,
  gamma: 1.8,
  dt: 0.05,
  spacing: 0.03,
  jitter: 0.3,
  floor: 1e-6,
  tol: 1e-4,
  seed: 1,
};

/**
 * A tube counts as part of the network above this share of f(I₀), the conductivity of a tube
 * that carries the whole flux every step. A tube to a leaf food carries it only when that food
 * is picked, so this sits well below 1 / foods.
 */
export const NETWORK_SHARE = 0.002;

const f = (q: number, gamma: number) => {
  const p = Math.pow(q, gamma);
  return p / (1 + p);
};

interface FoodSlot {
  x: number;
  y: number;
  weight: number;
  vertex: number;
}

export class FlowNet {
  readonly params: FlowParams;
  readonly width: number;
  readonly height: number;
  /** Vertex positions. */
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  /** Edge endpoints, lengths and conductivities. */
  readonly ea: Int32Array;
  readonly eb: Int32Array;
  readonly len: Float64Array;
  readonly D: Float64Array;
  /** 1 while the tube exists (not under light, not cut). */
  readonly alive: Uint8Array;
  /** 1 where light covers the edge. */
  readonly blocked: Uint8Array;
  /** Steps taken, and model time (steps × dt). */
  steps = 0;
  time = 0;
  /** CG iterations spent in the last step (for budgets and tests). */
  lastIterations = 0;
  /** The tubes the last `extractNetwork` kept, 1 per tube. */
  networkTubes: Uint8Array = new Uint8Array(0);
  private readonly rng: Rng;
  // CSR adjacency: the edges of vertex v are adjE[off[v] .. off[v + 1]).
  private readonly off: Int32Array;
  private readonly adjE: Int32Array;
  private foods: FoodSlot[] = [];
  private phi: Float64Array[] = [];
  /** Component label per vertex over alive edges, and the root food of each food's component. */
  private comp: Int32Array;
  private root: number[] = [];
  private compDirty = true;
  // CG scratch.
  private readonly r: Float64Array;
  private readonly z: Float64Array;
  private readonly p: Float64Array;
  private readonly ap: Float64Array;
  private readonly diag: Float64Array;
  private readonly q: Float64Array;
  // The alive tubes, packed for the solver.
  private readonly ca: Int32Array;
  private readonly cb: Int32Array;
  private readonly cw: Float64Array;
  private packed = 0;

  constructor(scene: Scene, params: Partial<FlowParams> = {}) {
    this.params = { ...DEFAULT_FLOW, ...params };
    this.rng = mulberry32(this.params.seed);
    this.width = scene.width;
    this.height = scene.height;
    const { spacing: s, jitter } = this.params;
    const rowH = (s * Math.sqrt(3)) / 2;
    const cols = Math.floor(scene.width / s) + 1;
    const rows = Math.floor(scene.height / rowH) + 1;
    const nv = cols * rows;
    this.vx = new Float64Array(nv);
    this.vy = new Float64Array(nv);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const v = j * cols + i;
        const x = i * s + (j & 1 ? s / 2 : 0) + (this.rng() * 2 - 1) * jitter * s;
        const y = j * rowH + (this.rng() * 2 - 1) * jitter * s;
        this.vx[v] = Math.min(scene.width, Math.max(0, x));
        this.vy[v] = Math.min(scene.height, Math.max(0, y));
      }
    }
    const ea: number[] = [];
    const eb: number[] = [];
    const edge = (i0: number, j0: number, i1: number, j1: number) => {
      if (i1 < 0 || i1 >= cols || j1 >= rows) return;
      ea.push(j0 * cols + i0);
      eb.push(j1 * cols + i1);
    };
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        edge(i, j, i + 1, j);
        // Row j + 1 is shifted by half a cell: odd rows sit right of even ones.
        const left = j & 1 ? i : i - 1;
        edge(i, j, left, j + 1);
        edge(i, j, left + 1, j + 1);
      }
    }
    const ne = ea.length;
    this.ea = Int32Array.from(ea);
    this.eb = Int32Array.from(eb);
    this.len = new Float64Array(ne);
    for (let e = 0; e < ne; e++) {
      this.len[e] = dist(this.vx[ea[e]], this.vy[ea[e]], this.vx[eb[e]], this.vy[eb[e]]);
    }
    this.D = new Float64Array(ne);
    this.alive = new Uint8Array(ne);
    this.blocked = new Uint8Array(ne);
    this.q = new Float64Array(ne);
    this.ca = new Int32Array(ne);
    this.cb = new Int32Array(ne);
    this.cw = new Float64Array(ne);
    const deg = new Int32Array(nv + 1);
    for (let e = 0; e < ne; e++) {
      deg[ea[e] + 1]++;
      deg[eb[e] + 1]++;
    }
    for (let v = 0; v < nv; v++) deg[v + 1] += deg[v];
    this.off = deg;
    this.adjE = new Int32Array(2 * ne);
    const fill = this.off.slice(0, nv);
    for (let e = 0; e < ne; e++) {
      this.adjE[fill[ea[e]]++] = e;
      this.adjE[fill[eb[e]]++] = e;
    }
    this.comp = new Int32Array(nv);
    this.r = new Float64Array(nv);
    this.z = new Float64Array(nv);
    this.p = new Float64Array(nv);
    this.ap = new Float64Array(nv);
    this.diag = new Float64Array(nv);
    this.setLight(scene);
    this.reset();
    this.setFoods(scene.foods);
  }

  get vertexCount(): number {
    return this.vx.length;
  }

  get edgeCount(): number {
    return this.ea.length;
  }

  /** Regrows the fine mesh: every unlit tube alive, with a random conductivity in [0.5, 1). */
  reset(): void {
    for (let e = 0; e < this.edgeCount; e++) {
      this.alive[e] = this.blocked[e] ? 0 : 1;
      this.D[e] = this.alive[e] ? 0.5 + 0.5 * this.rng() : 0;
    }
    for (const phi of this.phi) phi.fill(0);
    this.steps = 0;
    this.time = 0;
    this.compDirty = true;
  }

  /** Starts the flow over from these conductivities (the grown strands) on the alive tubes. */
  seed(D: ArrayLike<number>): void {
    for (let e = 0; e < this.edgeCount; e++) this.D[e] = this.alive[e] ? Math.max(this.params.floor, D[e]) : 0;
    for (const phi of this.phi) phi.fill(0);
    this.steps = 0;
    this.time = 0;
    this.compDirty = true;
  }

  /** A seed drawn from the model's own random stream, for things grown alongside it. */
  nextSeed(): number {
    return Math.floor(this.rng() * 2 ** 31);
  }

  /**
   * Reads the scene's light. Lit tubes die; tubes that come out of the light regrow thin, so
   * the mold can recolonise them only if flow favours them.
   */
  setLight(scene: Scene): void {
    for (let e = 0; e < this.edgeCount; e++) {
      const a = this.ea[e];
      const b = this.eb[e];
      let lit = false;
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        if (isLit(scene, this.vx[a] + (this.vx[b] - this.vx[a]) * t, this.vy[a] + (this.vy[b] - this.vy[a]) * t)) {
          lit = true;
          break;
        }
      }
      if (lit && !this.blocked[e]) {
        this.blocked[e] = 1;
        this.alive[e] = 0;
        this.D[e] = 0;
      } else if (!lit && this.blocked[e]) {
        this.blocked[e] = 0;
        this.alive[e] = 1;
        this.D[e] = this.params.floor;
      }
    }
    this.compDirty = true;
  }

  /**
   * Places the food sources. Each snaps to the nearest unlit vertex with a tube, and two foods
   * never share a vertex. Potentials of foods that did not move are kept.
   */
  setFoods(foods: readonly { x: number; y: number; weight?: number }[]): void {
    const taken = new Set<number>();
    const old = new Map(this.foods.map((s, i) => [s.vertex, this.phi[i]]));
    this.foods = foods.map((fd) => {
      const vertex = this.nearestVertex(fd.x, fd.y, taken);
      taken.add(vertex);
      return { x: fd.x, y: fd.y, weight: fd.weight ?? 1, vertex };
    });
    this.phi = this.foods.map((s) => old.get(s.vertex) ?? new Float64Array(this.vertexCount));
    this.compDirty = true;
  }

  get foodCount(): number {
    return this.foods.length;
  }

  foodVertex(k: number): number {
    return this.foods[k].vertex;
  }

  private nearestVertex(x: number, y: number, taken: Set<number>): number {
    let best = -1;
    let bestD = Infinity;
    for (let v = 0; v < this.vertexCount; v++) {
      if (taken.has(v)) continue;
      let open = false;
      for (let k = this.off[v]; k < this.off[v + 1]; k++) if (!this.blocked[this.adjE[k]]) open = true;
      if (!open) continue;
      const d = (this.vx[v] - x) ** 2 + (this.vy[v] - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best < 0 ? 0 : best;
  }

  /** Advances the model n steps. */
  step(n = 1): void {
    let iterations = 0;
    for (let s = 0; s < n; s++) iterations += this.stepOnce();
    this.lastIterations = iterations;
  }

  private stepOnce(): number {
    if (this.compDirty) this.labelComponents();
    const { i0, gamma, dt, floor } = this.params;
    const pair = this.pickPair();
    const Q = this.q;
    let iterations = 0;
    if (pair) {
      const [a, b] = pair;
      this.assemble();
      iterations += this.refresh(a, this.params.tol) + this.refresh(b, this.params.tol);
      const pa = this.phi[a];
      const pb = this.phi[b];
      for (let e = 0; e < this.edgeCount; e++) {
        if (!this.alive[e]) continue;
        const u = this.ea[e];
        const v = this.eb[e];
        Q[e] = (this.D[e] / this.len[e]) * i0 * (pa[u] - pb[u] - (pa[v] - pb[v]));
      }
    }
    for (let e = 0; e < this.edgeCount; e++) {
      if (!this.alive[e]) continue;
      const grow = pair ? f(Math.abs(Q[e]), gamma) : 0;
      this.D[e] = Math.max(floor, this.D[e] + dt * (grow - this.D[e]));
    }
    this.steps++;
    this.time += dt;
    return iterations;
  }

  /** A random source and a different random sink in the same component, by weight. */
  private pickPair(): [number, number] | null {
    const n = this.foods.length;
    if (n < 2) return null;
    let total = 0;
    for (const s of this.foods) total += s.weight;
    const draw = (skip: number) => {
      let t = this.rng() * (total - (skip >= 0 ? this.foods[skip].weight : 0));
      for (let k = 0; k < n; k++) {
        if (k === skip) continue;
        t -= this.foods[k].weight;
        if (t < 0) return k;
      }
      return skip === n - 1 ? n - 2 : n - 1;
    };
    for (let tries = 0; tries < 8; tries++) {
      const a = draw(-1);
      const b = draw(a);
      if (this.root[a] === this.root[b] && this.root[a] >= 0) return [a, b];
    }
    return null;
  }

  /** Labels connected components over alive edges and picks each food's root. */
  private labelComponents(): void {
    const comp = this.comp.fill(-1);
    const stack: number[] = [];
    let label = 0;
    for (let s = 0; s < this.vertexCount; s++) {
      if (comp[s] >= 0) continue;
      comp[s] = label;
      stack.push(s);
      while (stack.length) {
        const v = stack.pop()!;
        for (let k = this.off[v]; k < this.off[v + 1]; k++) {
          const e = this.adjE[k];
          if (!this.alive[e]) continue;
          const u = this.ea[e] === v ? this.eb[e] : this.ea[e];
          if (comp[u] < 0) {
            comp[u] = label;
            stack.push(u);
          }
        }
      }
      label++;
    }
    const firstFood = new Map<number, number>();
    const oldRoot = this.root;
    this.root = this.foods.map((s, k) => {
      const c = comp[s.vertex];
      if (!firstFood.has(c)) firstFood.set(c, k);
      return firstFood.get(c)!;
    });
    // A food whose root changed re-bases its potential: φₖ − φ_newRoot solves for the new root.
    this.root.forEach((r, k) => {
      if (oldRoot[k] === undefined || oldRoot[k] === r) return;
      const pk = this.phi[k];
      const pr = this.phi[r];
      if (k === r) pk.fill(0);
      else for (let v = 0; v < pk.length; v++) pk[v] -= pr[v];
    });
    this.compDirty = false;
  }

  /** Packs the alive tubes' weights D / L and the Laplacian's diagonal for the solves. */
  private assemble(): void {
    const { ca, cb, cw, diag } = this;
    diag.fill(0);
    let m = 0;
    for (let e = 0; e < this.edgeCount; e++) {
      if (!this.alive[e]) continue;
      const we = this.D[e] / this.len[e];
      ca[m] = this.ea[e];
      cb[m] = this.eb[e];
      cw[m] = we;
      diag[this.ea[e]] += we;
      diag[this.eb[e]] += we;
      m++;
    }
    this.packed = m;
  }

  /** out = L · src, over the packed tubes. */
  private mul(src: Float64Array, out: Float64Array): void {
    const { ca, cb, cw, diag } = this;
    for (let v = 0; v < out.length; v++) out[v] = diag[v] * src[v];
    for (let i = 0; i < this.packed; i++) {
      const u = ca[i];
      const v = cb[i];
      const w = cw[i];
      out[u] -= w * src[v];
      out[v] -= w * src[u];
    }
  }

  /**
   * Solves L φₖ = eₖ − e_root by Jacobi-preconditioned CG from the current φₖ (after
   * `assemble`). The residual starts at zero outside φₖ's component and the Laplacian never
   * couples components, so the solve stays inside it.
   */
  private refresh(k: number, tol: number, maxIter = 4000): number {
    const r0 = this.root[k];
    if (r0 === k) return 0;
    const x = this.phi[k];
    const { r, z, p, ap, diag } = this;
    const nv = this.vertexCount;
    const c = this.comp[this.foods[k].vertex];
    this.mul(x, ap);
    for (let v = 0; v < nv; v++) r[v] = this.comp[v] === c ? -ap[v] : 0;
    r[this.foods[k].vertex] += 1;
    r[this.foods[r0].vertex] -= 1;
    const bNorm = Math.SQRT2;
    let rz = 0;
    let rr = 0;
    for (let v = 0; v < nv; v++) {
      z[v] = diag[v] > 0 ? r[v] / diag[v] : 0;
      p[v] = z[v];
      rz += r[v] * z[v];
      rr += r[v] * r[v];
    }
    let it = 0;
    while (Math.sqrt(rr) > tol * bNorm && it < maxIter) {
      this.mul(p, ap);
      let pap = 0;
      for (let v = 0; v < nv; v++) pap += p[v] * ap[v];
      if (pap <= 0) break;
      const alpha = rz / pap;
      let rz2 = 0;
      rr = 0;
      for (let v = 0; v < nv; v++) {
        x[v] += alpha * p[v];
        r[v] -= alpha * ap[v];
        z[v] = diag[v] > 0 ? r[v] / diag[v] : 0;
        rz2 += r[v] * z[v];
        rr += r[v] * r[v];
      }
      const beta = rz2 / rz;
      rz = rz2;
      for (let v = 0; v < nv; v++) p[v] = z[v] + beta * p[v];
      it++;
    }
    return it;
  }

  /**
   * Flux through every alive tube when food `a` is the source and `b` the sink, solved fresh
   * (for tests and the tour's live flow arrows). Returns the flux and the Kirchhoff residual
   * (the largest imbalance at any junction other than a and b).
   */
  flux(a: number, b: number): { Q: Float64Array; residual: number } {
    if (this.compDirty) this.labelComponents();
    this.assemble();
    this.refresh(a, 1e-10);
    this.refresh(b, 1e-10);
    const { i0 } = this.params;
    const Q = new Float64Array(this.edgeCount);
    const net = new Float64Array(this.vertexCount);
    for (let e = 0; e < this.edgeCount; e++) {
      if (!this.alive[e]) continue;
      const u = this.ea[e];
      const v = this.eb[e];
      Q[e] = (this.D[e] / this.len[e]) * i0 * (this.phi[a][u] - this.phi[b][u] - (this.phi[a][v] - this.phi[b][v]));
      net[u] -= Q[e];
      net[v] += Q[e];
    }
    let residual = 0;
    for (let v = 0; v < this.vertexCount; v++) {
      if (v === this.foods[a].vertex || v === this.foods[b].vertex) continue;
      residual = Math.max(residual, Math.abs(net[v]));
    }
    return { Q, residual };
  }

  /** Cuts every alive tube that crosses the segment; returns how many. */
  cut(x0: number, y0: number, x1: number, y1: number): number {
    let n = 0;
    for (let e = 0; e < this.edgeCount; e++) {
      if (!this.alive[e]) continue;
      const a = this.ea[e];
      const b = this.eb[e];
      if (segmentsCross(x0, y0, x1, y1, this.vx[a], this.vy[a], this.vx[b], this.vy[b])) {
        this.alive[e] = 0;
        this.D[e] = 0;
        n++;
      }
    }
    if (n) this.compDirty = true;
    return n;
  }

  /**
   * The mold's network: tubes above `threshold` (see NETWORK_SHARE), reachable from a food, with dead ends that
   * reach no food dropped. Chains of tubes become one link between foods and junctions, and
   * each link's path is smoothed, so its length is not the lattice's zigzag.
   */
  extractNetwork(threshold = NETWORK_SHARE * f(this.params.i0, this.params.gamma)): Network {
    const nv = this.vertexCount;
    const on = new Uint8Array(this.edgeCount);
    for (let e = 0; e < this.edgeCount; e++) on[e] = this.alive[e] && this.D[e] > threshold ? 1 : 0;
    const foodAt = new Int32Array(nv).fill(-1);
    this.foods.forEach((s, k) => (foodAt[s.vertex] = k));
    const other = (e: number, v: number) => (this.ea[e] === v ? this.eb[e] : this.ea[e]);
    // Keep what a food can reach.
    const seen = new Uint8Array(nv);
    const stack = this.foods.map((s) => s.vertex);
    for (const v of stack) seen[v] = 1;
    while (stack.length) {
      const v = stack.pop()!;
      for (let k = this.off[v]; k < this.off[v + 1]; k++) {
        const e = this.adjE[k];
        const u = other(e, v);
        if (on[e] && !seen[u]) {
          seen[u] = 1;
          stack.push(u);
        }
      }
    }
    for (let e = 0; e < this.edgeCount; e++) if (on[e] && !seen[this.ea[e]]) on[e] = 0;
    // Strip dead ends that hold no food.
    const deg = new Int32Array(nv);
    for (let e = 0; e < this.edgeCount; e++) if (on[e]) { deg[this.ea[e]]++; deg[this.eb[e]]++; }
    const leaves: number[] = [];
    for (let v = 0; v < nv; v++) if (deg[v] === 1 && foodAt[v] < 0) leaves.push(v);
    while (leaves.length) {
      const v = leaves.pop()!;
      for (let k = this.off[v]; k < this.off[v + 1]; k++) {
        const e = this.adjE[k];
        if (!on[e]) continue;
        on[e] = 0;
        deg[v]--;
        const u = other(e, v);
        if (--deg[u] === 1 && foodAt[u] < 0) leaves.push(u);
      }
    }
    this.networkTubes = on;
    // Foods and junctions become nodes; chains between them become links.
    const nodeOf = new Int32Array(nv).fill(-1);
    const net: Network = { nodes: [], links: [] };
    const nodeAt = (v: number) => {
      if (nodeOf[v] < 0) {
        nodeOf[v] = net.nodes.length;
        const k = foodAt[v];
        net.nodes.push(k >= 0 ? { x: this.foods[k].x, y: this.foods[k].y, food: k } : { x: this.vx[v], y: this.vy[v], food: -1 });
      }
      return nodeOf[v];
    };
    for (const s of this.foods) nodeAt(s.vertex);
    const isKey = (v: number) => foodAt[v] >= 0 || deg[v] >= 3;
    const used = new Uint8Array(this.edgeCount);
    for (let start = 0; start < nv; start++) {
      if (!isKey(start) || deg[start] === 0) continue;
      for (let k = this.off[start]; k < this.off[start + 1]; k++) {
        const e0 = this.adjE[k];
        if (!on[e0] || used[e0]) continue;
        const verts = [start];
        let e = e0;
        let v = start;
        for (;;) {
          used[e] = 1;
          v = other(e, v);
          verts.push(v);
          if (isKey(v)) break;
          let next = -1;
          for (let q = this.off[v]; q < this.off[v + 1]; q++) {
            const e2 = this.adjE[q];
            if (on[e2] && !used[e2]) next = e2;
          }
          if (next < 0) break;
          e = next;
        }
        const a = nodeAt(start);
        const b = nodeAt(v);
        const path = this.smoothPath(verts, net.nodes[a], net.nodes[b]);
        let length = 0;
        for (let i = 2; i < path.length; i += 2) length += dist(path[i - 2], path[i - 1], path[i], path[i + 1]);
        net.links.push({ a, b, length, path });
      }
    }
    return net;
  }

  /** The chain's points with fixed ends, relaxed toward their neighbours' midpoints. */
  private smoothPath(verts: number[], a: { x: number; y: number }, b: { x: number; y: number }): number[] {
    const n = verts.length;
    const xs = verts.map((v) => this.vx[v]);
    const ys = verts.map((v) => this.vy[v]);
    xs[0] = a.x; ys[0] = a.y;
    xs[n - 1] = b.x; ys[n - 1] = b.y;
    for (let it = 0; it < 5; it++) {
      for (let i = 1; i < n - 1; i++) {
        xs[i] = 0.5 * xs[i] + 0.25 * (xs[i - 1] + xs[i + 1]);
        ys[i] = 0.5 * ys[i] + 0.25 * (ys[i - 1] + ys[i + 1]);
      }
    }
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(xs[i], ys[i]);
    return out;
  }
}

function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = o(ax, ay, bx, by, cx, cy);
  const d2 = o(ax, ay, bx, by, dx, dy);
  const d3 = o(cx, cy, dx, dy, ax, ay);
  const d4 = o(cx, cy, dx, dy, bx, by);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
