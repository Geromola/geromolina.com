/**
 * The guided tour (SPEC "Physarum"): seven steps from two foods to Tokyo and beyond, each with
 * its own board, the tools it allows, and a goal the page checks against the flow model's
 * readings. Progress (where you are, which goals you met) is saved by the page. DOM-free.
 *
 * Boards are laid out landscape (1 × 0.625) and transposed for a portrait board (`layout`), so a
 * maze reads the same either way up.
 */
import type { Tool } from './overlay';
import { layout, type Pt, type Rect, type Scene } from './scene';

export type StepId = 'two' | 'maze' | 'three' | 'knob' | 'terrain' | 'tokyo' | 'beyond';

/** What the page reads off the model for a goal: the settled network, normalized to the MST. */
export interface Reading {
  /** Settled since the last change to the board or I₀. */
  settled: boolean;
  connected: boolean;
  /** Cost and travel against the MST, and fault tolerance in [0, 1]. */
  tl: number;
  md: number;
  ft: number;
  i0: number;
  /** Light painted on this step's board. */
  painted: boolean;
}

export interface Card {
  title: string;
  by: string;
  href: string;
  body: string;
}

/** The three ways the page looks at the mold (SPEC "Physarum", Design language). */
export type Lens = 'nature' | 'math' | 'engineering';

export interface TourStep {
  id: StepId;
  title: string;
  /** Which lens the step looks through. */
  lens: Lens;
  /** Paragraphs, with <b> and <i> markup only. */
  body: string[];
  /** A smaller line under the body. */
  note?: string;
  /** The goal, as shown. */
  goal: string;
  /** Marks a reading earns; the goal is met once every one in `needs` is earned. */
  marks: (r: Reading) => string[];
  needs: string[];
  /** Readings the page shows side by side, the last one that earned each mark. */
  readings?: { mark: string; label: string }[];
  tools: Tool[];
  tool: Tool;
  i0: number;
  /** The tube response's exponent, when not the model's default. */
  gamma?: number;
  /** The model's random seed, when the step needs one that shows its point. */
  seed?: number;
  /** Changing I₀ regrows the mesh, so the new I₀ decides the network from the start. */
  regrowOnI0?: boolean;
  /** The board, or 'kanto' for the Tokyo map, or null to keep the board as it is. */
  board: ((width: number, height: number, maskW: number) => Scene) | 'kanto' | null;
  /** A reference network drawn over the board. */
  compare?: 'mst' | 'rail';
  cards?: Card[];
}

/**
 * A 7 × 4 maze after Nakagaki, Yamada & Tóth (2000), drawn as cells (spaces) and walls (#):
 * food at opposite corners, a short way and a long way round, and dead ends. The board's edge is
 * the outer wall.
 */
const MAZE = [
  '###############',
  '#A  #     #   #',
  '### # ### # # #',
  '#   #   #   # #',
  '# ##### ##### #',
  '#     #     # #',
  '# ### # ### # #',
  '#   #   #    B#',
  '###############',
];
/** Half a wall's thickness. */
const WALL = 0.016;

/** The maze's walls as rectangles, and its two foods, in landscape board units. */
export function maze(): { walls: Rect[]; foods: Pt[] } {
  const rows = (MAZE.length - 1) / 2, cols = (MAZE[0].length - 1) / 2;
  const cw = 1 / cols, ch = 0.625 / rows, t = WALL;
  const walls: Rect[] = [];
  const foods: Pt[] = [];
  for (let j = 1; j < MAZE.length - 1; j++) {
    for (let i = 1; i < MAZE[j].length - 1; i++) {
      const c = MAZE[j][i];
      if (c === 'A' || c === 'B') foods.push([((i - 1) / 2 + 0.5) * cw, ((j - 1) / 2 + 0.5) * ch]);
      if (c !== '#') continue;
      // Odd rows hold the walls between cells side by side, even rows the walls below them.
      if (j % 2 === 1 && i % 2 === 0) walls.push([(i / 2) * cw - t, ((j - 1) / 2) * ch - t, (i / 2) * cw + t, ((j + 1) / 2) * ch + t]);
      if (j % 2 === 0 && i % 2 === 1) walls.push([((i - 1) / 2) * cw - t, (j / 2) * ch - t, ((i + 1) / 2) * cw + t, (j / 2) * ch + t]);
    }
  }
  return { walls, foods };
}

const ring = (n: number, cx: number, cy: number, rx: number, ry: number, turn = -Math.PI / 2): Pt[] =>
  Array.from({ length: n }, (_, k) => [cx + rx * Math.cos(turn + (2 * Math.PI * k) / n), cy + ry * Math.sin(turn + (2 * Math.PI * k) / n)] as const);

