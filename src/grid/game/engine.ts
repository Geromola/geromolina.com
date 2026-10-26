import { Board, inBounds, type Bounds } from './board';
import type { GameLayout, GameNode } from './layout';
import { generateFaults, LEVELS, mulberry32, type LevelDef } from './levels';
import {
  AMBIENT_FRACTION,
  DRIFT,
  HEAT_TAU,
  HIGH,
  LIT_THRESHOLD,
  LOSS_HIGH,
  LOSS_LOW,
  LOW,
  PLANT_MW,
  ROUTE_TEMP,
  SEG_COST,
  T_COST,
  T_LOSS,
} from './physics';
import { bestPlant, costTable, type LoadRoute } from './routing';
import { candidatesFor, solve, type Problem, type Solution } from './solver';

/**
 * The grid game, DOM-free (SPEC "The grid game"). Owns the level, the
 * transformers, the routing tables, the electron pool and the heat layer.
 * Everything is in lattice units: vertex (col, row), each segment has length 1.
 */

export interface EngineOptions {
  cols: number;
  rows: number;
  nodes: readonly GameNode[];
  /** Vertices where transformers may go and faults may fall. Default: the whole lattice. */
  bounds?: Bounds;
  /** Electron pool size, ambient included. */
  count?: number;
  ambientFraction?: number;
  seed?: number;
  levels?: readonly LevelDef[];
  /** Initial level index (0-based). */
  level?: number;
  /** Vertices kept free of transformers (see `setBlocked`). */
  blocked?: Iterable<number> | readonly Transformer[];
  /**
   * Decorative flow (the projects hero, SPEC "Home hero v2"): counted packets
   * keep all their energy (no line or transformer loss, so no heat), nothing
   * can be placed, there are no faults and the solver never runs.
   */
  decorative?: boolean;
}

export interface LoadResult {
  id: string;
  efficiency: number;
  lit: boolean;
}

export interface Evaluation {
  /** Mean load efficiency, 0..1. */
  efficiency: number;
  perLoad: LoadResult[];
  won: boolean;
  deliveredMW: number;
  lostMW: number;
  /** 0 when not won, else 1–3. */
  stars: 0 | 1 | 2 | 3;
  /** Solver's efficiency for this level and layout. */
  best: number;
}

export interface Transformer {
  col: number;
  row: number;
}

/** ★ = won; ★★ = efficiency ≥ 0.93 × best; ★★★ = efficiency ≥ 0.985 × best. */
export function starsFor(won: boolean, efficiency: number, best: number): 0 | 1 | 2 | 3 {
  if (!won) return 0;
  return efficiency >= 0.985 * best ? 3 : efficiency >= 0.93 * best ? 2 : 1;
}

const BASE_SPEED = 2.2; // lattice units / s at LOW, plus up to SPEED_JITTER
const SPEED_JITTER = 1.0;
const E_DEATH = 0.05; // counted packets below this energy fizzle out
const LOST_LIFE = 3; // s a packet with no route wanders before dying
const MAX_AGE = 120; // s safety cap so no packet lives forever
const SPAWN_SPREAD = 3; // s over which a fresh level's packets leave the plants
const AMBIENT_BRIGHT = 0.22;
const AMBER_FROM = 0.9; // energy where LOW packets start turning amber
const AMBER_TO = 0.3; // energy where they are fully amber
const MAX_DT = 1 / 20;
const KEEP: readonly [number, number] = [1 - LOSS_LOW, 1 - LOSS_HIGH];

export class GridGame {
  readonly board: Board;
  readonly cols: number;
  readonly rows: number;
  readonly nodes: readonly GameNode[];
  readonly bounds: Bounds;
  readonly levels: readonly LevelDef[];
  /** See `EngineOptions.decorative`. */
  readonly decorative: boolean;

  // ---- per edge ----
  /** Energy lost on each edge (packet units), decaying with τ = HEAT_TAU. */
  readonly heat: Float32Array;
  /** 1 where the current level has cut the edge. */
  readonly faulted: Uint8Array;

  // ---- per vertex ----
  /** 1 where a transformer sits. */
  readonly isTransformer: Uint8Array;
  /** 1 where transformers may not go (hero text, the panel): fails `canPlace`, never a solver candidate. */
  readonly blocked: Uint8Array;

