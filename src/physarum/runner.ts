/**
 * Drives the flow model for the page (SPEC "Physarum"), DOM-free: the Web Worker in
 * flow.worker.ts wraps it, and the page runs one on the main thread when workers are missing.
 * Messages in change the scene or the parameters; `tick` steps within a time budget; `state`
 * is a snapshot for the renderer and the readout (conductivities, the extracted network and
 * its metrics, and whether the network has settled).
 *
 * Every fresh board first grows (growth.ts): strands spread from the foods over a few seconds
 * of wall time, with the flow model held. Once the growth is complete (and at least two foods
 * are down) the flow model starts from the grown strands. `takeGrowth` hands over each new
 * growth for drawing.
 */
import { FlowNet, NETWORK_SHARE, type FlowParams } from './flow';
import { grow, startConductivity, type Growth } from './growth';
import { metrics, type Metrics, type Network } from './metrics';
import type { Food, LightMask, Scene } from './scene';

export type ToRunner =
  /** `gen` comes back on every state, so the page can drop states from an older board. */
  | { type: 'init'; scene: Scene; params?: Partial<FlowParams>; gen?: number }
  | { type: 'foods'; foods: Food[] }
  | { type: 'light'; light: LightMask }
  | { type: 'cut'; x0: number; y0: number; x1: number; y1: number }
  | { type: 'params'; i0?: number; gamma?: number }
  | { type: 'reset' }
  /**
   * Model steps per second (Infinity runs as fast as the budget allows), and the wall-clock
   * seconds a whole growth takes.
   */
  | { type: 'run'; running: boolean; rate: number; grow?: number }
  /** Runs `steps` at once, then posts one state. */
  | { type: 'converge'; steps: number };

export interface MeshMsg {
  type: 'mesh';
  vx: Float32Array;
  vy: Float32Array;
  ea: Int32Array;
  eb: Int32Array;
}

/**
 * Where the growth is, in the page's words: the whole fine mesh still counts as network
 * (`spread`), busy tubes have taken over and the rest are fading (`thin`), or it has stopped
 * changing (`settled`).
 */
export type Stage = 'spread' | 'thin' | 'settled';

export interface StateMsg {
  type: 'state';
  /** The `gen` of the init this state follows. */
  gen: number;
  steps: number;
  time: number;
  /** Conductivity per edge (0 for dead tubes). */
  D: Float32Array;
  /** 1 for each tube in the measured network. */
  inNet: Uint8Array;
  /** f(I₀): the conductivity of a tube that carries the whole flux every step. */
  full: number;
  net: Network;
  metrics: Metrics;
  settled: boolean;
  stage: Stage;
  /** While the board is growing: how far (`tau`, in cost units) out of `end`. Null after. */
  grow: { tau: number; end: number; rate: number } | null;
}

export interface GrowthMsg {
  type: 'growth';
  gen: number;
  growth: Growth;
}

export type FromRunner = MeshMsg | StateMsg | GrowthMsg;

/**
 * Settled: TL moved less than this share over the last SETTLE_WINDOW model-time units, and the
 * network has thinned below MESH_SHARE of the live mesh (fresh, every tube still counts and TL
 * holds still before anything has been decided).
 */
const MESH_SHARE = 0.5;
const SETTLE_SHARE = 0.01;
const SETTLE_WINDOW = 6;
/** Once settled the model keeps living, slowly, so a settled board costs little. */
const SETTLED_RATE = 40;
/** Wall-clock seconds a growth takes, unless `run` says otherwise. */
const GROW_SECONDS = 8;

export class FlowRunner {
  net: FlowNet | null = null;
  private scene: Scene | null = null;
  running = false;
  rate = 240;
  private owed = 0;
  /** TL samples, one per model-time unit. */
  private tlHistory: number[] = [];
  private lastSample = -1;
  private lastMetrics: Metrics | null = null;
  private settled = false;
  private gen = 0;
  private growth: Growth | null = null;
  /** How far the growth has got, in cost units; the flow model is held until it reaches the end. */
  private tau = 0;
  private growing = false;
  private growSeconds = GROW_SECONDS;
  private newGrowth = false;

  /** Applies a message; returns a mesh message when the mesh was (re)built. */
  handle(msg: ToRunner): MeshMsg | null {
    switch (msg.type) {
      case 'init': {
        this.scene = msg.scene;
        this.net = new FlowNet(msg.scene, msg.params);
        this.gen = msg.gen ?? 0;
        this.forget();
        this.startGrowth(0);
        const n = this.net;
        return { type: 'mesh', vx: Float32Array.from(n.vx), vy: Float32Array.from(n.vy), ea: Int32Array.from(n.ea), eb: Int32Array.from(n.eb) };
      }
      case 'foods':
        if (this.scene && this.net) {
          this.scene.foods = msg.foods;
          this.net.setFoods(msg.foods);
          this.forget();
          if (this.growing) this.startGrowth(this.tau);
        }
        return null;
      case 'light':
        if (this.scene && this.net) {
          this.scene.light = msg.light;
          this.net.setLight(this.scene);
          this.forget();
          if (this.growing) this.startGrowth(this.tau);
        }
        return null;
      case 'cut':
        if (this.net?.cut(msg.x0, msg.y0, msg.x1, msg.y1)) {
          this.forget();
          if (this.growing) this.startGrowth(this.tau);
        }
        return null;
      case 'params':
        if (this.net) {
          if (msg.i0 !== undefined) this.net.params.i0 = msg.i0;
          if (msg.gamma !== undefined) this.net.params.gamma = msg.gamma;
          this.forget();
        }
        return null;
      case 'reset':
        this.net?.reset();
        this.forget();
        this.startGrowth(0);
        return null;
      case 'run':
        this.running = msg.running;
        this.rate = msg.rate;
        if (msg.grow !== undefined) this.growSeconds = msg.grow;
        this.owed = 0;
        return null;
      case 'converge':
        if (this.growing && this.canGrow()) this.finishGrowth();
        if (!this.growing) this.net?.step(msg.steps);
        return null;
    }
  }

