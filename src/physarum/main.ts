/**
 * DOM wiring for Physarum (`/physarum`), SPEC "Physarum": the board (agents below, the vector
 * overlay above), the flow model in a Web Worker (or on this thread without one), the tools
 * (food, light, cut, and track and erase for the challenge), the dock, the metrics, the modes
 * (Sandbox, the guided Tour, Tokyo with its comparison, and You vs the mold), the keyboard
 * cursor, the phone bottom sheet and the URL hash. The models live in the DOM-free modules.
 */
import { Spring } from '../grid/spring';
import {
  LEVELS,
  build,
  emptyTrack,
  endAt,
  endPoint,
  erase,
  levelIndex,
  measure,
  parseChallenge,
  record,
  score,
  serializeChallenge,
  trackNetwork,
  builtLength,
  type BuildError,
  type ChallengeProgress,
  type End,
  type Track,
} from './challenge';
import { PRESETS, attractField, lightGrid, type AgentParams, type Tubes } from './agents';
import { kanto, isMajor, labelSide, type KantoMap } from './kanto';
import { metrics, normalize, type Metrics, type Network, type Normalized } from './metrics';
import { tradeoffLayout, type TradeoffPoint } from './figures';
import { Overlay, type CalloutNote, type FoodLabels, type Tool } from './overlay';
import { delaunay, mst, steinerTree } from './reference';
import { CanvasAgentRenderer } from './render-canvas';
import { GLAgentRenderer, type AgentRenderer, type BoardRect, type Palette, type RGB } from './render-gl';
import { FILM_TRUST, filmTubes, flowWeights, growthAt, smoothAlong, type Growth, type GrowthFrame } from './growth';
import { FlowRunner, type FromRunner, type MeshMsg, type Stage, type StateMsg, type ToRunner } from './runner';
import { MAX_FOODS, emptyScene, isLit, paintLight, sceneFromHash, sceneToHash, type Scene } from './scene';
import { PROGRESS_KEY, TOUR, earn, parseProgress, serializeProgress, stepIndex, type Progress, type TourStep } from './tour';

const PHONE = '(max-width: 899px)';
/**
 * For each speed: flow model steps per second, agent steps per frame, and the seconds the
 * strands take to spread over the board.
 */
const SPEEDS = { slow: { rate: 60, agents: 1, grow: 16 }, normal: { rate: 120, agents: 2, grow: 9 }, fast: { rate: Infinity, agents: 3, grow: 4 } };
type Speed = keyof typeof SPEEDS;
type View = 'mold' | 'tubes' | 'both';
type Mode = 'sandbox' | 'tour' | 'tokyo' | 'challenge';
const TOOLS: Tool[] = ['food', 'light', 'cut'];
type Compare = 'none' | 'rail' | 'mst' | 'delaunay';
const TOKYO_I0 = 2;
/** The challenge's mold: I₀ 2, scored once it settles or has run this many steps. */
const RACE_I0 = 2;
const RACE_STEPS = 1500;
/** Seconds the racing mold takes to spread. */
const RACE_GROW = 3;
/** Milliseconds between rebuilds of the agents' attractant while the strands grow. */
const GROW_ATTRACT_MS = 90;
/** Boards narrower than this (CSS px) name only the major cities. */
const ALL_LABELS = 620;
const I0_MIN = 0.2;
const I0_MAX = 8;
const BRUSH = 0.035;
const CONVERGE_STEPS = 1500;
/** The growth stages the readout steps through, in order. */
const STAGES: Stage[] = ['spread', 'thin', 'settled'];
/** Food sources for the opening board, in board shares (x across, y down, landscape). */
const EXAMPLE: [number, number][] = [
  [0.12, 0.3], [0.27, 0.72], [0.4, 0.2], [0.53, 0.52], [0.66, 0.16], [0.71, 0.8], [0.86, 0.42], [0.18, 0.06], [0.92, 0.86],
];

function token(name: string): RGB {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as RGB;
  const [r, g, b] = v.split(',').map((s) => Number.parseFloat(s) / 255);
  return [r || 0, g || 0, b || 0];
}

const i0FromSlider = (v: number) => I0_MIN * (I0_MAX / I0_MIN) ** (v / 100);
const sliderFromI0 = (i0: number) => (100 * Math.log(i0 / I0_MIN)) / Math.log(I0_MAX / I0_MIN);

interface Host {
  send(msg: ToRunner): void;
}

