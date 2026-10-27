/**
 * The guided steps. Each one springs the shell to `target` and highlights one control; every
 * control stays usable, so a step is a suggestion, not a lock.
 */
import type { ParamKey, ShellParams } from './model';

export interface Lesson {
  id: string;
  title: string;
  body: string;
  /** Where the shell springs to when the step opens. */
  target: ShellParams;
  /** The control this step is about. */
  focus: ParamKey | null;
  /** Replay the growth from the tip. */
  regrow?: boolean;
  /** Show the paired, mirrored valve. */
  pairValves?: boolean;
  /** Show where real shells live on the map. */
  revealCube?: boolean;
}

export const LESSONS: readonly Lesson[] = [
  {
    id: 'tube',
    title: 'One tube',
    body:
      'A shell is a single tube that grows as it turns. The amber ring is the opening, sweeping around an axis and getting bigger at a steady rate. Every whorl is a scaled copy of the one before: a logarithmic spiral. This one is a nautilus.',
    target: { W: 3, D: 0, T: 0 },
    focus: null,
    regrow: true,
  },
  {
    id: 'W',
    title: 'W, how fast it widens',
    body:
      'W is how much the tube grows in one turn. Near 1 it barely grows and coils many times, tightly. At 10 it flares open in a turn or two. A nautilus sits at about 3. Drag W.',
    target: { W: 1.6, D: 0, T: 0 },
    focus: 'W',
  },
  {
    id: 'D',
    title: 'D, how far from the axis',
    body:
      'D is how far the tube sits from the axis it coils around: the inner edge’s distance divided by the outer edge’s. At 0 the whorls hug the axis. Raise D and a hole opens in the middle. Once W × D passes 1, the whorls stop touching and the coil comes loose. Raup found ammonites crowding close to that line.',
    target: { W: 2, D: 0.3, T: 0 },
    focus: 'D',
  },
  {
    id: 'T',
    title: 'T, how far it slides',
    body:
      'T is how far the tube slides down the axis as it turns. At 0 the coil stays flat, like a nautilus. Raise it and the coil climbs into a spire: a garden snail near 1, a tall Turritella near 4. Drag T.',
    target: { W: 2.2, D: 0.1, T: 1.2 },
    focus: 'T',
  },
  {
    id: 'clam',
    title: 'Push W into the hundreds',
    body:
      'Now each turn makes the tube 300 times bigger, so almost the whole shell is the last half-turn: a cap. That cap is one valve of a clam. Two of them, mirrored, make a bivalve. Same rule, a different number. Push W to 100,000 with D at 0 and you get a brachiopod.',
    target: { W: 300, D: 0.1, T: 0.25 },
    focus: 'W',
    pairValves: true,
  },
  {
    id: 'cube',
    title: 'The cube',
    body:
      'Put W, D and T on three axes and every coiled shell is a point in one cube. Raup plotted real shells and found them packed into a few small regions. Most of the cube is empty. Are those shells impossible to build, or did evolution never get there? Drag across the map below and find out what lives in the gaps.',
    target: { W: 3, D: 0, T: 0 },
    focus: null,
    revealCube: true,
  },
];

export const STEP_KEY = 'shells-progress';

export interface Progress {
  /** Last lesson opened, 0-based. */
  step: number;
  /** The cube's regions have been revealed. */
  cubeSeen: boolean;
}

export function parseProgress(raw: string | null): Progress {
  try {
    const v = JSON.parse(raw ?? 'null');
    const step = Number.isInteger(v?.step) ? Math.min(LESSONS.length - 1, Math.max(0, v.step)) : 0;
    return { step, cubeSeen: v?.cubeSeen === true };
  } catch {
    return { step: 0, cubeSeen: false };
  }
}

export const serializeProgress = (p: Progress) => JSON.stringify(p);
