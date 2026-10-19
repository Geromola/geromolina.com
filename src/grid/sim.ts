import { Spring } from './spring';

/**
 * Pure grid simulation — no DOM. Everything is in lattice units: vertices sit
 * at integer (col, row), every conductor segment has length 1.
 *
 * Physics, stylised but true:
 *  - Drift speed follows current (I); brightness follows voltage (energy per
 *    charge). A step-up multiplies V and divides I, so electrons get brighter
 *    and slower while P = V·I stays put.
 *  - In AC the net drift is zero: electrons jiggle in place (amplitude ∝ I)
 *    and the *energy* travels outward from the plants as a wave.
 *  - In DC the cursor is a solid-state transformer (power electronics) —
 *    a classic iron-core one can't step DC.
 */

export type NodeKind = 'plant' | 'substation' | 'section';

export interface SimNode {
  kind: NodeKind;
  col: number;
  row: number;
}

export type StepMode = 'up' | 'down';

// Real-world numbers shown on the meter.
export const PLANT_VOLTAGE = 13_800; // V, a typical generator terminal voltage
export const PLANT_POWER = 50e6; // W
export const RATIO: Record<StepMode, number> = { up: 25, down: 1 / 28.75 }; // 13.8 kV → 345 kV, or → 480 V
// How hard the real ratio is felt visually (k_vis = ratio^VISUAL_EXP), so ×25 doesn't freeze the screen.
const VISUAL_EXP = 0.3;

export function meterReading(mode: StepMode, strength: number) {
  const voltage = PLANT_VOLTAGE * Math.pow(RATIO[mode], strength);
  const current = PLANT_POWER / voltage;
  return { voltage, current, power: voltage * current };
}

export interface SimOptions {
  cols: number;
  rows: number;
  nodes: SimNode[];
  count: number;
  ambientFraction?: number;
  fieldRadius?: number; // lattice units
  seed?: number;
}

const AC_HZ = 1.5; // visual stand-in for 60 Hz
const WAVE_HZ = 0.7;
const WAVE_LENGTH = 3.5; // lattice units
const BASE_AMP = 0.16; // lattice units of jiggle at k = 1

export class GridSim {
  readonly cols: number;
  readonly rows: number;
  readonly nodes: SimNode[];
  readonly count: number;
  fieldRadius: number;

  // Per-electron state (structure of arrays).
  readonly ac: Int16Array; // from vertex
  readonly ar: Int16Array;
  readonly bc: Int16Array; // to vertex
  readonly br: Int16Array;
  readonly s: Float32Array; // progress along edge, 0..1
  readonly speed: Float32Array; // base lattice units / s
  readonly k: Float32Array; // local step ratio felt by this electron (visual)
  readonly phase: Float32Array;
  readonly target: Int16Array; // node index or -1
  readonly age: Float32Array;
  readonly ambient: Uint8Array;

  // Outputs for renderers.
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly bright: Float32Array;
  readonly hue: Float32Array; // -1 amber (stepped down) · 0 cyan · +1 white-hot (stepped up)
  readonly absorbed: Uint32Array; // per node, cumulative

  pointer: { x: number; y: number } | null = null;
  hover = -1;
  mode: StepMode = 'up';
  isAC = false;

  readonly strength = new Spring(0, 0.35); // transformer field on/off
  readonly drift = new Spring(1, 0.6); // DC drift → 0 in AC
  readonly acMix = new Spring(0, 0.6);

  time = 0;
  private rand: () => number;
  private plants: number[];
  private sinks: number[];
  private nodeAt = new Map<number, number>();
  private plantDist: Float32Array;

  constructor(opts: SimOptions) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.nodes = opts.nodes;
    this.count = opts.count;
    this.fieldRadius = opts.fieldRadius ?? 2.2;
    this.rand = mulberry32(opts.seed ?? 0x9e3779b9);

