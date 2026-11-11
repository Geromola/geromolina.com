/**
 * The Jones (2010) agent model of Physarum, SPEC "Physarum": the live, organic picture. DOM-free.
 * This CPU version is the Canvas fallback and the reference for the WebGL2 one in render-gl.ts.
 *
 * Each agent has a heading and three sensors (front-left, front, front-right) at `sensorOffset`
 * cells ahead and `sensorAngle` apart. Each step it turns toward the strongest trail
 * (randomly when the front is the weakest), moves `stepSize`, and deposits trail. The trail then
 * diffuses (3 × 3 mean) and decays. Light reads as strongly negative to the sensors and blocks
 * moves, so agents stay in the dark.
 *
 * The agents are drawn to an attractant field (`attract`, added each step): food sources, and
 * the tubes of the flow model, weighted by conductivity. They lay trail only where there is
 * attractant (fully at `DEPOSIT_SHARE` of a full tube or more), so stray streams can't sustain
 * themselves off the network. The picture follows the measured network: while the mesh is fine
 * the agents fill the board, and as tubes die they gather on the ones that remain.
 */
import { mulberry32, type Rng } from '../energy/rounds';
import { isLit, type Scene } from './scene';

export interface AgentParams {
  /** Radians between the front sensor and each side sensor. */
  sensorAngle: number;
  /** Sensor distance, in cells. */
  sensorOffset: number;
  /** Radians turned per step. */
  turn: number;
  /** Cells moved per step. */
  stepSize: number;
  /** Trail an agent lays per step. */
  deposit: number;
  /** Share of the trail lost per step. */
  decay: number;
  /** Attractant a food emits per step (at its centre). */
  food: number;
  /** Food radius, in cells. */
  foodRadius: number;
  /** Attractant per step along a tube carrying the full flux. */
  tubes: number;
}

const deg = Math.PI / 180;

export const PRESETS = {
  /** Fine, branching veins. */
  tendrils: { sensorAngle: 30 * deg, sensorOffset: 6, turn: 30 * deg, stepSize: 1, deposit: 0.12, decay: 0.12, food: 8, foodRadius: 4, tubes: 2.5 },
  /** Fat, merging channels. */
  blob: { sensorAngle: 45 * deg, sensorOffset: 14, turn: 45 * deg, stepSize: 1, deposit: 0.3, decay: 0.07, food: 8, foodRadius: 5, tubes: 3 },
} satisfies Record<string, AgentParams>;

export type PresetId = keyof typeof PRESETS;

/** Agents deposit fully where the attractant is at least this share of `tubes`. */
export const DEPOSIT_SHARE = 0.3;

/** Value a sensor reads over light: far below any trail, so agents turn away. */
export const LIGHT_READ = -1000;

/** Lit cells of a gw × gh grid laid over the scene. */
export function lightGrid(scene: Scene, gw: number, gh: number): Uint8Array {
  const lit = new Uint8Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      lit[j * gw + i] = isLit(scene, ((i + 0.5) / gw) * scene.width, ((j + 0.5) / gh) * scene.height) ? 1 : 0;
    }
  }
  return lit;
}

export interface Tubes {
  vx: ArrayLike<number>;
  vy: ArrayLike<number>;
  ea: ArrayLike<number>;
  eb: ArrayLike<number>;
  /** Weight per edge in [0, 1] (0 skips it). */
  weight: ArrayLike<number>;
}

/**
 * The attractant field on a gw × gh grid: a soft disc per food (strength `food`) and every tube
 * drawn at `tubes × weight` (the max where they overlap, so dense mesh does not pile up).
 */
export function attractField(scene: Scene, gw: number, gh: number, params: AgentParams, tubes?: Tubes, out: Float32Array = new Float32Array(gw * gh)): Float32Array {
  out.fill(0);
  const sx = gw / scene.width;
  const sy = gh / scene.height;
  if (tubes && params.tubes > 0) {
    for (let e = 0; e < tubes.ea.length; e++) {
      const w = tubes.weight[e];
      if (!(w > 0)) continue;
      const v = params.tubes * w;
      const x0 = tubes.vx[tubes.ea[e]] * sx, y0 = tubes.vy[tubes.ea[e]] * sy;
      const x1 = tubes.vx[tubes.eb[e]] * sx, y1 = tubes.vy[tubes.eb[e]] * sy;
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
      for (let k = 0; k <= n; k++) {
        const i = Math.floor(x0 + ((x1 - x0) * k) / n);
        const j = Math.floor(y0 + ((y1 - y0) * k) / n);
        if (i < 0 || j < 0 || i >= gw || j >= gh) continue;
        const c = j * gw + i;
        if (out[c] < v) out[c] = v;
      }
    }
  }
  const r = params.foodRadius;
  for (const f of scene.foods) {
    const cx = f.x * sx, cy = f.y * sy;
    for (let j = Math.max(0, Math.floor(cy - r)); j <= Math.min(gh - 1, Math.ceil(cy + r)); j++) {
      for (let i = Math.max(0, Math.floor(cx - r)); i <= Math.min(gw - 1, Math.ceil(cx + r)); i++) {
        const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cy) / r;
        if (d <= 1) out[j * gw + i] += params.food * (1 - d * d);
      }
    }
  }
  return out;
}