/** Nine foods (the sandbox's example board): at low I₀ often a tree, at high a web of loops. */
const KNOB: Pt[] = [[0.12, 0.1875], [0.27, 0.45], [0.4, 0.125], [0.53, 0.325], [0.66, 0.1], [0.71, 0.5], [0.86, 0.2625], [0.18, 0.0375], [0.92, 0.5375]];

const settledMark = (r: Reading) => (r.settled && r.connected ? ['settled'] : []);

export const TOUR: readonly TourStep[] = [
  {
    id: 'two',
    lens: 'nature',
    title: 'One cell, many nuclei',
    body: [
      'The plasmodium spreads over the dish in fine, forking strands. Put two oat flakes down and, once the strands meet, the flow between them picks one route. That tube thickens, the rest thin out and vanish.',
      'Drag a food somewhere new. The old tube fades and a new one grows, close to a straight line. <b>Travel</b> settles near <b>1.00×</b>: no tree of straight links is shorter.',
    ],
    goal: 'Let the tube settle',
    marks: settledMark,
    needs: ['settled'],
    tools: ['food', 'cut'],
    tool: 'food',
    i0: 1,
    board: (w, h, m) => layout(w, h, m, [[0.22, 0.42], [0.78, 0.2]]),
  },
  {
    id: 'maze',
    lens: 'nature',
    title: 'The maze',
    body: [
      'In 2000 Toshiyuki Nakagaki, Hiroyasu Yamada and Ágota Tóth filled a plastic maze with plasmodium and put oat flakes at the entrance and the exit. Within hours the mold pulled out of the dead ends, then out of the longer route, and left one tube along the shortest way.',
      'Here the walls are light, and there is a short way and a long way round. Watch the dead ends empty first. Cut the short way and the flow takes the long one.',
    ],
    goal: 'Let it find the shortest way',
    marks: settledMark,
    needs: ['settled'],
    tools: ['cut'],
    tool: 'cut',
    i0: 1,
    board: (w, h, m) => {
      const { walls, foods } = maze();
      return layout(w, h, m, foods, walls);
    },
  },
  {
    id: 'three',
    lens: 'math',
    title: 'Three foods',
    body: [
      'With three foods the cheapest tree of straight links, the cyan lines, joins them along two sides of the triangle. The mold can do better. It grows a junction in the middle, where three tubes meet at about 120°, and <b>Cost</b> drops below <b>1.00×</b>.',
      'That point is a <b>Steiner point</b>, and finding them is hard for computers once there are many foods. Move a food and the junction may follow it, or the mold may settle for two sides. It works locally, so it finds good networks, not always the best. Start over to try again.',
    ],
    note: 'This step sharpens the tubes’ response to flow (γ = 3 instead of 1.8), which favours junctions.',
    goal: 'Get the cost under the tree',
    marks: (r) => (r.settled && r.connected && r.tl < 0.97 ? ['steiner'] : []),
    needs: ['steiner'],
    tools: ['food', 'cut'],
    tool: 'food',
    i0: 1,
    gamma: 3,
    // Grows a junction (cost ~0.89×); about one seed in four does.
    seed: 13,
    board: (w, h, m) => layout(w, h, m, ring(3, 0.5, 0.35, 0.25, 0.25)),
    compare: 'mst',
  },
  {
    id: 'knob',
    lens: 'engineering',
    title: 'The I₀ knob',
    body: [
      'Tero\'s model has one main knob. <b>I₀</b> is how hard one food pumps to another in each round. Gentle pumping can keep only a few tubes busy, so the mold keeps few loops, sometimes none: a tree, cheap, but one cut can isolate a food. Pump harder and cross-links stay busy too.',
      'Each change of I₀ starts the mold over here. Let it settle at about 0.3, then past 4, and compare: the cost goes up, trips get shorter, and more links can fail without cutting anyone off.',
    ],
    goal: 'Let it settle with I₀ under 1, then over 4',
    marks: (r) => (!r.settled || !r.connected ? [] : r.i0 < 1 ? ['low'] : r.i0 > 4 ? ['high'] : []),
    needs: ['low', 'high'],
    readings: [
      { mark: 'low', label: 'Low I₀' },
      { mark: 'high', label: 'High I₀' },
    ],
    tools: ['cut'],
    tool: 'cut',
    i0: 2,
    regrowOnI0: true,
    board: (w, h, m) => layout(w, h, m, KNOB),
  },
  {
    id: 'terrain',
    lens: 'nature',
    title: 'Light is terrain',
    body: [
      'Physarum shuns light, which dries it out. Tero\'s team lit the dish where the sea and the mountains are, and the mold kept to the land.',
      'Paint light across the tube. It thins where the light falls and the flow goes round. A hill makes it detour, a wall with a gap makes it squeeze through the pass.',
    ],
    goal: 'Paint light across the tube and let it go round',
    marks: (r) => (r.painted && r.settled && r.connected ? ['detour'] : []),
    needs: ['detour'],
    tools: ['light', 'food', 'cut'],
    tool: 'light',
    i0: 1,
    board: (w, h, m) => layout(w, h, m, [[0.14, 0.34], [0.86, 0.3]], [[0.42, 0, 0.58, 0.16]]),
  },
  {
    id: 'tokyo',
    lens: 'engineering',
    title: 'Tokyo',
    body: [
      'Put it together and you have Tero\'s experiment: food on the cities round Tokyo, light on the sea and the mountains. The cyan lines sketch the rail network.',
      'Within about a day the real mold built networks as cheap, as quick and nearly as robust as the railways that engineers took decades to build. The Tokyo tab has the side-by-side numbers.',
    ],
    goal: 'Let Tokyo settle',
    marks: settledMark,
    needs: ['settled'],
    tools: ['cut'],
    tool: 'cut',
    i0: 2,
    board: 'kanto',
    compare: 'rail',
  },
  {
    id: 'beyond',
    lens: 'nature',
    title: 'Beyond the dish',
    body: [
      'The same rules turn up wherever something has to connect points cheaply and robustly. People have used them to read road maps, and the sky.',
    ],
    goal: '',
    marks: () => [],
    needs: [],
    tools: ['cut'],
    tool: 'cut',
    i0: 2,
    board: null,
    cards: [
      {
        title: 'Are motorways rational from slime mould’s point of view?',
        by: 'Adamatzky et al. · International Journal of Parallel, Emergent and Distributed Systems, 2013',
        href: 'https://doi.org/10.1080/17445760.2012.685884',
        body: 'Andrew Adamatzky and colleagues grew Physarum on maps of 14 countries and regions, with oat flakes on the big cities, and compared its tubes with the motorways. It came closest in Belgium, Canada and China.',
      },
      {
        title: 'Revealing the dark threads of the cosmic web',
        by: 'Burchett, Elek, Tejos, Prochaska, Tripp, Bordoloi & Forbes · Astrophysical Journal Letters, 2020',
        href: 'https://doi.org/10.3847/2041-8213/ab700c',
        body: 'Astronomers set Physarum-style agents loose on nearly 38,000 galaxies from the Sloan survey. The filaments they traced lined up with the hydrogen that dims the light of distant quasars: a map of the cosmic web.',
      },
    ],
  },
];