  /** The growth since the last call, if a new one started (for drawing). */
  takeGrowth(): GrowthMsg | null {
    if (!this.newGrowth || !this.growth) return null;
    this.newGrowth = false;
    return { type: 'growth', gen: this.gen, growth: this.growth };
  }

  /** Grows strands from the foods, already `tau` along (a change mid-growth keeps its place). */
  private startGrowth(tau: number): void {
    const n = this.net;
    if (!n) return;
    const one = this.scene?.origin;
    const origins = one !== undefined && one < n.foodCount ? [n.foodVertex(one)] : Array.from({ length: n.foodCount }, (_, k) => n.foodVertex(k));
    this.growth = grow(n, origins, n.nextSeed());
    this.tau = Math.min(tau, this.growth.end);
    this.growing = true;
    this.newGrowth = true;
  }

  /** Growth waits for two foods: there is nothing to connect before. */
  private canGrow(): boolean {
    return (this.net?.foodCount ?? 0) >= 2;
  }

  /** Hands the grown strands to the flow model. */
  private finishGrowth(): void {
    const n = this.net;
    if (!n || !this.growth) return;
    this.tau = this.growth.end;
    const { i0, gamma } = n.params;
    n.seed(startConductivity(this.growth, n, i0 ** gamma / (1 + i0 ** gamma), n.nextSeed()));
    this.growing = false;
    this.forget();
  }

  /** Something changed: the network has to settle again. */
  private forget(): void {
    this.tlHistory = [];
    this.lastSample = -1;
    this.settled = false;
  }

  /** Steps for `elapsed` seconds of wall time at the current rate, within `budgetMs`. */
  tick(elapsed: number, budgetMs: number, now: () => number = () => performance.now()): number {
    if (!this.net || !this.running) return 0;
    if (this.growing) {
      if (!this.canGrow() || !this.growth) return 0;
      const before = this.tau;
      const speed = this.growSeconds > 0 ? this.growth.end / this.growSeconds : Infinity;
      this.tau = Math.min(this.growth.end, this.tau + elapsed * speed);
      if (this.tau >= this.growth.end) this.finishGrowth();
      return this.tau > before || !this.growing ? 1 : 0;
    }
    const end = now() + budgetMs;
    let n = 0;
    const rate = this.settled ? Math.min(this.rate, SETTLED_RATE) : this.rate;
    if (rate === Infinity) {
      do {
        this.net.step(1);
        n++;
      } while (now() < end);
      return n;
    }
    this.owed = Math.min(this.owed + elapsed * rate, rate * 0.25);
    while (this.owed >= 1 && now() < end) {
      this.net.step(1);
      this.owed--;
      n++;
    }
    return n;
  }

  state(): StateMsg | null {
    const n = this.net;
    if (!n) return null;
    if (this.growing && this.growth) {
      // Nothing to measure yet: the strands are still reaching out.
      const empty = { nodes: [], links: [] };
      const speed = this.growSeconds > 0 ? this.growth.end / this.growSeconds : Infinity;
      return {
        type: 'state',
        gen: this.gen,
        steps: n.steps,
        time: n.time,
        D: new Float32Array(n.edgeCount),
        inNet: new Uint8Array(n.edgeCount),
        full: n.params.i0 ** n.params.gamma / (1 + n.params.i0 ** n.params.gamma),
        net: empty,
        metrics: { tl: 0, md: Infinity, ft: 0, connected: false },
        settled: false,
        stage: 'spread',
        grow: { tau: this.tau, end: this.growth.end, rate: this.running && this.canGrow() ? speed : 0 },
      };
    }
    const D = new Float32Array(n.edgeCount);
    for (let e = 0; e < n.edgeCount; e++) D[e] = n.alive[e] ? n.D[e] : 0;
    const net = n.extractNetwork();
    const m = metrics(net);
    this.lastMetrics = m;
    const unit = Math.floor(n.time);
    if (unit !== this.lastSample) {
      this.lastSample = unit;
      this.tlHistory.push(m.tl);
      if (this.tlHistory.length > SETTLE_WINDOW + 1) this.tlHistory.shift();
    }
    const h = this.tlHistory;
    let mesh = 0;
    for (let e = 0; e < n.edgeCount; e++) if (n.alive[e]) mesh += n.len[e];
    const thinned = m.tl < MESH_SHARE * mesh;
    const settled = m.connected && thinned && h.length > SETTLE_WINDOW && Math.abs(h[h.length - 1] - h[0]) <= SETTLE_SHARE * h[0];
    this.settled = settled;
    const stage: Stage = settled ? 'settled' : thinned ? 'thin' : 'spread';
    const full = n.params.i0 ** n.params.gamma / (1 + n.params.i0 ** n.params.gamma);
    return { type: 'state', gen: this.gen, steps: n.steps, time: n.time, D, full, net, metrics: m, settled, stage, grow: null, inNet: n.networkTubes.slice() };
  }

  get metrics(): Metrics | null {
    return this.lastMetrics;
  }
}

/** Tubes thinner than this share of f(I₀) are not drawn. */
export const DRAW_SHARE = NETWORK_SHARE;