/** The flow model in a worker, or a FlowRunner on this thread when workers are unavailable. */
function startHost(onMessage: (m: FromRunner) => void): Host {
  try {
    const worker = new Worker(new URL('./flow.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FromRunner>) => onMessage(e.data);
    return { send: (msg) => worker.postMessage(msg) };
  } catch {
    const runner = new FlowRunner();
    let last = performance.now();
    let lastPost = 0;
    const loop = () => {
      const now = performance.now();
      const n = runner.tick((now - last) / 1000, 5);
      last = now;
      const grown = runner.takeGrowth();
      if (grown) onMessage(grown);
      if (n && now - lastPost > 66) {
        lastPost = now;
        const s = runner.state();
        if (s) onMessage(s);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return {
      send(msg) {
        const mesh = runner.handle(msg);
        if (mesh) onMessage(mesh);
        const grown = runner.takeGrowth();
        if (grown) onMessage(grown);
        if (msg.type !== 'run') {
          const s = runner.state();
          if (s) onMessage(s);
        }
        last = performance.now();
      },
    };
  }
}

/** The grown part of each strand as its own segment, for the agents' attractant. */
function strandSegments(g: Growth, mesh: MeshMsg, f: GrowthFrame): Tubes {
  const ne = mesh.ea.length;
  const vx = new Float32Array(4 * ne);
  const vy = new Float32Array(4 * ne);
  const ea: number[] = [];
  const eb: number[] = [];
  const weight: number[] = [];
  let k = 0;
  const seg = (x0: number, y0: number, x1: number, y1: number, w: number) => {
    vx[k] = x0;
    vy[k] = y0;
    vx[k + 1] = x1;
    vy[k + 1] = y1;
    ea.push(k);
    eb.push(k + 1);
    weight.push(w);
    k += 2;
  };
  for (let e = 0; e < ne; e++) {
    const a = mesh.ea[e];
    const b = mesh.eb[e];
    const w = 0.35 + 0.65 * f.weight[e];
    if (f.fromA[e] > 0) seg(g.sx[a], g.sy[a], g.sx[a] + (g.sx[b] - g.sx[a]) * f.fromA[e], g.sy[a] + (g.sy[b] - g.sy[a]) * f.fromA[e], w);
    if (f.fromB[e] > 0) seg(g.sx[b], g.sy[b], g.sx[b] + (g.sx[a] - g.sx[b]) * f.fromB[e], g.sy[b] + (g.sy[a] - g.sy[b]) * f.fromB[e], w);
  }
  return { vx, vy, ea, eb, weight };
}

export function mountPhysarum(root: HTMLElement) {
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const $$ = <T extends Element = HTMLElement>(sel: string) => [...root.querySelectorAll<T>(sel)];
  const reduced = () =>
    document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const phone = () => matchMedia(PHONE).matches;
  const contrast = () => matchMedia('(prefers-contrast: more)').matches;

  // ------------------------------------------------------------ the scene
  const fromHash = sceneFromHash(location.hash);
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const startMode = hashParams.get('m');
  const portrait = fromHash ? fromHash.scene.height > fromHash.scene.width : innerHeight > innerWidth * 1.1;
  const blank = () => (portrait ? emptyScene(0.625, 1, 160) : emptyScene(1, 0.625, 256));
  const example = (): Scene => {
    const s = blank();
    s.foods = EXAMPLE.map(([a, b]) => (portrait ? { x: b * s.width, y: a * s.height } : { x: a * s.width, y: b * s.height }));
    return s;
  };
  let scene: Scene = fromHash?.scene ?? example();
  let i0 = fromHash?.i0 ?? 2;
  let mode: Mode = 'sandbox';
  /** The sandbox board, kept while another mode has the board. */
  let saved: { scene: Scene; i0: number; tool: Tool } | null = null;
  let map: KantoMap | null = null;
  let compare: Compare = 'rail';
  let refs: { nets: Record<Exclude<Compare, 'none'>, Network>; scores: Record<Exclude<Compare, 'none'>, Normalized> } | null = null;
  let labels: FoodLabels | null = null;
  /** The reference network the tour step draws, if any. */
  let tourCompare: Network | null = null;
  // The challenge: the level, your track (with undo), and the race against the mold.
  let challenge: ChallengeProgress = parseChallenge(null);
  let levelAt = 0;
  let track: Track = emptyTrack();
  let undoStack: Track[] = [];
  let trackFrom: End | null = null;
  let trackTo: { x: number; y: number } | null = null;
  let mstRef = metrics(mst(scene.foods));
  let you: Normalized | null = null;
  let mold: Normalized | null = null;
  let raced = false;
  let racing = false;
  let speed: Speed = 'normal';
  let view: View = 'both';
  let tool: Tool = 'food';
  let running = !reduced();
  const preset: AgentParams = PRESETS.tendrils;

  // ------------------------------------------------------------ renderers
  const palette: Palette = { mold: token('--phys-plasm'), deep: token('--phys-ochre'), hot: token('--phys-glow'), board: token('--phys-dish') };
  let canvas = $<HTMLCanvasElement>('[data-agents]');
  const forceCanvas = new URLSearchParams(location.search).get('renderer') === 'canvas';
  const small = phone();
  const gw = portrait ? (small ? 300 : 400) : small ? 480 : 640;
  const gh = Math.round((gw * scene.height) / scene.width);
  let made: AgentRenderer | null = forceCanvas ? null : GLAgentRenderer.create(canvas, gw, gh, 512, small ? 192 : 256, palette);
  if (!made) {
    if (!forceCanvas) {
      // A canvas that handed out a WebGL context can't give a 2D one.
      const fresh = canvas.cloneNode() as HTMLCanvasElement;
      canvas.replaceWith(fresh);
      canvas = fresh;
    }
    const cw = portrait ? 200 : 320;
    made = new CanvasAgentRenderer(canvas, cw, Math.round((cw * scene.height) / scene.width), small ? 9000 : 14000, preset, palette);
  }
  const agents = made;
  agents.setParams(preset);
  root.dataset.renderer = agents.kind;
  const overlayCanvas = $<HTMLCanvasElement>('[data-board]');
  const overlay = new Overlay(overlayCanvas, {
    ...palette,
    ink: token('--phys-paper'),
    draft: token('--phys-draft'),
    oat: token('--phys-oat'),
    lamp: token('--phys-lamp'),
  });

  let lit = lightGrid(scene, agents.gw, agents.gh);
  let attract: Float32Array = new Float32Array(agents.gw * agents.gh);
  agents.setLight(lit);
  agents.respawn(lit, 7);
  overlay.lightChanged(scene);

  // ------------------------------------------------------------ elements
  const playBtn = $<HTMLButtonElement>('[data-play]');
  const convergeBtn = $<HTMLButtonElement>('[data-converge]');
  const i0In = $<HTMLInputElement>('[data-i0]');
  const i0Label = $('[data-i0-label]');
  const statusEl = $('[data-status]');
  const stageEls = $$<HTMLElement>('.stages__s');
  const netEl = $('[data-net]');
  const liveEl = $('[data-live]');
  const panel = $('[data-panel]');
  const dock = $('[data-dock]');
  const metricEls = {
    tl: $('[data-m="tl"]'),
    md: $('[data-m="md"]'),
    ft: $('[data-m="ft"]'),
  };
  const compareEls = (id: string) => ({ tl: $(`[data-c="${id}-tl"]`), md: $(`[data-c="${id}-md"]`), ft: $(`[data-c="${id}-ft"]`) });
  const moldRow = compareEls('none');
  // Callouts on the board, and the cost-against-resilience figure (declared early: the
  // main-thread host can report a state before the rest of this function has run).
  type Note = { id: string; text: string; x: Spring; y: Spring };
  let notes: Note[] = [];
  const noteAlpha = new Spring(0, 0.6);
  let notesPicked = -Infinity;
  let notesMoving = false;
  let notesLast = 0;
  const plateEl = $('[data-plate]');
  let plateText = '';
  const tradeoffEls = $$<SVGSVGElement>('[data-tradeoff]');
  let tradeoffKey = '';
  let tradeoffRefs: TradeoffPoint[] = [];
  let tradeoffDrawn = 0;

  // ------------------------------------------------------------ flow model
  let mesh: MeshMsg | null = null;
  let state: StateMsg | null = null;
  let attractDirty = false;
  let converging = false;
  /** Steps at the end of the last Skip ahead: the network there counts as settled. */
  let convergedAt = -1;
  /** Bumped by every init; states from an older board are dropped. */
  let gen = 0;
  // The growth: strands spreading from the foods, drawn at `tau` (run on locally between states).
  let growth: Growth | null = null;
  let film: Uint8Array | null = null;
  let growFrame: GrowthFrame | null = null;
  let growClock = { tau: 0, end: 0, rate: 0, at: 0 };
  let growAttractAt = 0;
  // Once the flow runs: each tube's drawn thickness and the smoothed drawing positions.
  let tubeW: Float32Array | null = null;
  let tubeX: Float32Array | null = null;
  let tubeY: Float32Array | null = null;
  function tubesFromState() {
    if (!mesh || !state || state.grow || state.D.length !== mesh.ea.length) {
      tubeW = tubeX = tubeY = null;
      return;
    }
    tubeW = flowWeights(state.D, state.full, film, state.inNet, state.time >= FILM_TRUST, tubeW?.length === state.D.length ? tubeW : undefined);
    const pinned = new Uint8Array(mesh.vx.length);
    if (growth) for (let v = 0; v < pinned.length; v++) if (growth.reach[v] === 0) pinned[v] = 1;
    const p = smoothAlong(growth?.sx ?? mesh.vx, growth?.sy ?? mesh.vy, mesh, tubeW, pinned);
    tubeX = p.x;
    tubeY = p.y;
  }
  const growing = () => !!state?.grow && !!growth;
  const tauNow = () => Math.min(growClock.end, growClock.tau + (growClock.rate * (performance.now() - growClock.at)) / 1000);
  const host = startHost((m) => {
    if (m.type === 'mesh') {
      mesh = m;
      return;
    }
    if (m.gen !== gen) return;
    if (m.type === 'growth') {
      growth = m.growth;
      film = mesh ? filmTubes(growth, mesh.ea.length) : null;
      attractDirty = true;
      schedule();
      return;
    }
    state = m;
    if (m.grow) growClock = { ...m.grow, at: performance.now() };
    tubesFromState();
    if (racing && (m.settled || m.steps >= RACE_STEPS)) finishRace(m);
    attractDirty = true;
    if (converging) {
      converging = false;
      convergedAt = m.steps;
      agentBurst = 240;
      convergeBtn.disabled = false;
    }
    drawReadout();
    schedule();
  });
  const sendRun = () =>
    // An agent burst only animates the picture; the flow model stays where Skip ahead left it.
    host.send({ type: 'run', running: running || racing, rate: racing ? Infinity : SPEEDS[speed].rate, grow: racing ? RACE_GROW : SPEEDS[speed].grow });
  host.send({ type: 'init', scene: cloneScene(scene), params: { i0 }, gen });
  showGrownIfStill();

  /** With reduced motion nothing plays on its own, so a fresh board shows its grown strands at once. */
  function showGrownIfStill() {
    if (reduced() && !running) host.send({ type: 'converge', steps: 0 });
  }

  function cloneScene(s: Scene): Scene {
    return { width: s.width, height: s.height, foods: s.foods.map((f) => ({ ...f })), light: { w: s.light.w, h: s.light.h, data: s.light.data.slice() }, origin: s.origin };
  }

  function rebuildAttract() {
    attractDirty = false;
    let tubes: Tubes | undefined;
    if (mesh && growing() && growFrame && growth) {
      tubes = strandSegments(growth, mesh, growFrame);
    } else if (mesh && tubeW && tubeX && tubeY) {
      tubes = { vx: tubeX, vy: tubeY, ea: mesh.ea, eb: mesh.eb, weight: tubeW.map((w) => w * w) };
    }
    attract = attractField(scene, agents.gw, agents.gh, preset, tubes, attract);
    agents.setAttract(attract);
  }

  // ------------------------------------------------------------ readout
  let lastStatus = '';
  function drawReadout() {
    const m: Metrics | null = state?.metrics ?? null;
    const enough = scene.foods.length >= 2;
    const ref = enough ? metrics(mst(scene.foods)) : null;
    const n = m && ref ? normalize(m, ref) : null;
    const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');
    metricEls.tl.textContent = n && n.connected ? `${fmt(n.tlMst)}×` : '—';
    metricEls.md.textContent = n && n.connected ? `${fmt(n.mdMst)}×` : '—';
    metricEls.ft.textContent = n && n.connected ? `${Math.round(n.ft * 100)}%` : '—';
    if (mode === 'tokyo') {
      moldRow.tl.textContent = metricEls.tl.textContent;
      moldRow.md.textContent = metricEls.md.textContent;
      moldRow.ft.textContent = metricEls.ft.textContent;
    }
    // Where the growth is, in three stages, and one plain sentence on what is happening.
    const settled = !!state && !!n?.connected && (state.settled || state.steps === convergedAt);
    const stage: Stage | null = !enough || !state ? null : settled ? 'settled' : state.stage === 'settled' ? 'thin' : state.stage;
    const at = stage ? STAGES.indexOf(stage) : -1;
    stageEls.forEach((el, i) => {
      el.dataset.state = i < at ? 'done' : i === at ? 'now' : 'next';
      if (i === at) el.setAttribute('aria-current', 'step');
      else el.removeAttribute('aria-current');
    });
    const text = !enough
      ? 'Place at least two foods to start.'
      : converging
        ? 'Skipping ahead…'
        : !stage || stage === 'spread'
          ? scene.origin !== undefined
            ? `Spreading out. Strands reach out from ${scene.foods[scene.origin]?.label ?? 'one food'} and fork as they go.`
            : 'Spreading out. Strands reach out from the food, fork, and fuse where they meet.'
          : stage === 'thin'
            ? n?.connected
              ? 'Thinning out. Busy tubes widen and quiet ones fade.'
              : 'Thinning out, but a food is cut off: no tube reaches it.'
            : 'Settled. The network has stopped changing, so these numbers are its score.';
    statusEl.textContent = !running && enough && !converging && stage !== 'settled' ? `Paused. ${text}` : text;
    statusEl.dataset.kind = stage === 'settled' ? 'settled' : 'growing';
    // The numbers mean little while the whole mesh still counts; they firm up as it thins.
    netEl.dataset.stage = stage ?? 'none';
    if (stage === 'settled' && lastStatus !== 'settled' && n && mode !== 'challenge') {
      liveEl.textContent = `Settled. Cost ${fmt(n.tlMst)} times the minimum spanning tree, travel ${fmt(n.mdMst)} times, fault tolerance ${Math.round(n.ft * 100)} percent.`;
    }
    lastStatus = stage ?? '';
    drawPlate();
    if (mode === 'sandbox' || mode === 'tokyo') drawTradeoff(n && stage !== 'spread' ? n : null, stage === 'settled');
    if (mode === 'challenge') drawChallenge();
    if (mode === 'tour' && n && state) {
      checkGoal({
        settled,
        connected: n.connected,
        tl: n.tlMst,
        md: n.mdMst,
        ft: n.ft,
        i0,
        painted,
      });
    }
  }

  // ------------------------------------------------------------ layout
  let W = 1, H = 1;
  let rect: BoardRect = { x: 0, y: 0, w: 1, h: 1 };
  function layout() {
    const r = root.getBoundingClientRect();
    W = Math.max(1, r.width);
    H = Math.max(1, r.height);
    const dpr = Math.min(2, devicePixelRatio || 1);
    agents.resize(W, H, dpr);
    overlay.resize(W, H, dpr);
    const top = parseFloat(getComputedStyle(root).getPropertyValue('--top')) * 16 || 56;
    const dockBox = dock.getBoundingClientRect();
    const pad = 12;
    let x0 = pad, x1 = W - pad, y0 = top + pad, y1 = dockBox.top - r.top - pad;
    if (!phone()) {
      const p = panel.getBoundingClientRect();
      x0 = Math.max(pad, parseFloat(getComputedStyle(root).getPropertyValue('--gutter')) || 24);
      x1 = p.left - r.left - x0;
    }
    const aw = Math.max(1, x1 - x0), ah = Math.max(1, y1 - y0);
    const s = Math.min(aw / scene.width, ah / scene.height);
    rect = { x: x0 + (aw - scene.width * s) / 2, y: y0 + (ah - scene.height * s) / 2, w: scene.width * s, h: scene.height * s };
    root.style.setProperty('--board-x', `${rect.x}px`);
    root.style.setProperty('--board-y', `${rect.y}px`);
    root.style.setProperty('--board-w', `${rect.w}px`);
    root.style.setProperty('--board-h', `${rect.h}px`);
    schedule();
  }

  // ------------------------------------------------------------ loop
  let raf = 0;
  let agentBurst = 0;
  const t0 = performance.now();
  function schedule() {
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function frame(t: number) {
    raf = 0;
    if (growing() && mesh && growth) {
      growFrame = growthAt(growth, mesh, tauNow(), growFrame ?? undefined);
      if (t - growAttractAt > GROW_ATTRACT_MS) {
        growAttractAt = t;
        attractDirty = true;
      }
    }
    if (attractDirty) rebuildAttract();
    if (litDirty) applyLight();
    // In the challenge the mold stays hidden until the race.
    const hidden = mode === 'challenge' && !raced && !racing;
    const moldShown = view !== 'tubes' && !hidden;
    if (running || agentBurst > 0 || racing) {
      const n = agentBurst > 0 || racing ? 8 : SPEEDS[speed].agents;
      if (moldShown) agents.step(n);
      if (agentBurst > 0) agentBurst = Math.max(0, agentBurst - n);
    }
    agents.draw(rect, moldShown);
    overlay.draw({
      rect,
      scene,
      mesh,
      state,
      tubes: hidden || view === 'mold' ? 0 : view === 'both' ? (mode === 'challenge' ? 0.55 : 0.75) : 1,
      time: running && !reduced() ? (t - t0) / 1000 : null,
      cuts,
      hover: hover && tool !== 'food' ? { ...hover, tool, radius: BRUSH } : null,
      cursor: cursorOn ? cursor : null,
      active: dragFood,
      contrast: contrast(),
      map,
      compare: mode === 'tour' ? tourCompare : refs && compare !== 'none' ? refs.nets[compare] : null,
      labels: labels && { ...labels, all: rect.w >= ALL_LABELS },
      track: mode === 'challenge' ? { net: trackNetwork(scene, track), preview: trackPreview() } : null,
      view: {
        grow: growing() && growth && growFrame ? { g: growth, frame: growFrame } : null,
        weight: tubeW,
        x: tubeX,
        y: tubeY,
      },
      ...notesFrame(t),
    });
    if (running || agentBurst > 0 || converging || racing || notesMoving) raf = requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------ callouts
  // A naturalist's notes on the board (Sandbox and Tour): an oat flake, then the growing front
  // while the strands spread, then the busiest tube. They drift to new targets on springs.
  // The tube the "busiest" note points at, kept while it stays thick so the note doesn't hop.
  let busyEdge = -1;
  let flakeAt = 0;
  function pickNotes(): { id: string; text: string; x: number; y: number }[] {
    if (!scene.foods.length) return [];
    // Small boards get one short note, so the notes never crowd a phone.
    const compact = rect.w < 520;
    const out: { id: string; text: string; x: number; y: number }[] = [];
    if (growing() && growth && growFrame && mesh) {
      // A growing tip well inside the board and as far as possible from every food: the front.
      let bx = 0, by = 0, bd = -1;
      const m = 0.12 * Math.min(scene.width, scene.height);
      for (let e = 0; e < mesh.ea.length; e++) {
        for (const [from, to, share] of [[mesh.ea[e], mesh.eb[e], growFrame.fromA[e]], [mesh.eb[e], mesh.ea[e], growFrame.fromB[e]]]) {
          if (!(share > 0 && share < 1)) continue;
          const x = growth.sx[from] + (growth.sx[to] - growth.sx[from]) * share;
          const y = growth.sy[from] + (growth.sy[to] - growth.sy[from]) * share;
          if (x < m || y < m || x > scene.width - m || y > scene.height - m) continue;
          let d = Infinity;
          for (const f of scene.foods) d = Math.min(d, (f.x - x) ** 2 + (f.y - y) ** 2);
          if (d > bd) [bx, by, bd] = [x, y, d];
        }
      }
      if (bd >= 0) out.push({ id: 'front', text: 'growing front', x: bx, y: by });
    } else if (mesh && state && tubeW && tubeX && tubeY && !state.grow) {
      if (!(busyEdge >= 0 && busyEdge < tubeW.length && tubeW[busyEdge] > 0.6)) {
        busyEdge = -1;
        let bd = 0;
        for (let e = 0; e < state.D.length; e++) if (tubeW[e] > 0.6 && state.D[e] > bd) [busyEdge, bd] = [e, state.D[e]];
      }
      if (busyEdge >= 0) {
        const a = mesh.ea[busyEdge], b = mesh.eb[busyEdge];
        out.push({ id: 'busy', text: compact ? 'busiest tube' : 'busiest tube: most flow, most growth', x: (tubeX[a] + tubeX[b]) / 2, y: (tubeY[a] + tubeY[b]) / 2 });
      }
    }
    if (!compact) {
      // An oat flake away from the other note, so the two never crowd each other. It stays put
      // until the board changes or the other note comes close.
      const other = out[0];
      const near = (f: { x: number; y: number }) => !!other && Math.hypot(f.x - other.x, f.y - other.y) < 0.2 * scene.width;
      let food = scene.foods[flakeAt];
      if (!food || near(food)) {
        flakeAt = 0;
        if (other) scene.foods.forEach((f, i) => {
          if ((f.x - other.x) ** 2 + (f.y - other.y) ** 2 > (scene.foods[flakeAt].x - other.x) ** 2 + (scene.foods[flakeAt].y - other.y) ** 2) flakeAt = i;
        });
        food = scene.foods[flakeAt];
      }
      out.unshift({ id: 'flake', text: 'oat flake, the food', x: food.x, y: food.y });
    }
    return out;
  }
  function notesFrame(t: number): { callouts: CalloutNote[]; calloutAlpha: number } {
    const show = (mode === 'sandbox' || mode === 'tour') && view !== 'mold' && scene.foods.length >= 2;
    const dt = Math.min(0.05, Math.max(0, (t - notesLast) / 1000));
    notesLast = t;
    if (show && t - notesPicked > 500) {
      notesPicked = t;
      const picked = pickNotes();
      notes = picked.map((p) => {
        const old = notes.find((n) => n.id === p.id);
        const n = old ?? { id: p.id, text: p.text, x: new Spring(p.x, 0.9), y: new Spring(p.y, 0.9) };
        n.text = p.text;
        n.x.target = p.x;
        n.y.target = p.y;
        return n;
      });
    }
    noteAlpha.target = show && notes.length ? 0.9 : 0;
    if (reduced()) {
      noteAlpha.snap(noteAlpha.target);
      for (const n of notes) {
        n.x.snap(n.x.target);
        n.y.snap(n.y.target);
      }
    } else {
      noteAlpha.step(dt);
      for (const n of notes) {
        n.x.step(dt);
        n.y.step(dt);
      }
    }
    const settledNote = (sp: Spring) => Math.abs(sp.target - sp.value) < 1e-4;
    notesMoving = !reduced() && (Math.abs(noteAlpha.target - noteAlpha.value) > 0.01 || notes.some((n) => !settledNote(n.x) || !settledNote(n.y)));
    return { callouts: notes.map((n) => ({ x: n.x.value, y: n.y.value, text: n.text })), calloutAlpha: Math.max(0, Math.min(1, noteAlpha.value)) };
  }

  // ------------------------------------------------------------ the plate caption
  // The board is captioned like a plate in a naturalist's book.
  function drawPlate() {
    const n = scene.foods.length;
    const html =
      mode === 'tokyo'
        ? 'Plate III. The Kanto plain, after Tero <i>et al.</i> (2010). The mold is set down on Tokyo.'
        : mode === 'tour'
          ? `Plate II.${tourAt + 1}. ${TOUR[tourAt].title}.`
          : mode === 'challenge'
            ? `Plate IV. ${LEVELS[levelAt].title}: your track in drafting ink.`
            : phone()
              ? `Plate I. <i>P. polycephalum</i> on agar, ${n} oat flake${n === 1 ? '' : 's'}.`
              : `Plate I. <i>Physarum polycephalum</i> on agar, ${n} oat flake${n === 1 ? '' : 's'}. Streaming shown about 12× faster.`;
    if (html === plateText) return;
    plateText = html;
    plateEl.innerHTML = html;
  }

  // ------------------------------------------------------------ cost against resilience
  // The Engineering figure: where the mold sits between the cheap, fragile tree and the
  // costly, robust mesh. The reference networks are cached per board.
  function drawTradeoff(mold: Normalized | null, force = false) {
    const el = tradeoffEls.find((e) => e.dataset.tradeoff === (mode === 'tokyo' ? 'tokyo' : 'sandbox'));
    if (!el || scene.foods.length < 2) return;
    const now = performance.now();
    if (!force && now - tradeoffDrawn < 300) return;
    tradeoffDrawn = now;
    const key = `${mode}:${scene.foods.map((f) => `${f.x.toFixed(3)},${f.y.toFixed(3)}`).join(';')}`;
    if (key !== tradeoffKey) {
      tradeoffKey = key;
      const ref = metrics(mst(scene.foods));
      const pt = (id: string, label: string, net: Network): TradeoffPoint => {
        const n = normalize(metrics(net), ref);
        return { id, label, cost: n.tlMst, robust: n.ft };
      };
      tradeoffRefs = [pt('mst', 'Spanning tree', mst(scene.foods)), pt('steiner', 'Steiner tree', steinerTree(scene.foods)), pt('delaunay', 'Delaunay mesh', delaunay(scene.foods))];
      if (mode === 'tokyo' && refs) tradeoffRefs.push({ id: 'rail', label: 'Rail lines', cost: refs.scores.rail.tlMst, robust: refs.scores.rail.ft });
      // The paper's measured Tokyo rail network, for scale.
      else tradeoffRefs.push({ id: 'paper', label: 'Tokyo rail (2010)', cost: 1.8, robust: 0.96 });
    }
    const all = [...tradeoffRefs, ...(mold && mold.connected ? [{ id: 'mold', label: 'The mold', cost: mold.tlMst, robust: mold.ft }] : [])];
    const L = tradeoffLayout(all, 320, 190);
    const f = (v: number) => v.toFixed(1);
    const parts = [
      `<line class="tf__axis" x1="${L.x0}" y1="${L.y1}" x2="${L.x1}" y2="${L.y1}"/>`,
      `<line class="tf__axis" x1="${L.x0}" y1="${L.y0}" x2="${L.x0}" y2="${L.y1}"/>`,
      ...L.ticks.map((t) => `<line class="tf__tick" x1="${f(t.x)}" y1="${L.y1}" x2="${f(t.x)}" y2="${L.y1 + 4}"/><text class="tf__num" x="${f(t.x)}" y="${L.y1 + 14}" text-anchor="middle">${t.value}×</text>`),
      `<text class="tf__num" x="${L.x0 - 5}" y="${L.y0 + 4}" text-anchor="end">100%</text><text class="tf__num" x="${L.x0 - 5}" y="${L.y1}" text-anchor="end">0%</text>`,
      `<text class="tf__cap" x="${(L.x0 + L.x1) / 2}" y="${L.height - 1}" text-anchor="middle">cost, × the spanning tree →</text>`,
      `<text class="tf__cap" transform="translate(9 ${(L.y0 + L.y1) / 2}) rotate(-90)" text-anchor="middle">robust →</text>`,
      ...L.points.map(
        (p) =>
          `<g class="tf__pt" data-id="${p.id}"><circle cx="${f(p.x)}" cy="${f(p.y)}" r="${p.id === 'mold' ? 5 : 3.5}"/><text x="${f(p.lx)}" y="${f(p.ly)}" text-anchor="${p.anchor}">${p.label}</text></g>`,
      ),
    ];
    el.setAttribute('viewBox', `0 0 ${L.width} ${L.height}`);
    el.innerHTML = parts.join('');
  }

  // ------------------------------------------------------------ scene changes
  let hashTimer = 0;
  function scheduleHash() {
    clearTimeout(hashTimer);
    hashTimer = window.setTimeout(() => {
      try {
        const hash =
          mode === 'tokyo'
            ? `m=tokyo&i=${Math.round(i0 * 100) / 100}`
            : mode === 'tour'
              ? `m=tour&s=${TOUR[tourAt].id}`
              : mode === 'challenge'
                ? `m=challenge&c=${LEVELS[levelAt].id}`
                : sceneToHash(scene, i0);
        history.replaceState(null, '', `#${hash}`);
      } catch {
        // Some sandboxes forbid it; sharing just won't carry the board.
      }
    }, 400);
  }

  function foodsChanged() {
    host.send({ type: 'foods', foods: scene.foods.map((f) => ({ ...f })) });
    showGrownIfStill();
    if (mode === 'tour' && TOUR[tourAt].compare === 'mst') tourCompare = scene.foods.length >= 2 ? mst(scene.foods) : null;
    attractDirty = true;
    drawReadout();
    scheduleHash();
    schedule();
  }

  let litDirty = false;
  let lightSent = 0;
  function lightChanged(final: boolean) {
    litDirty = true;
    overlay.lightChanged(scene);
    const now = performance.now();
    if (final || now - lightSent > 150) {
      lightSent = now;
      host.send({ type: 'light', light: { w: scene.light.w, h: scene.light.h, data: scene.light.data.slice() } });
    }
    if (final) {
      if (mode === 'tour') painted = true;
      scheduleHash();
    }
    schedule();
  }
  function applyLight() {
    litDirty = false;
    lit = lightGrid(scene, agents.gw, agents.gh);
    agents.setLight(lit);
    attractDirty = true;
    rebuildAttract();
  }

  // ------------------------------------------------------------ pointer on the board
  let hover: { x: number; y: number } | null = null;
  let dragFood = -1;
  let drag: { id: number; kind: 'food' | 'light' | 'cut' | 'track' | 'erase'; moved: boolean; x: number; y: number; paint: 0 | 1; added: boolean } | null = null;
  let cuts: number[] = [];
  const toBoard = (e: PointerEvent) => {
    const r = overlayCanvas.getBoundingClientRect();
    const s = rect.w / scene.width;
    return { x: (e.clientX - r.left - rect.x) / s, y: (e.clientY - r.top - rect.y) / s };
  };
  const onBoard = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0 && p.x <= scene.width && p.y <= scene.height;
  const clampBoard = (p: { x: number; y: number }) => ({
    x: Math.min(scene.width, Math.max(0, p.x)),
    y: Math.min(scene.height, Math.max(0, p.y)),
  });
  /** The pointer's reach, in board units. */
  const hitRadius = () => Math.max(16, 12 * (rect.w / 900)) / (rect.w / scene.width);
  const xy = (p: { x: number; y: number }) => [p.x, p.y] as const;
  function foodAt(p: { x: number; y: number }): number {
    const hit = hitRadius();
    let best = -1, bestD = hit;
    scene.foods.forEach((f, i) => {
      const d = Math.hypot(f.x - p.x, f.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }
  function paintStroke(x0: number, y0: number, x1: number, y1: number, value: 0 | 1) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (BRUSH * 0.4)));
    for (let k = 0; k <= n; k++) paintLight(scene, x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, BRUSH, value);
  }
  function cutStroke(x0: number, y0: number, x1: number, y1: number) {
    host.send({ type: 'cut', x0, y0, x1, y1 });
    cuts.push(x0, y0, x1, y1);
    const sx = agents.gw / scene.width;
    agents.erase([x0 * sx, y0 * sx, x1 * sx, y1 * sx], 2.5);
    schedule();
  }

  overlayCanvas.addEventListener('pointerdown', (e) => {
    if (drag || e.button > 0) return;
    const p = toBoard(e);
    if (!onBoard(p)) return;
    overlayCanvas.setPointerCapture(e.pointerId);
    cursorOn = false;
    if (tool === 'track') {
      trackFrom = endAt(scene, track, p.x, p.y, hitRadius());
      trackTo = p;
      drag = { id: e.pointerId, kind: 'track', moved: false, x: p.x, y: p.y, paint: 1, added: false };
    } else if (tool === 'erase') {
      drag = { id: e.pointerId, kind: 'erase', moved: false, x: p.x, y: p.y, paint: 1, added: false };
      eraseAt(p.x, p.y);
    } else if (tool === 'food') {
      let i = foodAt(p);
      let added = false;
      if (i < 0) {
        if (scene.foods.length >= MAX_FOODS || isLit(scene, p.x, p.y)) {
          announce(scene.foods.length >= MAX_FOODS ? `At most ${MAX_FOODS} foods.` : 'The mold avoids light: place food in the dark.');
          return;
        }
        scene.foods.push({ x: p.x, y: p.y });
        i = scene.foods.length - 1;
        added = true;
        foodsChanged();
      }
      dragFood = i;
      drag = { id: e.pointerId, kind: 'food', moved: false, x: p.x, y: p.y, paint: 1, added };
    } else if (tool === 'light') {
      const paint: 0 | 1 = isLit(scene, p.x, p.y) ? 0 : 1;
      drag = { id: e.pointerId, kind: 'light', moved: false, x: p.x, y: p.y, paint, added: false };
      paintStroke(p.x, p.y, p.x, p.y, paint);
      lightChanged(false);
    } else {
      drag = { id: e.pointerId, kind: 'cut', moved: false, x: p.x, y: p.y, paint: 1, added: false };
    }
    schedule();
  });

  overlayCanvas.addEventListener('pointermove', (e) => {
    const p = toBoard(e);
    hover = onBoard(p) ? p : null;
    if (!drag || drag.id !== e.pointerId) {
      if (tool !== 'food') schedule();
      return;
    }
    const q = clampBoard(p);
    if (Math.hypot(q.x - drag.x, q.y - drag.y) * (rect.w / scene.width) > 3) drag.moved = true;
    if (drag.kind === 'track') trackTo = q;
    else if (drag.kind === 'erase') eraseAt(q.x, q.y);
    else if (drag.kind === 'food' && drag.moved) {
      if (!isLit(scene, q.x, q.y)) {
        scene.foods[dragFood] = { ...scene.foods[dragFood], x: q.x, y: q.y };
        foodsChanged();
      }
    } else if (drag.kind === 'light') {
      paintStroke(drag.x, drag.y, q.x, q.y, drag.paint);
      drag.x = q.x;
      drag.y = q.y;
      lightChanged(false);
    } else if (drag.kind === 'cut' && drag.moved) {
      cutStroke(drag.x, drag.y, q.x, q.y);
      drag.x = q.x;
      drag.y = q.y;
    }
    schedule();
  });

  const endDrag = (e: PointerEvent) => {
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag;
    drag = null;
    if (d.kind === 'track') {
      const from = trackFrom;
      trackFrom = null;
      trackTo = null;
      if (from && d.moved) layTrack(from, endAt(scene, track, ...xy(clampBoard(toBoard(e))), hitRadius()));
    } else if (d.kind === 'food') {
      // A tap on a food that was already there takes it away.
      if (!d.moved && !d.added) {
        scene.foods.splice(dragFood, 1);
        foodsChanged();
      }
      dragFood = -1;
    } else if (d.kind === 'light') lightChanged(true);
    schedule();
  };
  overlayCanvas.addEventListener('pointerup', endDrag);
  overlayCanvas.addEventListener('pointercancel', endDrag);
  overlayCanvas.addEventListener('pointerleave', () => {
    hover = null;
    schedule();
  });

  // ------------------------------------------------------------ keyboard cursor
  let cursor = { x: scene.width / 2, y: scene.height / 2 };
  let cursorOn = false;
  overlayCanvas.addEventListener('keydown', (e) => {
    const stepK = e.shiftKey ? 0.08 : 0.02;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      cursorOn = true;
      cursor = clampBoard({ x: cursor.x + m[0] * stepK, y: cursor.y + m[1] * stepK });
      schedule();
      return;
    }
    if (e.key === 'Escape' && trackFrom) {
      trackFrom = null;
      announce('Track cancelled.');
      schedule();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      cursorOn = true;
      if (tool === 'track') {
        const end = endAt(scene, track, cursor.x, cursor.y, hitRadius());
        if (!trackFrom) {
          trackFrom = end;
          announce('Track starts here. Move the cursor and press Enter to lay it, or Escape to cancel.');
        } else {
          const from = trackFrom;
          trackFrom = null;
          layTrack(from, end);
        }
      } else if (tool === 'erase') eraseAt(cursor.x, cursor.y);
      else if (tool === 'food') {
        const i = foodAt(cursor);
        if (i >= 0) {
          scene.foods.splice(i, 1);
          announce('Food removed.');
        } else if (scene.foods.length < MAX_FOODS && !isLit(scene, cursor.x, cursor.y)) {
          scene.foods.push({ ...cursor });
          announce(`Food placed. ${scene.foods.length} foods.`);
        }
        foodsChanged();
      } else if (tool === 'light') {
        paintLight(scene, cursor.x, cursor.y, BRUSH, isLit(scene, cursor.x, cursor.y) ? 0 : 1);
        lightChanged(true);
      }
      schedule();
    }
  });
  overlayCanvas.addEventListener('blur', () => {
    cursorOn = false;
    schedule();
  });

  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === ' ' && !target.closest('button')) {
      e.preventDefault();
      if (!playBtn.disabled) setRunning(!running);
    }
  });

  // ------------------------------------------------------------ dock
  function setRunning(on: boolean) {
    running = on;
    drawReadout();
    playBtn.setAttribute('aria-pressed', String(on));
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    sendRun();
    schedule();
  }
  playBtn.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    setRunning(!running);
  });
  playBtn.addEventListener('click', (e) => {
    // Keyboard activation (pointer presses were handled on pointer-down).
    if (e.detail === 0) setRunning(!running);
  });
  convergeBtn.addEventListener('click', () => {
    if (converging) return;
    converging = true;
    convergeBtn.disabled = true;
    drawReadout();
    host.send({ type: 'converge', steps: CONVERGE_STEPS });
    schedule();
  });

  const pressGroup = (attr: string, value: string) => {
    for (const b of $$(`[${attr}]`)) b.setAttribute('aria-pressed', String(b.getAttribute(attr) === value));
  };
  function setTool(t: Tool) {
    tool = t;
    root.dataset.tool = tool;
    pressGroup('data-tool-btn', tool);
    schedule();
  }
  for (const b of $$('[data-tool-btn]')) b.addEventListener('click', () => setTool(b.dataset.toolBtn as Tool));
  for (const b of $$('[data-view-btn]')) {
    b.addEventListener('click', () => {
      view = b.dataset.viewBtn as View;
      pressGroup('data-view-btn', view);
      schedule();
    });
  }
  for (const b of $$('[data-speed-btn]')) {
    b.addEventListener('click', () => {
      speed = b.dataset.speedBtn as Speed;
      pressGroup('data-speed-btn', speed);
      sendRun();
    });
  }

  function setI0(v: number, send: boolean) {
    i0 = v;
    i0In.value = String(Math.round(sliderFromI0(v)));
    i0Label.textContent = v.toFixed(v < 1 ? 2 : 1);
    i0In.setAttribute('aria-valuetext', `I zero ${v.toFixed(2)}`);
    if (send) {
      host.send({ type: 'params', i0: v });
      scheduleHash();
    }
  }
  setI0(i0, false);
  i0In.addEventListener('input', () => setI0(i0FromSlider(Number(i0In.value)), true));
  i0In.addEventListener('change', () => {
    if (mode === 'tour' && TOUR[tourAt].regrowOnI0) regrow(`The mold starts over at I zero ${i0.toFixed(1)}.`);
  });

  /** Start over: the strands spread again from the food on the same board. */
  function regrow(message = 'The mold starts over: strands spread again from the food.') {
    host.send({ type: 'reset' });
    showGrownIfStill();
    cuts = [];
    convergedAt = -1;
    agents.respawn(lit, Math.floor(Math.random() * 1e9));
    announce(message);
    schedule();
  }
  $('[data-regrow]').addEventListener('click', () => regrow());
  $('[data-clear]').addEventListener('click', () => {
    scene.foods = [];
    scene.light.data.fill(0);
    cuts = [];
    host.send({ type: 'reset' });
    foodsChanged();
    lightChanged(true);
    agents.respawn(lit, 11);
    announce('Board cleared. Tap to place food.');
  });
  $('[data-example]').addEventListener('click', () => {
    const ex = example();
    scene.foods = ex.foods;
    scene.light.data.fill(0);
    cuts = [];
    host.send({ type: 'reset' });
    foodsChanged();
    lightChanged(true);
    agents.respawn(lit, 7);
  });

  function announce(text: string) {
    liveEl.textContent = text;
  }

  // ------------------------------------------------------------ modes
  /** Puts a new scene on the board: the flow model, the agents and the light start over. */
  function loadScene(next: Scene, nextI0: number, gamma?: number, seed?: number) {
    scene = next;
    cuts = [];
    state = null;
    growth = null;
    film = null;
    growFrame = null;
    tubeW = tubeX = tubeY = null;
    convergedAt = -1;
    converging = false;
    convergeBtn.disabled = false;
    dragFood = -1;
    drag = null;
    cursor = { x: scene.width / 2, y: scene.height / 2 };
    setI0(nextI0, false);
    gen++;
    host.send({ type: 'init', scene: cloneScene(scene), params: { i0, ...(gamma && { gamma }), ...(seed && { seed }) }, gen });
    showGrownIfStill();
    litDirty = false;
    lit = lightGrid(scene, agents.gw, agents.gh);
    agents.setLight(lit);
    agents.respawn(lit, 7);
    overlay.lightChanged(scene);
    attractDirty = true;
    drawReadout();
    scheduleHash();
    schedule();
  }

  const fmtX = (v: number) => (Number.isFinite(v) ? `${v.toFixed(2)}×` : '—');
  /** Enables only the given tools, and switches to `pick` (or keeps the current one if allowed). */
  function allowTools(allowed: Tool[], pick?: Tool) {
    for (const b of $$<HTMLButtonElement>('[data-tool-btn]')) {
      const on = allowed.includes(b.dataset.toolBtn as Tool);
      b.disabled = !on;
      if (on) b.removeAttribute('title');
      else b.title = mode === 'tokyo' ? 'The map is fixed here. Edit food and light in the Sandbox.' : 'Not in this step. Everything is open in the Sandbox.';
    }
    setTool(pick ?? (allowed.includes(tool) ? tool : allowed[0]));
  }

  /** Builds the Kanto map for this board, with its reference networks, and returns its scene. */
  function useKanto(): Scene {
    map = kanto(scene.width, scene.height, scene.light.w);
    const ref = metrics(mst(map.scene.foods));
    const nets = { rail: map.rail, mst: mst(map.scene.foods), delaunay: delaunay(map.scene.foods) };
    refs = {
      nets,
      scores: { rail: normalize(metrics(nets.rail), ref), mst: normalize(metrics(nets.mst), ref), delaunay: normalize(metrics(nets.delaunay), ref) },
    };
    for (const id of ['rail', 'mst', 'delaunay'] as const) {
      const el = compareEls(id), sc = refs.scores[id];
      el.tl.textContent = fmtX(sc.tlMst);
      el.md.textContent = fmtX(sc.mdMst);
      el.ft.textContent = `${Math.round(sc.ft * 100)}%`;
    }
    labels = {
      major: map.scene.foods.map((f) => isMajor(f.label)),
      side: map.scene.foods.map((f) => labelSide(f.label)),
      all: true,
    };
    return map.scene;
  }
  function dropMap() {
    map = null;
    refs = null;
    labels = null;
  }

  function setMode(m: Mode, step?: number) {
    if (m === mode) return;
    const from = mode;
    mode = m;
    root.dataset.mode = m;
    for (const b of $$('[data-mode-btn]')) {
      const on = b.dataset.modeBtn === m;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const p of $$('[data-pane]')) p.hidden = p.dataset.pane !== m;
    $('[data-panes]').scrollTop = 0;
    if (from === 'sandbox') saved = { scene, i0, tool };
    if (from === 'challenge') leaveChallenge();
    tourCompare = null;
    if (m === 'tokyo') {
      const next = useKanto();
      allowTools(['cut'], 'cut');
      loadScene(next, TOKYO_I0);
      announce('Tokyo: 34 cities around Tokyo Bay. The mold grows a network between them. Drag across a tube to cut it.');
    } else if (m === 'tour') {
      goStep(step ?? stepIndex(progress.at), true);
    } else if (m === 'challenge') {
      dropMap();
      goLevel(step ?? levelIndex(challenge.at));
    } else {
      dropMap();
      const back = saved ?? { scene: example(), i0: 2, tool: 'food' as Tool };
      saved = null;
      allowTools(TOOLS, back.tool);
      loadScene(back.scene, back.i0);
      announce('Sandbox.');
    }
  }

  // ------------------------------------------------------------ tour
  const loadProgress = () => {
    try {
      return localStorage.getItem(PROGRESS_KEY);
    } catch {
      return null;
    }
  };
  let progress: Progress = parseProgress(loadProgress());
  function saveProgress() {
    try {
      localStorage.setItem(PROGRESS_KEY, serializeProgress(progress, loadProgress()));
    } catch {
      // Private mode or blocked storage: the tour still works, it just won't remember.
    }
  }
  let tourAt = 0;
  let marks = new Set<string>();
  let painted = false;
  const stepEls = $$('[data-tour-step]');
  const dotEls = $$<HTMLButtonElement>('[data-step-btn]');
  const prevBtn = $<HTMLButtonElement>('[data-tour-prev]');
  const nextBtn = $<HTMLButtonElement>('[data-tour-next]');
  const resetBtn = $<HTMLButtonElement>('[data-tour-reset]');
  const tourPane = $('[data-pane="tour"]');

  function drawTour() {
    const step = TOUR[tourAt];
    const met = progress.done.includes(step.id);
    stepEls.forEach((el, i) => (el.hidden = i !== tourAt));
    dotEls.forEach((b, i) => {
      const done = progress.done.includes(TOUR[i].id);
      b.dataset.done = String(done);
      if (i === tourAt) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
      b.setAttribute('aria-label', `Step ${i + 1}: ${TOUR[i].title}${done ? ', done' : ''}`);
    });
    const goal = stepEls[tourAt].querySelector<HTMLElement>('[data-goal]');
    if (goal) {
      goal.dataset.met = String(met);
      goal.querySelector('[data-goal-state]')!.textContent = met ? 'Done.' : 'Not yet.';
    }
    tourPane.dataset.met = String(met || !step.needs.length);
    prevBtn.disabled = tourAt === 0;
    nextBtn.hidden = tourAt === TOUR.length - 1;
    resetBtn.hidden = step.board === null;
  }

  /** Loads a step: its board, tools and I₀, and clears its goal's marks. */
  function goStep(i: number, entering = false) {
    tourAt = Math.min(TOUR.length - 1, Math.max(0, i));
    const step: TourStep = TOUR[tourAt];
    marks = new Set();
    painted = false;
    progress = { ...progress, at: step.id };
    if (!step.needs.length && !progress.done.includes(step.id)) progress.done = [...progress.done, step.id];
    saveProgress();
    for (const el of stepEls[tourAt].querySelectorAll('[data-reading]')) el.textContent = 'not yet';
    loadStepBoard(step);
    drawTour();
    if (!entering) $('[data-panes]').scrollTop = 0;
    announce(`Step ${tourAt + 1} of ${TOUR.length}: ${step.title}.`);
  }

  function loadStepBoard(step: TourStep) {
    allowTools(step.tools, step.tool);
    painted = false;
    if (step.board === 'kanto') {
      const next = useKanto();
      tourCompare = step.compare === 'rail' ? map!.rail : null;
      loadScene(next, step.i0, step.gamma, step.seed);
      return;
    }
    if (step.board === null) {
      // Keep the board as it is; with no board yet in the tour, the example.
      if (!scene.foods.length) loadScene(example(), step.i0);
      tourCompare = null;
      scheduleHash();
      schedule();
      return;
    }
    dropMap();
    const next = step.board(scene.width, scene.height, scene.light.w);
    tourCompare = step.compare === 'mst' ? mst(next.foods) : null;
    loadScene(next, step.i0, step.gamma, step.seed);
  }

  function checkGoal(r: Parameters<TourStep['marks']>[0]) {
    const step = TOUR[tourAt];
    for (const m of step.marks(r)) {
      const el = stepEls[tourAt].querySelector(`[data-reading="${m}"]`);
      if (el) el.textContent = `I₀ ${r.i0.toFixed(1)}\ncost ${fmtX(r.tl)} · robust ${Math.round(r.ft * 100)}%`;
    }
    if (progress.done.includes(step.id) || !step.needs.length) return;
    const got = earn(step, marks, r);
    marks = got.marks;
    if (!got.met) return;
    progress = { ...progress, done: [...progress.done, step.id] };
    saveProgress();
    drawTour();
    announce(`Done: ${step.goal}.${tourAt < TOUR.length - 1 ? ' Next when you are ready.' : ''}`);
  }

  prevBtn.addEventListener('click', () => goStep(tourAt - 1));
  nextBtn.addEventListener('click', () => goStep(tourAt + 1));
  for (const b of dotEls) b.addEventListener('click', () => goStep(stepIndex(b.dataset.stepBtn)));
  resetBtn.addEventListener('click', () => {
    loadStepBoard(TOUR[tourAt]);
    marks = new Set();
    announce('Board reset.');
  });
  $('[data-tour-restart]').addEventListener('click', () => {
    progress = { at: TOUR[0].id, done: [] };
    goStep(0);
  });
  for (const b of $$('[data-go-mode]')) b.addEventListener('click', () => setMode(b.dataset.goMode as Mode));

  const modeBtns = $$('[data-mode-btn]');
  for (const b of modeBtns) {
    b.addEventListener('click', () => setMode(b.dataset.modeBtn as Mode));
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = modeBtns[(modeBtns.indexOf(b) + d + modeBtns.length) % modeBtns.length];
      next.focus();
      setMode(next.dataset.modeBtn as Mode);
    });
  }
  for (const b of $$('[data-compare]')) {
    b.addEventListener('click', () => {
      compare = b.dataset.compare as Compare;
      pressGroup('data-compare', compare);
      schedule();
    });
  }

  // ------------------------------------------------------------ challenge
  challenge = parseChallenge(loadProgress());
  const raceBtns = $$<HTMLButtonElement>('[data-race]');
  const undoBtn = $<HTMLButtonElement>('[data-undo]');
  const levelEls = $$<HTMLButtonElement>('[data-level-btn]');
  const budgetEl = $('[data-budget]');
  const verdictEl = $('[data-verdict]');
  const budget = () => LEVELS[levelAt].budget * mstRef.tl;

  function saveChallenge() {
    try {
      localStorage.setItem(PROGRESS_KEY, serializeChallenge(challenge, loadProgress()));
    } catch {
      // Blocked storage: the challenge still works, it just won't remember.
    }
  }

  function goLevel(i: number) {
    levelAt = Math.min(LEVELS.length - 1, Math.max(0, i));
    const level = LEVELS[levelAt];
    challenge = { ...challenge, at: level.id };
    saveChallenge();
    track = emptyTrack();
    undoStack = [];
    trackFrom = trackTo = null;
    raced = racing = false;
    mold = null;
    setRunning(false);
    allowTools(['track', 'erase'], 'track');
    const next = level.board(scene.width, scene.height, scene.light.w);
    mstRef = metrics(mst(next.foods));
    loadScene(next, RACE_I0);
    $('[data-level-k]').textContent = `Level ${levelAt + 1} of ${LEVELS.length}`;
    $('[data-level-title]').textContent = level.title;
    $('[data-level-blurb]').textContent = level.blurb;
    trackChanged(false);
    announce(`Level ${levelAt + 1}: ${level.title}. ${level.blurb}`);
  }

  function leaveChallenge() {
    racing = raced = false;
    trackFrom = trackTo = null;
    playBtn.disabled = false;
    setRunning(!reduced());
  }

  function trackPreview() {
    if (!trackFrom) return null;
    const a = endPoint(scene, track, trackFrom);
    const to = trackTo ?? (cursorOn ? cursor : null);
    if (!to) return null;
    const b = endPoint(scene, track, endAt(scene, track, to.x, to.y, hitRadius()));
    const ok = typeof build(scene, track, trackFrom, endAt(scene, track, to.x, to.y, hitRadius()), budget()) !== 'string';
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y, ok };
  }

  const BUILD_ERRORS: Record<BuildError, string> = {
    light: 'Track can’t cross light.',
    budget: 'That would go over the budget. Erase some track first.',
    short: '',
  };
  function layTrack(a: End, b: End) {
    const next = build(scene, track, a, b, budget());
    if (typeof next === 'string') {
      if (BUILD_ERRORS[next]) announce(BUILD_ERRORS[next]);
      schedule();
      return;
    }
    undoStack.push(track);
    track = next;
    trackChanged(true);
  }
  function eraseAt(x: number, y: number) {
    const next = erase(scene, track, x, y, hitRadius() * 0.75);
    if (!next) return;
    undoStack.push(track);
    track = next;
    trackChanged(true);
  }

  /** Re-measures the track and redraws the challenge readout. */
  function trackChanged(announceIt: boolean) {
    you = measure(scene, track, mstRef);
    undoBtn.disabled = !undoStack.length;
    if (raced && you.connected && mold) {
      challenge = record(challenge, LEVELS[levelAt].id, score(you, mold));
      saveChallenge();
    }
    drawChallenge();
    if (announceIt && you.connected && !raced) announce(`Every town is connected. Track ${fmtX(you.tlMst)} of ${fmtX(LEVELS[levelAt].budget)}. Race the mold when you are ready.`);
    schedule();
  }

  function race() {
    if (racing || !you?.connected) return;
    racing = true;
    raced = false;
    mold = null;
    // A fresh model with the same seed, so a level's mold is the same every race.
    gen++;
    state = null;
    growth = null;
    film = null;
    growFrame = null;
    tubeW = tubeX = tubeY = null;
    convergedAt = -1;
    host.send({ type: 'init', scene: cloneScene(scene), params: { i0: RACE_I0 }, gen });
    agents.respawn(lit, 7);
    attractDirty = true;
    sendRun();
    drawChallenge();
    announce('The mold is growing on the same map.');
    schedule();
  }
  function finishRace(m: StateMsg) {
    racing = false;
    raced = true;
    mold = normalize(m.metrics, mstRef);
    convergedAt = m.steps;
    agentBurst = 120;
    sendRun();
    const sc = you ? score(you, mold) : null;
    if (sc) {
      challenge = record(challenge, LEVELS[levelAt].id, sc);
      saveChallenge();
    }
    drawChallenge();
    if (sc) announce(`${verdictText(sc.verdict)} Cost ${sc.cost}, travel ${sc.travel}, robust ${sc.robust}.`);
  }

  const verdictText = (v: ReturnType<typeof score>['verdict']) =>
    ({
      beat: 'You beat the mold.',
      lost: 'The mold wins this one.',
      tradeoff: 'A trade-off: you win some, the mold wins some.',
      tie: 'A dead heat.',
      unfinished: 'Connect every town to score.',
    })[v];

  function drawChallenge() {
    const level = LEVELS[levelAt];
    const built = builtLength(scene, track) / (mstRef.tl || 1);
    const yours = you;
    budgetEl.dataset.over = String(built > level.budget * 0.98);
    $('[data-budget-v]').textContent = `${built.toFixed(2)}× of ${level.budget.toFixed(2)}×`;
    $('[data-budget-bar]').style.width = `${Math.min(100, (100 * built) / level.budget)}%`;
    const ok = !!yours?.connected;
    for (const b of raceBtns) {
      b.disabled = racing || !ok;
      b.textContent = raced ? 'Race again' : 'Race the mold';
      if (ok) b.removeAttribute('title');
      else b.title = 'Connect every town first';
    }
    playBtn.disabled = !raced;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const youVals = { tl: yours && yours.connected ? fmtX(yours.tlMst) : built ? `${built.toFixed(2)}×` : '—', md: ok ? fmtX(yours!.mdMst) : '—', ft: ok ? pct(yours!.ft) : '—' };
    for (const k of ['tl', 'md', 'ft'] as const) {
      $(`[data-you="${k}"]`).textContent = youVals[k];
      $(`[data-mold="${k}"]`).textContent = !mold ? (racing ? '…' : '?') : k === 'tl' ? fmtX(mold.tlMst) : k === 'md' ? fmtX(mold.mdMst) : pct(mold.ft);
    }
    const sc = raced && mold && yours ? score(yours, mold) : null;
    const outcomes = { tl: sc?.cost, md: sc?.travel, ft: sc?.robust };
    for (const k of ['tl', 'md', 'ft'] as const) {
      const el = $(`[data-o="${k}"]`);
      el.textContent = outcomes[k] ?? '';
      el.dataset.oKind = outcomes[k] ?? '';
    }
    verdictEl.dataset.kind = sc?.verdict ?? 'none';
    verdictEl.textContent = racing ? 'The mold is growing…' : sc ? verdictText(sc.verdict) : ok ? 'Every town is connected. Race the mold.' : 'Connect every town, then race.';
    // The top readout shows your track.
    metricEls.tl.textContent = youVals.tl;
    metricEls.md.textContent = youVals.md;
    metricEls.ft.textContent = youVals.ft;
    statusEl.textContent = racing ? 'The mold is growing…' : sc ? `${sc.wins} won · ${sc.losses} lost` : `Track ${built.toFixed(2)}× of ${level.budget.toFixed(2)}×`;
    statusEl.dataset.kind = sc?.verdict === 'beat' ? 'settled' : 'growing';
    levelEls.forEach((b, i) => {
      const best = challenge.best[LEVELS[i].id];
      b.dataset.done = String(!!best?.beat);
      if (i === levelAt) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
      b.setAttribute('aria-label', `Level ${i + 1}: ${LEVELS[i].title}${best?.beat ? ', beaten' : best ? ', played' : ''}`);
    });
  }

  for (const b of raceBtns) b.addEventListener('click', race);
  undoBtn.addEventListener('click', () => {
    const prev = undoStack.pop();
    if (!prev) return;
    track = prev;
    trackChanged(false);
    announce('Undone.');
  });
  $('[data-clear-track]').addEventListener('click', () => {
    if (!track.links.length) return;
    undoStack.push(track);
    track = emptyTrack();
    trackChanged(false);
    announce('Track cleared.');
  });
  $('[data-next-level]').addEventListener('click', () => goLevel((levelAt + 1) % LEVELS.length));
  for (const b of levelEls) b.addEventListener('click', () => goLevel(levelIndex(b.dataset.levelBtn)));

  // ------------------------------------------------------------ phone sheet
  type Sheet = 'peek' | 'half' | 'full';
  let sheetState: Sheet = 'peek';
  const sheetY = new Spring(0, 0.38);
  let sheetH = 1;
  let footH = 0;
  let sheetDrag: { id: number; y0: number; v0: number; t: number; vy: number; moved: boolean } | null = null;
  let sheetRaf = 0;

  function snaps(): Record<Sheet, number> {
    const peek = parseFloat(getComputedStyle(root).getPropertyValue('--peek')) * 16 || 140;
    return { full: 0, half: Math.round(sheetH * 0.3), peek: Math.max(0, sheetH - peek) };
  }
  function layoutSheet() {
    sheetH = panel.getBoundingClientRect().height || 1;
    footH = $('[data-foot]').getBoundingClientRect().height;
    sheetY.snap(snaps()[sheetState]);
    applySheet();
  }
  function applySheet() {
    if (!phone()) {
      root.style.removeProperty('--sheet-y');
      root.style.removeProperty('--panes-cover');
      return;
    }
    root.style.setProperty('--sheet-y', `${sheetY.value.toFixed(1)}px`);
    // How far the bottom of the scrolling panes sits below the screen.
    root.style.setProperty('--panes-cover', `${Math.max(0, sheetY.value - footH).toFixed(1)}px`);
  }
  function sheetTo(s: Sheet) {
    sheetState = s;
    root.dataset.sheet = s;
    sheetY.target = snaps()[s];
    if (reduced()) sheetY.snap(sheetY.target);
    animateSheet();
  }
  function animateSheet() {
    if (sheetRaf) return;
    let last = 0;
    const tick = (t: number) => {
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 1 / 60;
      last = t;
      sheetY.step(dt);
      applySheet();
      if (Math.abs(sheetY.value - sheetY.target) > 0.5 || Math.abs(sheetY.velocity) > 5) sheetRaf = requestAnimationFrame(tick);
      else {
        sheetY.snap(sheetY.target);
        applySheet();
        sheetRaf = 0;
      }
    };
    sheetRaf = requestAnimationFrame(tick);
  }
  for (const handle of [$('[data-grab]'), $('[data-head]')]) {
    handle.addEventListener('pointerdown', (e) => {
      if (!phone()) return;
      handle.setPointerCapture(e.pointerId);
      cancelAnimationFrame(sheetRaf);
      sheetRaf = 0;
      sheetDrag = { id: e.pointerId, y0: e.clientY, v0: sheetY.value, t: performance.now(), vy: 0, moved: false };
    });
    handle.addEventListener('pointermove', (e) => {
      if (!sheetDrag || sheetDrag.id !== e.pointerId) return;
      const now = performance.now();
      const y = Math.max(0, Math.min(snaps().peek, sheetDrag.v0 + e.clientY - sheetDrag.y0));
      const dt = Math.max(1, now - sheetDrag.t) / 1000;
      sheetDrag.vy = (y - sheetY.value) / dt;
      sheetDrag.t = now;
      if (Math.abs(e.clientY - sheetDrag.y0) > 4) sheetDrag.moved = true;
      sheetY.snap(y);
      applySheet();
    });
    const end = (e: PointerEvent) => {
      if (!sheetDrag || sheetDrag.id !== e.pointerId) return;
      const { moved, vy } = sheetDrag;
      sheetDrag = null;
      if (!moved) {
        sheetTo(sheetState === 'peek' ? 'half' : 'peek');
        return;
      }
      // Project where the flick would come to rest, then pick the nearest stop.
      const rest = sheetY.value + vy * 0.18;
      const s = snaps();
      const best = (Object.keys(s) as Sheet[]).reduce((a, b) => (Math.abs(s[b] - rest) < Math.abs(s[a] - rest) ? b : a));
      sheetY.velocity = vy;
      sheetTo(best);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------ start
  new ResizeObserver(() => {
    layout();
    layoutSheet();
  }).observe(root);
  layout();
  layoutSheet();
  if (startMode === 'tokyo') setMode('tokyo');
  else if (startMode === 'tour') setMode('tour', hashParams.has('s') ? stepIndex(hashParams.get('s')) : undefined);
  else if (startMode === 'challenge') setMode('challenge', hashParams.has('c') ? levelIndex(hashParams.get('c')) : undefined);
  setRunning(running);
  drawReadout();
  matchMedia(PHONE).addEventListener('change', () => {
    sheetTo('peek');
    layoutSheet();
    layout();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) host.send({ type: 'run', running: false, rate: SPEEDS[speed].rate });
    else {
      sendRun();
      schedule();
    }
  });
  // Debug handle for the preview.
  (window as unknown as { __physarum: unknown }).__physarum = { get state() { return state; }, get scene() { return scene; }, get rect() { return rect; }, renderer: agents.kind, agents, get running() { return running; }, get view() { return view; }, get burst() { return agentBurst; }, get mode() { return mode; }, setMode };
}