export class AgentSim {
  readonly gw: number;
  readonly gh: number;
  readonly count: number;
  params: AgentParams;
  trail: Float32Array;
  private tmp: Float32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly a: Float32Array;
  lit: Uint8Array;
  attract: Float32Array;
  private readonly rng: Rng;

  constructor(gw: number, gh: number, count: number, params: AgentParams = PRESETS.tendrils, seed = 1) {
    this.gw = gw;
    this.gh = gh;
    this.count = count;
    this.params = params;
    this.trail = new Float32Array(gw * gh);
    this.tmp = new Float32Array(gw * gh);
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.a = new Float32Array(count);
    this.lit = new Uint8Array(gw * gh);
    this.attract = new Float32Array(gw * gh);
    this.rng = mulberry32(seed);
    this.spawn();
  }

  /** Scatters every agent over the dark cells with a random heading, and clears the trail. */
  spawn(): void {
    for (let k = 0; k < this.count; k++) {
      let x = 0, y = 0;
      for (let tries = 0; tries < 20; tries++) {
        x = this.rng() * this.gw;
        y = this.rng() * this.gh;
        if (!this.lit[Math.floor(y) * this.gw + Math.floor(x)]) break;
      }
      this.x[k] = x;
      this.y[k] = y;
      this.a[k] = this.rng() * Math.PI * 2;
    }
    this.trail.fill(0);
  }

  private read(x: number, y: number): number {
    const i = Math.floor(x), j = Math.floor(y);
    if (i < 0 || j < 0 || i >= this.gw || j >= this.gh) return LIGHT_READ;
    const c = j * this.gw + i;
    return this.lit[c] ? LIGHT_READ : this.trail[c];
  }

  step(): void {
    const { sensorAngle: sa, sensorOffset: so, turn, stepSize, deposit, decay } = this.params;
    const full = DEPOSIT_SHARE * this.params.tubes || 1;
    const { gw, gh, trail, x, y, a, lit } = this;
    for (let k = 0; k < this.count; k++) {
      let h = a[k];
      const px = x[k], py = y[k];
      const f = this.read(px + Math.cos(h) * so, py + Math.sin(h) * so);
      const l = this.read(px + Math.cos(h - sa) * so, py + Math.sin(h - sa) * so);
      const r = this.read(px + Math.cos(h + sa) * so, py + Math.sin(h + sa) * so);
      if (f > l && f > r) {
        // Straight on.
      } else if (f < l && f < r) h += (this.rng() < 0.5 ? -1 : 1) * turn;
      else if (l > r) h -= turn;
      else if (r > l) h += turn;
      const nx = px + Math.cos(h) * stepSize;
      const ny = py + Math.sin(h) * stepSize;
      const i = Math.floor(nx), j = Math.floor(ny);
      if (i < 0 || j < 0 || i >= gw || j >= gh || lit[j * gw + i]) {
        a[k] = this.rng() * Math.PI * 2;
        continue;
      }
      x[k] = nx;
      y[k] = ny;
      a[k] = h;
      const c = j * gw + i;
      trail[c] += deposit * Math.min(1, this.attract[c] / full);
    }
    // Attract, diffuse (3 × 3 mean, clamped at the edges), decay, and nothing under light.
    const tmp = this.tmp;
    const keep = 1 - decay;
    for (let j = 0; j < gh; j++) {
      const j0 = j > 0 ? j - 1 : j, j1 = j < gh - 1 ? j + 1 : j;
      for (let i = 0; i < gw; i++) {
        const c = j * gw + i;
        if (lit[c]) {
          tmp[c] = 0;
          continue;
        }
        const i0 = i > 0 ? i - 1 : i, i1 = i < gw - 1 ? i + 1 : i;
        let s = 0;
        for (const jj of [j0, j, j1]) {
          const row = jj * gw;
          s += trail[row + i0] + trail[row + i] + trail[row + i1];
        }
        tmp[c] = (s / 9) * keep + this.attract[c];
      }
    }
    this.tmp = trail;
    this.trail = tmp;
  }

  /** Total trail on the board. */
  mass(): number {
    let s = 0;
    for (let c = 0; c < this.trail.length; c++) s += this.trail[c];
    return s;
  }
}