  // ---- per electron (structure of arrays) ----
  readonly count: number;
  readonly ambient: Uint8Array;
  /** Voltage level, LOW (0) or HIGH (1). */
  readonly volt: Uint8Array;
  /** Remaining energy, 1 at the plant. */
  readonly energy: Float32Array;
  /** Target load node index; −1 for ambient. */
  readonly target: Int16Array;
  /** Outputs for renderers. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly bright: Float32Array;
  /** +1 HIGH (white-hot), 0 LOW (cyan), < 0 toward amber as energy runs out. */
  readonly hue: Float32Array;

  // ---- per node (indices into `nodes`) ----
  /** Packets delivered at LOW, cumulative. */
  readonly delivered: Uint32Array;
  /** Packets that arrived at HIGH (overvoltage, not delivered), cumulative. */
  readonly sparked: Uint32Array;
  /** Energy delivered at LOW (packet units), cumulative. */
  readonly deliveredEnergy: Float64Array;

  time = 0;

  private readonly from: Int32Array; // vertex the electron left
  private readonly to: Int32Array; // vertex it is heading to
  private readonly edge: Int32Array; // edge it is on, −1 if none
  private readonly s: Float32Array; // progress along the edge, 0..1
  private readonly speed: Float32Array;
  private readonly slot: Int8Array; // index into `loads` / tables; −1 ambient
  private readonly delay: Float32Array; // hidden at the plant until 0
  private readonly lostT: Float32Array; // seconds without a route
  private readonly lost: Uint8Array;
  private readonly age: Float32Array;

  private readonly rand: () => number;
  private readonly nodeAt = new Map<number, number>(); // vertex → node index
  private readonly nodeVerts = new Set<number>();
  private readonly idIndex = new Map<string, number>();
  private readonly placed: number[] = []; // transformer vertices, in placement order
  private readonly scratch = new Float64Array(4); // softmax options
  private readonly scratchV = new Int32Array(4);
  private readonly scratchE = new Int32Array(4);

  private levelIdx = 0;
  private plantVerts: number[] = [];
  private loadVerts: number[] = [];
  private loadNodes: number[] = [];
  private plantNodes: number[] = [];
  private tablesArr: Float64Array[] = [];
  private routesArr: LoadRoute[] = [];
  private solution: Solution | null = null;
  private faultSeedUsed: number | null = null;
  private rr = 0;
  private cached: Evaluation | null = null;
  // Focus (see `setFocus`): an extra routing slot, after the loads.
  private focusNode = -1;
  private focusVert = -1;
  private focusShare = 0;
  private focusTable: Float64Array | null = null;
  private focusSources: number[] = [];

  constructor(opts: EngineOptions) {
    this.board = new Board(opts.cols, opts.rows);
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.nodes = opts.nodes;
    this.bounds = opts.bounds ?? { minC: 0, maxC: opts.cols - 1, minR: 0, maxR: opts.rows - 1 };
    this.levels = opts.levels ?? LEVELS;
    this.decorative = opts.decorative ?? false;
    this.rand = mulberry32(opts.seed ?? 0x9e3779b9);

    this.nodes.forEach((n, i) => {
      const v = this.board.vertex(n.col, n.row);
      this.nodeAt.set(v, i);
      this.nodeVerts.add(v);
      this.idIndex.set(n.id, i);
    });

    this.heat = new Float32Array(this.board.E);
    this.faulted = new Uint8Array(this.board.E);
    this.isTransformer = new Uint8Array(this.board.V);
    this.blocked = new Uint8Array(this.board.V);
    if (opts.blocked) this.blocked.set(this.blockMask(opts.blocked));

    const n = (this.count = Math.max(0, Math.floor(opts.count ?? 1200)));
    this.ambient = new Uint8Array(n);
    this.volt = new Uint8Array(n);
    this.energy = new Float32Array(n);
    this.target = new Int16Array(n).fill(-1);
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.bright = new Float32Array(n);
    this.hue = new Float32Array(n);
    this.from = new Int32Array(n);
    this.to = new Int32Array(n);
    this.edge = new Int32Array(n).fill(-1);
    this.s = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.slot = new Int8Array(n).fill(-1);
    this.delay = new Float32Array(n);
    this.lostT = new Float32Array(n);
    this.lost = new Uint8Array(n);
    this.age = new Float32Array(n);
    this.delivered = new Uint32Array(this.nodes.length);
    this.sparked = new Uint32Array(this.nodes.length);
    this.deliveredEnergy = new Float64Array(this.nodes.length);

    const ambientCount = Math.round(n * (opts.ambientFraction ?? AMBIENT_FRACTION));
    for (let i = 0; i < n; i++) {
      this.ambient[i] = i < ambientCount ? 1 : 0;
      this.speed[i] = BASE_SPEED + this.rand() * SPEED_JITTER;
    }
    this.setLevel(opts.level ?? 0);
  }