    const n = opts.count;
    this.ac = new Int16Array(n);
    this.ar = new Int16Array(n);
    this.bc = new Int16Array(n);
    this.br = new Int16Array(n);
    this.s = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.k = new Float32Array(n).fill(1);
    this.phase = new Float32Array(n);
    this.target = new Int16Array(n).fill(-1);
    this.age = new Float32Array(n);
    this.ambient = new Uint8Array(n);
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.bright = new Float32Array(n);
    this.hue = new Float32Array(n);
    this.absorbed = new Uint32Array(opts.nodes.length);

    this.nodes.forEach((node, i) => this.nodeAt.set(this.key(node.col, node.row), i));
    this.plants = this.nodes.flatMap((node, i) => (node.kind === 'plant' ? [i] : []));
    this.sinks = this.nodes.flatMap((node, i) => (node.kind !== 'plant' ? [i] : []));

    this.plantDist = new Float32Array(this.cols * this.rows);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        let d = Infinity;
        for (const p of this.plants) d = Math.min(d, Math.abs(c - this.nodes[p].col) + Math.abs(r - this.nodes[p].row));
        this.plantDist[this.key(c, r)] = Number.isFinite(d) ? d : 0;
      }
    }

    const ambientCount = Math.round(n * (opts.ambientFraction ?? 0.45));
    for (let i = 0; i < n; i++) {
      this.ambient[i] = i < ambientCount ? 1 : 0;
      this.phase[i] = this.rand() * Math.PI * 2;
      this.spawn(i, true);
    }
    this.writeOutputs();
  }

  /** Visual ratio the field pushes electrons toward at full strength. */
  get fieldK(): number {
    return Math.pow(RATIO[this.mode], VISUAL_EXP);
  }

  get reading() {
    return meterReading(this.mode, this.strength.value);
  }

  setAC(on: boolean) {
    this.isAC = on;
    this.drift.target = on ? 0 : 1;
    this.acMix.target = on ? 1 : 0;
  }

  step(dt: number) {
    dt = Math.min(dt, 1 / 20);
    this.time += dt;
    this.strength.target = this.pointer ? 1 : 0;
    const strength = this.strength.step(dt);
    const drift = this.drift.step(dt);
    this.acMix.step(dt);

    const logK = Math.log(this.fieldK);
    const R = this.fieldRadius;
    const px = this.pointer?.x ?? 0;
    const py = this.pointer?.y ?? 0;
    const hasField = this.pointer !== null || strength > 0.01;

    for (let i = 0; i < this.count; i++) {
      // Local step ratio: geometric blend toward the field's k, relaxing back outside.
      let kTarget = 1;
      let tau = 1.2;
      if (hasField) {
        const dx = this.x[i] - px;
        const dy = this.y[i] - py;
        const d2 = (dx * dx + dy * dy) / (R * R);
        if (d2 < 1) {
          kTarget = Math.exp(logK * strength * (1 - d2));
          tau = 0.18;
        }
      }
      this.k[i] += (kTarget - this.k[i]) * (1 - Math.exp(-dt / tau));

      // Drift ∝ current ∝ 1/k.
      const v = (this.speed[i] * drift) / this.k[i];
      this.s[i] += v * dt;
      if (drift > 0.1) this.age[i] += dt;

      let guard = 0;
      while (this.s[i] >= 1 && guard++ < 4) {
        this.s[i] -= 1;
        this.arrive(i);
      }
      if (this.age[i] > 24) this.spawn(i, false);
    }
    this.writeOutputs();
  }

  /** Mean displacement helper for tests/debug. */
  positionOf(i: number) {
    return { x: this.x[i], y: this.y[i] };
  }

  private writeOutputs() {
    const t = this.time;
    const acMix = this.acMix.value;
    const amp = BASE_AMP * acMix;
    const logFieldK = Math.abs(Math.log(this.fieldK)) || 1;
    for (let i = 0; i < this.count; i++) {
      const k = this.k[i];
      // AC jiggle along the conductor, amplitude ∝ I ∝ 1/k.
      const osc = (amp / k) * Math.sin(2 * Math.PI * AC_HZ * t + this.phase[i]);
      const s = Math.min(1, Math.max(0, this.s[i] + osc));
      const ax = this.ac[i];
      const ay = this.ar[i];
      this.x[i] = ax + (this.bc[i] - ax) * s;
      this.y[i] = ay + (this.br[i] - ay) * s;

      const base = this.ambient[i] ? 0.24 + 0.3 * acMix : 1; // in AC the whole mesh carries the wave
      let b = base * Math.pow(k, 0.85);
      if (acMix > 0.001) {
        const d = this.lerpPlantDist(i, s);
        const wave = 0.5 + 0.5 * Math.sin(2 * Math.PI * (WAVE_HZ * t - d / WAVE_LENGTH));
        b *= 1 - acMix + acMix * (0.3 + 2.4 * wave * wave * wave); // sharp energy fronts
      }
      this.bright[i] = Math.min(b, 2.2);
      this.hue[i] = Math.max(-1, Math.min(1, Math.log(k) / logFieldK));
    }
  }

  private lerpPlantDist(i: number, s: number) {
    const da = this.plantDist[this.key(this.ac[i], this.ar[i])];
    const db = this.plantDist[this.key(this.bc[i], this.br[i])];
    return da + (db - da) * s;
  }

  private key(c: number, r: number) {
    return r * this.cols + c;
  }

  private effectiveTarget(i: number) {
    return this.hover >= 0 ? this.hover : this.target[i];
  }

  private spawn(i: number, initial: boolean) {
    this.age[i] = initial ? this.rand() * 20 : 0;
    this.k[i] = 1;
    this.speed[i] = 1.1 + this.rand() * 0.9;
    let c: number;
    let r: number;
    if (this.ambient[i] || this.plants.length === 0) {
      c = Math.floor(this.rand() * this.cols);
      r = Math.floor(this.rand() * this.rows);
      this.target[i] = -1;
    } else {
      const p = this.nodes[this.plants[Math.floor(this.rand() * this.plants.length)]];
      c = p.col;
      r = p.row;
      const pool = this.sinks.length ? this.sinks : this.plants;
      this.target[i] = pool[Math.floor(this.rand() * pool.length)];
    }
    this.ac[i] = c;
    this.ar[i] = r;
    this.bc[i] = c;
    this.br[i] = r;
    this.chooseNext(i, -1, -1);
    this.s[i] = initial ? this.rand() : 0;
  }

  private arrive(i: number) {
    const prevC = this.ac[i];
    const prevR = this.ar[i];
    const c = this.bc[i];
    const r = this.br[i];
    this.ac[i] = c;
    this.ar[i] = r;

    const t = this.effectiveTarget(i);
    if (t >= 0 && this.nodes[t].col === c && this.nodes[t].row === r) {
      this.absorbed[t]++;
      this.spawn(i, false);
      return;
    }
    this.chooseNext(i, prevC, prevR);
  }

  private chooseNext(i: number, prevC: number, prevR: number) {
    const c = this.ac[i];
    const r = this.ar[i];
    const t = this.effectiveTarget(i);
    const tn = t >= 0 ? this.nodes[t] : null;
    const here = tn ? Math.abs(c - tn.col) + Math.abs(r - tn.row) : 0;
    const bias = this.hover >= 0 ? 9 : 5;

    let total = 0;
    const opts: [number, number, number][] = [];
    for (const [dc, dr] of DIRS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue;
      let w = 1;
      if (nc === prevC && nr === prevR) w = 0.05;
      else if (tn) {
        const there = Math.abs(nc - tn.col) + Math.abs(nr - tn.row);
        w = there < here ? bias : 0.6;
      }
      total += w;
      opts.push([nc, nr, w]);
    }
    let pick = this.rand() * total;
    for (const [nc, nr, w] of opts) {
      pick -= w;
      if (pick <= 0) {
        this.bc[i] = nc;
        this.br[i] = nr;
        return;
      }
    }
    const last = opts[opts.length - 1];
    this.bc[i] = last[0];
    this.br[i] = last[1];
  }

  nodeIndexAt(col: number, row: number) {
    return this.nodeAt.get(this.key(col, row)) ?? -1;
  }
}

const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