export const stepIndex = (id: string | null | undefined): number => Math.max(0, TOUR.findIndex((s) => s.id === id));

/** The goal's marks earned so far plus this reading's, and whether that meets the goal. */
export function earn(step: TourStep, have: ReadonlySet<string>, r: Reading): { marks: Set<string>; met: boolean } {
  const marks = new Set(have);
  for (const m of step.marks(r)) if (step.needs.includes(m)) marks.add(m);
  return { marks, met: step.needs.every((n) => marks.has(n)) };
}

/** Saved in localStorage as `physarum-progress`. */
export interface Progress {
  /** The step you were on. */
  at: StepId;
  /** Steps whose goal you met. */
  done: StepId[];
}

export const PROGRESS_KEY = 'physarum-progress';

export function parseProgress(text: string | null): Progress {
  const fresh: Progress = { at: TOUR[0].id, done: [] };
  if (!text) return fresh;
  try {
    const raw = JSON.parse(text) as { tour?: { at?: unknown; done?: unknown } };
    const t = raw?.tour;
    const ids = new Set<string>(TOUR.map((s) => s.id));
    const at = typeof t?.at === 'string' && ids.has(t.at) ? (t.at as StepId) : fresh.at;
    const done = Array.isArray(t?.done) ? [...new Set(t.done.filter((d): d is StepId => typeof d === 'string' && ids.has(d)))] : [];
    return { at, done };
  } catch {
    return fresh;
  }
}

/** Writes the tour into the saved progress, keeping anything else stored there. */
export function serializeProgress(p: Progress, previous: string | null = null): string {
  let rest: Record<string, unknown> = {};
  try {
    const raw: unknown = previous ? JSON.parse(previous) : null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) rest = raw as Record<string, unknown>;
  } catch {
    // Unreadable: start over.
  }
  return JSON.stringify({ ...rest, tour: { at: p.at, done: TOUR.filter((s) => p.done.includes(s.id)).map((s) => s.id) } });
}