  /** Build from `layoutGame()` output. */
  static fromLayout(layout: GameLayout, opts: Omit<EngineOptions, 'cols' | 'rows' | 'nodes' | 'bounds'> = {}) {
    return new GridGame({ ...opts, cols: layout.lattice.cols, rows: layout.lattice.rows, nodes: layout.nodes, bounds: layout.bounds });
  }

  // ------------------------------------------------------------------ level

  get levelIndex(): number {
    return this.levelIdx;
  }

  get levelDef(): LevelDef {
    return this.levels[this.levelIdx];
  }

  /** Node indices of the active plants and target loads. */
  get activePlants(): readonly number[] {
    return this.plantNodes;
  }

  get activeLoads(): readonly number[] {
    return this.loadNodes;
  }

  get budget(): number {
    return this.levelDef.budget;
  }

  get budgetLeft(): number {
    return this.levelDef.budget - this.placed.length;
  }

  /** Seed the current faults came from (after regeneration), or null for no faults. */
  get faultSeed(): number | null {
    return this.faultSeedUsed;
  }

  /** Whether the solver wins this level with the current layout, faults and blocked set. */
  get solvable(): boolean {
    return this.solution?.won ?? false;
  }

  /** The solver's placement for this level and layout. */
  get solverPlacement(): Transformer[] {
    return (this.solution?.placement ?? []).map((v) => this.toCR(v));
  }

  /** Switch level (0-based). Clears transformers, recomputes faults, routing and the solver's best. */
  setLevel(i: number) {
    if (!Number.isInteger(i) || i < 0 || i >= this.levels.length) throw new RangeError(`No level ${i}`);
    this.levelIdx = i;
    const def = this.levels[i];
    if (!def.plants.length || !def.loads.length) throw new Error(`Level ${i} needs a plant and a load`);
    this.plantNodes = def.plants.map((id) => this.mustIndex(id));
    this.loadNodes = def.loads.map((id) => this.mustIndex(id));
    this.plantVerts = this.plantNodes.map((k) => this.vertexOfNode(k));
    this.loadVerts = this.loadNodes.map((k) => this.vertexOfNode(k));
    this.tablesArr = this.loadVerts.map(() => new Float64Array(this.board.V * 2));
    this.focusSourcesFor();
    for (const v of this.placed) this.isTransformer[v] = 0;
    this.placed.length = 0;
    this.heat.fill(0);

    this.solveLevel();
    this.recompute();
    this.rr = 0;
    for (let e = 0; e < this.count; e++) this.spawn(e, true);
    this.writeOutputs();
  }

  /**
   * Keep these vertices free of transformers (vertex indices or `{ col, row }`;
   * anything outside the lattice is ignored). Blocked vertices fail `canPlace`
   * and the solver never uses them, so a change re-runs the solver (and, on a
   * storm level, the search for solvable faults). Transformers already on the
   * board stay where they are. Returns false when the set didn't change.
   */
  setBlocked(vertices: Iterable<number> | readonly Transformer[]): boolean {
    const mask = this.blockMask(vertices);
    if (mask.every((b, v) => b === this.blocked[v])) return false;
    this.blocked.set(mask);
    this.solveLevel();
    this.recompute();
    return true;
  }

  isBlocked(col: number, row: number): boolean {
    return this.board.inLattice(col, row) && this.blocked[this.board.vertex(col, row)] === 1;
  }

  private blockMask(vertices: Iterable<number> | readonly Transformer[]): Uint8Array {
    const mask = new Uint8Array(this.board.V);
    for (const item of vertices as Iterable<number | Transformer>) {
      if (typeof item === 'number') {
        if (Number.isInteger(item) && item >= 0 && item < this.board.V) mask[item] = 1;
      } else if (item && this.board.inLattice(item.col, item.row)) {
        mask[this.board.vertex(item.col, item.row)] = 1;
      }
    }
    return mask;
  }

