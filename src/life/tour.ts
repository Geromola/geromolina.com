/**
 * The guided tour. Each step loads a scene and highlights one control; everything stays usable,
 * so a step is a suggestion, not a lock.
 */

export type Focus = 'step' | 'play' | 'status' | 'chart' | 'library' | 'signals' | null;

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** A library pattern id or a scene id (see `scenes.ts`). */
  load: string;
  focus: Focus;
  /** Start running when the step opens (never under reduced motion). */
  play: boolean;
  /** Show the next-generation preview. */
  preview?: boolean;
  /** Cells of room round the scene, when it should be framed closer than usual. */
  room?: number;
}

export const TOUR: readonly TourStep[] = [
  {
    id: 'rule',
    title: 'One rule',
    body: 'Every cell looks at its eight neighbours. An empty cell with exactly three comes alive. A live cell with two or three stays. Every other cell dies or stays empty. The ghosts show what happens next: white are births, amber are deaths. Press Step.',
    load: 'r-pentomino',
    focus: 'step',
    play: false,
    preview: true,
    room: 5,
  },
  {
    id: 'stay',
    title: 'Things that stay',
    body: 'Some shapes are in perfect balance and never change: still lifes. Others return to their shape after a few generations: oscillators. The number is the period. A random soup settles into mostly these.',
    load: 'garden',
    focus: 'status',
    play: true,
  },
  {
    id: 'move',
    title: 'Things that move',
    body: 'A glider returns to its shape one cell further along every four generations, so it travels. Nobody designed it: it falls out of the rule. The three spaceships fly at half the speed of light, one cell every two generations, the fastest an orthogonal ship can go.',
    load: 'flotilla',
    focus: 'status',
    play: true,
  },
  {
    id: 'chaos',
    title: 'Chaos from five cells',
    body: 'The R-pentomino is five cells. It churns for 1103 generations before it settles, throwing off six gliders. Watch the population chart: there is no shortcut to the answer except to run it.',
    load: 'r-pentomino',
    focus: 'chart',
    play: true,
  },
  {
    id: 'gun',
    title: 'Machines that make machines',
    body: 'In 1970 Conway bet $50 that no pattern grows forever. Bill Gosper won it with this gun, which fires a glider every 30 generations, a stream that never ends.',
    load: 'gosper-gun',
    focus: 'status',
    play: true,
  },
  {
    id: 'signal',
    title: 'Gliders as messages',
    body: 'A glider is a bit, and a gun is a clock that sends a 1 every 30 generations. Here two guns fire across each other. Where the streams meet, the gliders destroy each other in pairs. A collision is a piece of logic. Open Signals to send a message with it.',
    load: 'two-guns',
    focus: 'signals',
    play: true,
  },
  {
    id: 'computes',
    title: 'Life computes',
    body: 'Guns, eaters and collisions are enough to build wires, logic gates and memory. Life is Turing complete: anything a computer can calculate, a large enough pattern can too. People have built a Turing machine in it, and even Life running inside Life.',
    load: 'message',
    focus: 'signals',
    play: true,
  },
];

export const TOUR_KEY = 'life-progress';

export interface Progress {
  step: number;
  /** The furthest step opened. */
  seen: number;
}

export function parseProgress(raw: string | null): Progress {
  const empty = { step: 0, seen: 0 };
  if (!raw) return empty;
  try {
    const p = JSON.parse(raw) as Partial<Progress>;
    const clamp = (n: unknown) => (Number.isInteger(n) ? Math.min(TOUR.length - 1, Math.max(0, n as number)) : 0);
    return { step: clamp(p.step), seen: Math.max(clamp(p.seen), clamp(p.step)) };
  } catch {
    return empty;
  }
}

export function serializeProgress(p: Progress): string {
  return JSON.stringify({ step: p.step, seen: p.seen });
}