  /** Faults (regenerated until solvable) and the solver's best, for the current level and blocked set. */
  private solveLevel() {
    const def = this.levelDef;
    this.faulted.fill(0);
    this.faultSeedUsed = null;
    if (this.decorative) {
      this.solution = null;
      return;
    }
    const problem = this.solverProblem();
    if (def.faults) {
      const { fraction, seed } = def.faults;
      for (let k = 0; k < 64; k++) {
        this.faulted.set(this.generateFaults(fraction, seed + k));
        this.faultSeedUsed = seed + k;
        this.solution = solve(problem);
        if (this.solution.won) break;
      }
    } else {
      this.solution = solve(problem);
    }
  }

  /** The solver's input for the current level, layout and faults. */
  solverProblem(): Problem {
    return {
      board: this.board,
      faulted: this.faulted,
      plants: this.plantVerts,
      loads: this.loadVerts,
      budget: this.levelDef.budget,
      candidates: candidatesFor(this.board, this.bounds, this.nodeVerts, [...this.plantVerts, ...this.loadVerts]).filter(
        (v) => this.blocked[v] === 0,
      ),
    };
  }

  /** Remove every transformer. */
  reset() {
    for (const v of this.placed) this.isTransformer[v] = 0;
    this.placed.length = 0;
    this.recompute();
  }

  /** Deterministic faults for this layout and seed (no side effects). */
  generateFaults(fraction: number, seed: number): Uint8Array {
    return generateFaults(this.board, this.bounds, this.nodeVerts, fraction, seed);
  }

  // ------------------------------------------------------------ placement

  /** Valid empty junction: integer, in the visible bounds, not a node, not blocked, not occupied. */
  canPlace(col: number, row: number): boolean {
    if (this.decorative) return false;
    if (!this.board.inLattice(col, row) || !inBounds(this.bounds, col, row)) return false;
    const v = this.board.vertex(col, row);
    return !this.nodeVerts.has(v) && this.blocked[v] === 0 && this.isTransformer[v] === 0;
  }

  hasTransformer(col: number, row: number): boolean {
    return this.board.inLattice(col, row) && this.isTransformer[this.board.vertex(col, row)] === 1;
  }

  /** Place one. False when invalid or out of budget. */
  placeTransformer(col: number, row: number): boolean {
    if (this.budgetLeft <= 0 || !this.canPlace(col, row)) return false;
    const v = this.board.vertex(col, row);
    this.isTransformer[v] = 1;
    this.placed.push(v);
    this.recompute();
    return true;
  }

  removeTransformer(col: number, row: number): boolean {
    if (!this.hasTransformer(col, row)) return false;
    const v = this.board.vertex(col, row);
    this.isTransformer[v] = 0;
    this.placed.splice(this.placed.indexOf(v), 1);
    this.recompute();
    return true;
  }

  /** Move one. Moving onto itself is a no-op success; an invalid target leaves it in place. */
  moveTransformer(fromCol: number, fromRow: number, toCol: number, toRow: number): boolean {
    if (!this.hasTransformer(fromCol, fromRow)) return false;
    if (fromCol === toCol && fromRow === toRow) return true;
    if (!this.canPlace(toCol, toRow)) return false;
    const a = this.board.vertex(fromCol, fromRow);
    const b = this.board.vertex(toCol, toRow);
    this.isTransformer[a] = 0;
    this.isTransformer[b] = 1;
    this.placed[this.placed.indexOf(a)] = b;
    this.recompute();
    return true;
  }

  /** Placed transformers, in placement order. */
  get transformers(): Transformer[] {
    return this.placed.map((v) => this.toCR(v));
  }

  /**
   * Decorative flow only (the node menu, SPEC "Home hero v3"): fix a set of
   * hidden transformers so the flow runs along solved-looking corridors
   * (see `corridorTransformers`). Replaces any previous set; node vertices,
   * duplicates and vertices outside the lattice are skipped. Budget and
   * bounds don't apply. Returns false (and changes nothing) on a game that
   * isn't decorative, where transformers are the player's to place.
   */
  setDecorTransformers(vertices: Iterable<number> | readonly Transformer[]): boolean {
    if (!this.decorative) return false;
    for (const v of this.placed) this.isTransformer[v] = 0;
    this.placed.length = 0;
    const mask = this.blockMask(vertices);
    for (let v = 0; v < mask.length; v++) {
      if (!mask[v] || this.nodeVerts.has(v)) continue;
      this.isTransformer[v] = 1;
      this.placed.push(v);
    }
    this.recompute();
    return true;
  }

  // -------------------------------------------------------------- routing

  /** Cost tables (nats, index `vertex * 2 + level`), aligned with `activeLoads`. */
  get tables(): readonly Float64Array[] {
    return this.tablesArr;
  }

  /** Best plant (vertex) and efficiency per active load, aligned with `activeLoads`. */
  get routes(): readonly LoadRoute[] {
    return this.routesArr;
  }

  evaluate(): Evaluation {
    if (this.cached) return this.cached;
    const perLoad = this.loadNodes.map((k, j) => {
      const efficiency = this.routesArr[j].efficiency;
      return { id: this.nodes[k].id, efficiency, lit: efficiency >= LIT_THRESHOLD };
    });
    const efficiency = perLoad.length ? perLoad.reduce((a, l) => a + l.efficiency, 0) / perLoad.length : 0;
    const won = perLoad.length > 0 && perLoad.every((l) => l.lit);
    const best = this.solution?.efficiency ?? 0;
    const total = PLANT_MW * this.plantNodes.length;
    const stars = starsFor(won, efficiency, best);
    this.cached = { efficiency, perLoad, won, deliveredMW: total * efficiency, lostMW: total * (1 - efficiency), stars, best };
    return this.cached;
  }

  private recompute() {
    this.routesArr = this.loadVerts.map((load, j) => {
      costTable(this.board, this.isTransformer, this.faulted, load, this.tablesArr[j]);
      return bestPlant(this.tablesArr[j], this.plantVerts);
    });
    if (this.focusTable && this.focusVert >= 0) costTable(this.board, this.isTransformer, this.faulted, this.focusVert, this.focusTable);
    this.cached = null;
  }

  // ---------------------------------------------------------------- focus

  /** Node index the flow is biased toward, or −1. */
  get focus(): number {
    return this.focusNode;
  }

  /**
   * Bias the flow toward node `k` (any node, plant or load), e.g. a hovered
   * card: a `share` of new counted packets leave a random other active node
   * (plants and loads) and head for `k`. −1 stops the bias; packets already
   * heading for the old focus finish their trip. Moving the focus retargets
   * them. Until a focus is set the engine draws no extra random numbers, so
   * the default flow is unchanged.
   */
  setFocus(k: number, share = 0.5) {
    if (!Number.isInteger(k) || k < 0 || k >= this.nodes.length) k = -1;
    this.focusShare = Math.min(1, Math.max(0, share));
    if (k === this.focusNode) return;
    this.focusNode = k;
    if (k < 0) return;
    this.focusVert = this.vertexOfNode(k);
    this.focusTable ??= new Float64Array(this.board.V * 2);
    costTable(this.board, this.isTransformer, this.faulted, this.focusVert, this.focusTable);
    this.focusSourcesFor();
    // Packets already on their way to an old focus follow the new one, and a
    // `share` of the others turn toward it now, so the pull shows at once.
    const slot = this.loadVerts.length;
    for (let i = 0; i < this.count; i++) {
      if (this.ambient[i]) continue;
      if (this.slot[i] === slot || (this.delay[i] <= 0 && this.rand() < this.focusShare)) {
        this.slot[i] = slot;
        this.target[i] = k;
      }
    }
  }

  private focusSourcesFor() {
    const all = [...new Set([...this.plantVerts, ...this.loadVerts])];
    this.focusSources = all.filter((v) => v !== this.focusVert);
  }

  /** Target vertex and cost table of routing slot `j` (loads, then the focus). */
  private slotVert(j: number): number {
    return j < this.loadVerts.length ? this.loadVerts[j] : this.focusVert;
  }

  private slotTable(j: number): Float64Array {
    return j < this.tablesArr.length ? this.tablesArr[j] : this.focusTable!;
  }

  // ------------------------------------------------------------ electrons

  step(dt: number) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, MAX_DT);
    this.time += dt;
    const decay = Math.exp(-dt / HEAT_TAU);
    for (let e = 0; e < this.heat.length; e++) this.heat[e] *= decay;

    for (let i = 0; i < this.count; i++) {
      if (this.delay[i] > 0) {
        this.delay[i] -= dt;
        if (this.delay[i] > 0) continue;
      }
      this.age[i] += dt;
      if (this.lost[i]) this.lostT[i] += dt;
      if (!this.ambient[i] && (this.lostT[i] > LOST_LIFE || this.age[i] > MAX_AGE)) {
        this.spawn(i, false);
        continue;
      }
      if (this.ambient[i] && this.age[i] > MAX_AGE) {
        this.spawn(i, false);
        continue;
      }
      let t = dt;
      for (let guard = 0; t > 0 && guard < 6; guard++) {
        if (this.edge[i] < 0) {
          this.spawn(i, false);
          break;
        }
        const lv = this.volt[i];
        const v = this.speed[i] * DRIFT[lv];
        const left = 1 - this.s[i];
        const need = left / v;
        const ds = need <= t ? left : v * t;
        if (!this.ambient[i] && !this.decorative) this.lose(i, Math.pow(KEEP[lv], ds));
        if (need <= t) {
          t -= need;
          this.s[i] = 1;
          if (!this.arrive(i)) break; // respawned
        } else {
          this.s[i] += ds;
          t = 0;
        }
      }
    }
    this.writeOutputs();
  }

  /** Multiply a counted packet's energy by `keep`, booking the loss as heat on its edge. */
  private lose(i: number, keep: number) {
    const e0 = this.energy[i];
    const e1 = e0 * keep;
    this.energy[i] = e1;
    const edge = this.edge[i];
    if (edge >= 0) this.heat[edge] += e0 - e1;
  }

  /** Reached `to`. Returns false if the electron was respawned. */
  private arrive(i: number): boolean {
    const prev = this.from[i];
    const v = this.to[i];
    this.from[i] = v;
    this.s[i] = 0;

    if (!this.ambient[i]) {
      if (this.isTransformer[v]) {
        this.volt[i] = 1 - this.volt[i];
        if (!this.decorative) this.lose(i, 1 - T_LOSS); // decorative packets stay lossless
      }
      const k = this.target[i];
      if (k >= 0 && v === this.slotVert(this.slot[i])) {
        if (this.volt[i] === LOW) {
          this.delivered[k]++;
          this.deliveredEnergy[k] += this.energy[i];
        }
        else this.sparked[k]++; // overvoltage: sparks, not delivered
        this.spawn(i, false);
        return false;
      }
      if (this.energy[i] < E_DEATH) {
        this.spawn(i, false);
        return false;
      }
    }
    return this.chooseNext(i, prev);
  }

  /**
   * Pick the next edge out of `from[i]`. Counted packets use a softmax over
   * `edgeCost + cost_L(next, level')`; with no route they wander. Avoids
   * immediate reversal unless it's the only way. False if it had to respawn.
   */
  private chooseNext(i: number, prev: number): boolean {
    const v = this.from[i];
    const { nbrV, nbrE } = this.board;
    const optV = this.scratchV;
    const optE = this.scratchE;
    let m = 0;
    let back = -1;
    for (let k = 0; k < 4; k++) {
      const n = nbrV[v * 4 + k];
      if (n < 0) break;
      const e = nbrE[v * 4 + k];
      if (this.faulted[e]) continue;
      if (n === prev) back = k;
      else {
        optV[m] = n;
        optE[m++] = e;
      }
    }
    if (m === 0 && back >= 0) {
      optV[0] = prev;
      optE[0] = nbrE[v * 4 + back];
      m = 1;
    }
    if (m === 0) {
      this.spawn(i, false);
      return false;
    }

    let pick = -1;
    if (!this.ambient[i]) {
      const table = this.slotTable(this.slot[i]);
      const lv = this.volt[i];
      const score = this.scratch;
      let min = Infinity;
      for (let j = 0; j < m; j++) {
        const n = optV[j];
        const t = this.isTransformer[n];
        const ln = t ? 1 - lv : lv;
        score[j] = SEG_COST[lv] + (t ? T_COST : 0) + table[n * 2 + ln];
        if (score[j] < min) min = score[j];
      }
      if (Number.isFinite(min)) {
        this.lost[i] = 0;
        this.lostT[i] = 0;
        // Temperature scales with the level's segment cost, so HIGH packets stay
        // as directed as LOW ones even though their costs are 625× smaller.
        const temp = (ROUTE_TEMP * SEG_COST[lv]) / SEG_COST[LOW];
        let total = 0;
        for (let j = 0; j < m; j++) {
          score[j] = Number.isFinite(score[j]) ? Math.exp(-(score[j] - min) / temp) : 0;
          total += score[j];
        }
        let r = this.rand() * total;
        for (let j = 0; j < m; j++) {
          r -= score[j];
          if (r <= 0 && score[j] > 0) {
            pick = j;
            break;
          }
        }
        if (pick < 0) for (let j = m - 1; j >= 0 && pick < 0; j--) if (score[j] > 0) pick = j;
      } else {
        this.lost[i] = 1;
      }
    }
    if (pick < 0) pick = Math.floor(this.rand() * m);
    this.to[i] = optV[pick];
    this.edge[i] = optE[pick];
    return true;
  }

  private spawn(i: number, fresh: boolean) {
    this.age[i] = 0;
    this.lost[i] = 0;
    this.lostT[i] = 0;
    this.s[i] = 0;
    this.edge[i] = -1;
    this.volt[i] = LOW;
    this.energy[i] = 1;
    this.delay[i] = 0;
    let v: number;
    if (this.ambient[i]) {
      v = Math.floor(this.rand() * this.board.V);
      this.target[i] = -1;
      this.slot[i] = -1;
      if (fresh) this.age[i] = this.rand() * MAX_AGE;
    } else if (this.focusNode >= 0 && this.focusSources.length && this.rand() < this.focusShare) {
      v = this.focusSources[Math.floor(this.rand() * this.focusSources.length)];
      this.target[i] = this.focusNode;
      this.slot[i] = this.loadVerts.length;
      if (fresh) this.delay[i] = this.rand() * SPAWN_SPREAD;
    } else {
      const j = this.rr++ % this.loadVerts.length;
      const route = this.routesArr[j];
      v = route && route.plant >= 0 ? route.plant : this.plantVerts[this.rr % this.plantVerts.length];
      this.target[i] = this.loadNodes[j];
      this.slot[i] = j;
      if (fresh) this.delay[i] = this.rand() * SPAWN_SPREAD;
    }
    this.from[i] = v;
    this.to[i] = v;
    if (this.chooseNext(i, -1) && fresh && this.ambient[i]) this.s[i] = this.rand();
  }

  private writeOutputs() {
    const cols = this.cols;
    for (let i = 0; i < this.count; i++) {
      const a = this.from[i];
      const b = this.to[i];
      const s = this.s[i];
      const ax = a % cols;
      const ay = (a - ax) / cols;
      const bx = b % cols;
      const by = (b - bx) / cols;
      this.x[i] = ax + (bx - ax) * s;
      this.y[i] = ay + (by - ay) * s;
      if (this.ambient[i]) {
        this.bright[i] = AMBIENT_BRIGHT;
        this.hue[i] = 0;
        continue;
      }
      if (this.delay[i] > 0) {
        this.bright[i] = 0;
        this.hue[i] = 0;
        continue;
      }
      const en = this.energy[i];
      const fade = this.lost[i] ? Math.max(0, 1 - this.lostT[i] / LOST_LIFE) : 1;
      this.bright[i] = en * fade;
      this.hue[i] =
        this.volt[i] === HIGH ? 1 : -Math.min(1, Math.max(0, (AMBER_FROM - en) / (AMBER_FROM - AMBER_TO)));
    }
  }

  // ---------------------------------------------------------------- utils

  get edgeCount(): number {
    return this.board.E;
  }

  /** Endpoints of edge `e` in lattice coordinates. */
  edgeVertices(e: number) {
    return this.board.edgeVertices(e);
  }

  nodeIndex(id: string): number {
    return this.idIndex.get(id) ?? -1;
  }

  /** Node index at a vertex, or −1. */
  nodeAtVertex(col: number, row: number): number {
    return this.board.inLattice(col, row) ? (this.nodeAt.get(this.board.vertex(col, row)) ?? -1) : -1;
  }

  private mustIndex(id: string): number {
    const k = this.idIndex.get(id);
    if (k === undefined) throw new Error(`Level references unknown node "${id}"`);
    return k;
  }

  private vertexOfNode(k: number) {
    return this.board.vertex(this.nodes[k].col, this.nodes[k].row);
  }

  private toCR(v: number): Transformer {
    return { col: this.board.col(v), row: this.board.row(v) };
  }
}
