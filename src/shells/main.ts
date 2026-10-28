/**
 * DOM wiring for Raup's Cube (`/shells`): the 3D shell (orbit with inertia, growth from the
 * tip), the W/D/T sliders, the lesson stepper, the cube map, presets, the URL hash and
 * progress in localStorage. The model and geometry live in the DOM-free modules next to this.
 */
import { Spring } from '../grid/spring';
import { getEntry } from './catalog';
import { CubeView } from './cube-view';
import { identifyFromCache, type Identification } from './identify';
import { LESSONS, STEP_KEY, parseProgress, serializeProgress, type Progress } from './lessons';
import { ShellMesh, orbitCamera } from './mesh';
import {
  PRESETS,
  classify,
  clampParams,
  coilKind,
  formatParam,
  fromPos,
  parseParams,
  serializeParams,
  toPos,
  type CoilKind,
  type ParamKey,
  type ShellParams,
} from './model';
import { boundaryPolyline, fromMap, fromStrip, mapPoint, randomEmptyPoint, regionSlices, stripPos } from './morphospace';
import { CanvasShellRenderer, css } from './render-canvas';
import { GLShellRenderer, type RGB, type ShellRenderer } from './render-gl';

const KEYS: ParamKey[] = ['W', 'D', 'T'];
/** Below this W the paired valve would be a mirrored coil, so it is not drawn. */
const PAIR_MIN_W = 30;
const IDLE_YAW = 0.16; // rad/s
const YAW_PER_PX = 0.008;
const PITCH_PER_PX = 0.006;
const PITCH_LIMIT = 1.35;
const FINE = 0.01; // track fraction per arrow key
const COARSE = 0.1; // with Shift
/** The coil chip under the shell: how each whorl meets the last. */
const COIL_TEXT: Record<CoilKind, string> = {
  involute: 'Involute · each whorl swallows the last',
  overlapping: 'Whorls overlap and join',
  loose: 'Loose coil · whorls apart (rare)',
};
const TIER_TEXT = {
  match: 'This is a real shell',
  resembles: 'Closest real shell',
  none: 'No known animal builds this · nearest real shell',
} as const;
const GROW_END = 1.0005; // just past the aperture, so the last row is never cut
/** The amber growing edge spans this many turns (at most 1.2% of the tube). */
const EDGE_TURNS = 0.008;

function loadProgress(): Progress {
  try {
    return parseProgress(localStorage.getItem(STEP_KEY));
  } catch {
    return parseProgress(null);
  }
}

function saveProgress(p: Progress) {
  try {
    localStorage.setItem(STEP_KEY, serializeProgress(p));
  } catch {
    /* storage unavailable: progress lasts for this page */
  }
}

/** A token as 0..1 RGB: accepts `#rrggbb` or `r, g, b`. */
function token(name: string): RGB {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as RGB;
  const [r, g, b] = v.split(',').map((s) => Number.parseFloat(s) / 255);
  return [r || 0, g || 0, b || 0];
}

/** Natural framing: look down on a flat coil, from the side on a spire, square onto a valve. */
const preferredPitch = (p: ShellParams) => (p.W >= PAIR_MIN_W ? 0.2 : p.T < 0.3 ? 1.05 : 0.35);
/** A valve faces −y (it grows from θ < 0 up to the aperture plane y = 0). */
const VALVE_YAW = -Math.PI / 2;

export function mountShells(root: HTMLElement) {
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const reduced = () =>
    document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------ renderer
  const palette = { base: token('--hot'), line: token('--cyan-rgb'), edge: token('--amber-rgb'), bg: token('--bg') };
  const muted = token('--muted');
  const ink2 = token('--ink-2');
  let shellCanvas = $<HTMLCanvasElement>('[data-shell]');
  const forceCanvas = new URLSearchParams(location.search).get('renderer') === 'canvas';
  let renderer: ShellRenderer | null = forceCanvas ? null : GLShellRenderer.create(shellCanvas, palette);
  if (!renderer) {
    if (!forceCanvas) {
      // A canvas that handed out a WebGL context can't give a 2D one.
      const fresh = shellCanvas.cloneNode() as HTMLCanvasElement;
      shellCanvas.replaceWith(fresh);
      shellCanvas = fresh;
    }
    renderer = new CanvasShellRenderer(shellCanvas, palette);
  }
  const shellRenderer = renderer;
  root.dataset.renderer = shellRenderer.kind;
  const mesh = new ShellMesh();

  // ------------------------------------------------------------ state
  let progress = loadProgress();
  const fromHash = parseParams(location.hash);
  const start = fromHash ?? LESSONS[progress.step].target;

  // W springs in log10 space, so it morphs evenly across decades.
  const springs: Record<ParamKey, Spring> = {
    W: new Spring(Math.log10(start.W), 0.6),
    D: new Spring(start.D, 0.6),
    T: new Spring(start.T, 0.6),
  };
  const grow = new Spring(0, 1.6);
  const pitch = new Spring(preferredPitch(start), 0.7);
  const fit = { x: new Spring(0, 0.5), y: new Spring(0, 0.5), z: new Spring(0, 0.5), r: new Spring(1, 0.5) };
  let yaw = -0.6;
  /** While set, the turn eases to this yaw instead of idling (framing a valve). */
  let yawAim: number | null = null;
  let vYaw = reduced() ? 0 : IDLE_YAW;
  let pairOn = false;
  let step = 0;
  let built: string | null = null;
  let dragging: 'orbit' | ParamKey | 'map' | 'strip' | null = null;

  const current = (): ShellParams =>
    clampParams({ W: 10 ** springs.W.value, D: springs.D.value, T: springs.T.value });
  const target = (): ShellParams =>
    clampParams({ W: 10 ** springs.W.target, D: springs.D.target, T: springs.T.target });

  /** Spring toward `p`. `fast` while a finger or the mouse is driving it. */
  function setTarget(p: Partial<ShellParams>, fast = false) {
    const q = clampParams({ ...target(), ...p });
    for (const k of KEYS) {
      const s = springs[k];
      s.response = fast ? 0.12 : 0.6;
      s.target = k === 'W' ? Math.log10(q.W) : q[k];
      if (reduced()) s.snap(s.target);
    }
    syncTargetUi();
    schedule();
  }

  // ------------------------------------------------------------ lessons
  const stepEl = $('[data-step]');
  const titleEl = $('[data-lesson-title]');
  const bodyEl = $('[data-lesson-body]');
  const prevBtn = $<HTMLButtonElement>('[data-prev]');
  const nextBtn = $<HTMLButtonElement>('[data-next]');
  const dots = [...root.querySelectorAll<HTMLButtonElement>('[data-dot]')];
  const live = $('[data-live]');

  function openLesson(i: number, apply = true) {
    step = Math.max(0, Math.min(LESSONS.length - 1, i));
    const l = LESSONS[step];
    stepEl.textContent = String(step + 1);
    titleEl.textContent = l.title;
    bodyEl.textContent = l.body;
    prevBtn.disabled = step === 0;
    nextBtn.hidden = step === LESSONS.length - 1;
    dots.forEach((d, k) => {
      if (k === step) d.setAttribute('aria-current', 'step');
      else d.removeAttribute('aria-current');
      d.classList.toggle('is-seen', k < step);
    });
    root.dataset.focus = l.focus ?? '';
    if (apply) {
      setTarget(l.target);
      frame3d(l.target);
      setPair(!!l.pairValves);
      if (l.regrow) regrow();
    }
    if (l.revealCube) revealCube();
    progress = { ...progress, step };
    saveProgress(progress);
  }

  function goTo(i: number) {
    clearHash();
    openLesson(i);
    live.textContent = `Step ${step + 1} of ${LESSONS.length}: ${LESSONS[step].title}`;
  }

  prevBtn.addEventListener('click', () => goTo(step - 1));
  nextBtn.addEventListener('click', () => goTo(step + 1));
  dots.forEach((d, k) => d.addEventListener('click', () => goTo(k)));

  // ------------------------------------------------------------ view buttons
  const pairBtn = $<HTMLButtonElement>('[data-pair]');
  const touchEl = $('[data-touch]');

  function setPair(on: boolean) {
    pairOn = on;
    pairBtn.setAttribute('aria-pressed', String(on));
    schedule();
  }
  pairBtn.addEventListener('click', () => setPair(!pairOn));

  function regrow() {
    if (reduced()) {
      grow.snap(GROW_END);
    } else {
      grow.snap(0);
      grow.target = GROW_END;
    }
    schedule();
  }
  $('[data-regrow]').addEventListener('click', regrow);

  // ------------------------------------------------------------ sliders
  const ctls = KEYS.map((key) => {
    const el = $(`[data-ctl="${key}"]`);
    return {
      key,
      el,
      track: el.querySelector<HTMLElement>('[data-track]')!,
      thumb: el.querySelector<HTMLElement>('[data-thumb]')!,
      value: el.querySelector<HTMLElement>('[data-value]')!,
      shown: '',
    };
  });

  for (const c of ctls) {
    const posAt = (e: PointerEvent) => {
      const r = c.track.getBoundingClientRect();
      return (e.clientX - r.left) / r.width;
    };
    c.track.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      c.track.setPointerCapture(e.pointerId);
      c.track.classList.add('is-dragging');
      c.thumb.focus({ preventScroll: true });
      dragging = c.key;
      clearLessonFocus();
      setTarget({ [c.key]: fromPos(c.key, posAt(e)) }, true);
    });
    c.track.addEventListener('pointermove', (e) => {
      if (dragging !== c.key) return;
      setTarget({ [c.key]: fromPos(c.key, posAt(e)) }, true);
    });
    const end = () => {
      if (dragging !== c.key) return;
      dragging = null;
      c.track.classList.remove('is-dragging');
      commit();
    };
    c.track.addEventListener('pointerup', end);
    c.track.addEventListener('pointercancel', end);
    c.thumb.addEventListener('keydown', (e) => {
      const pos = toPos(c.key, target()[c.key]);
      const d = e.shiftKey ? COARSE : FINE;
      let next: number | null = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = pos + d;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = pos - d;
      else if (e.key === 'PageUp') next = pos + COARSE;
      else if (e.key === 'PageDown') next = pos - COARSE;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = 1;
      if (next === null) return;
      e.preventDefault();
      setTarget({ [c.key]: fromPos(c.key, next) });
      commit();
    });
  }

  /** The slider a lesson points at stops beckoning once you touch any control. */
  function clearLessonFocus() {
    root.dataset.focus = '';
  }

  /** ARIA, presets and the touch chip follow the target, not the in-flight value. */
  function syncTargetUi() {
    const t = target();
    for (const c of ctls) {
      c.thumb.setAttribute('aria-valuemin', String(c.key === 'W' ? 1 : 0));
      c.thumb.setAttribute('aria-valuemax', c.key === 'W' ? '1000000' : c.key === 'D' ? '0.95' : '4');
      c.thumb.setAttribute('aria-valuenow', String(Number(t[c.key].toPrecision(4))));
      c.thumb.setAttribute('aria-valuetext', formatParam(c.key, t[c.key]));
    }
    for (const b of presetBtns) {
      const p = PRESETS.find((q) => q.id === b.dataset.preset)!;
      const same = KEYS.every((k) => Math.abs(toPos(k, p[k]) - toPos(k, t[k])) < 0.002);
      b.setAttribute('aria-pressed', String(same));
    }
    const kind = coilKind(t);
    touchEl.dataset.state = kind;
    touchEl.textContent = COIL_TEXT[kind];
    pairBtn.hidden = t.W < PAIR_MIN_W;
    syncWhere(t);
    syncStale(t);
  }

  // ------------------------------------------------------------ cube
  const mapWrap = $('[data-map-wrap]');
  const mapCanvas = $<HTMLCanvasElement>('[data-map]');
  const mapCtx = mapCanvas.getContext('2d')!;
  const whereEl = $('[data-where]');
  const presetBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-preset]')];
  const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace';
  const regionColour: Record<string, RGB> = {
    cephalopods: palette.line,
    gastropods: palette.base,
    bivalves: palette.edge,
    brachiopods: ink2,
  };
  let mapSize = { w: 1, h: 1 };

  // The 3D cube is the default view; "Slice" swaps in the flat map for precise dragging.
  const cubeWrap = $('[data-cube-wrap]');
  let viewMode: 'cube' | 'slice' = 'cube';
  const cube = new CubeView(
    $<HTMLCanvasElement>('[data-cube3d]'),
    { line: palette.line, edge: palette.edge, base: palette.base, muted, regions: regionColour },
    mono,
    { onPick: (e) => growEntry(e.id), onChange: () => schedule(), reduced },
  );
  const modeBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-view-mode]')];
  const ledes = [...root.querySelectorAll<HTMLElement>('[data-lede]')];
  for (const b of modeBtns) {
    b.addEventListener('click', () => {
      viewMode = b.dataset.viewMode === 'slice' ? 'slice' : 'cube';
      for (const m of modeBtns) m.setAttribute('aria-pressed', String(m === b));
      for (const l of ledes) l.hidden = l.dataset.lede !== viewMode;
      cubeWrap.hidden = viewMode !== 'cube';
      mapWrap.hidden = viewMode !== 'slice';
      resize();
    });
  }

  function revealCube() {
    root.dataset.cube = 'revealed';
    if (!progress.cubeSeen) {
      progress = { ...progress, cubeSeen: true };
      saveProgress(progress);
    }
    syncWhere(target());
    schedule();
  }
  $('[data-skip]').addEventListener('click', () => {
    revealCube();
    live.textContent = 'Regions where real shells live are now on the map.';
  });

  function syncWhere(t: ShellParams) {
    whereEl.replaceChildren();
    if (root.dataset.cube !== 'revealed') return;
    const r = classify(t);
    const tag = document.createElement('span');
    tag.className = 'where__tag';
    tag.textContent = r ? 'Lives here' : 'Empty';
    whereEl.dataset.state = r ? 'region' : 'empty';
    whereEl.append(tag, r ? `${r.name} (${r.examples})` : 'No known shell lives here.');
  }

  /** Plot rectangle and T strip inside the map canvas, in css px. */
  function mapLayout() {
    const { w, h } = mapSize;
    const left = 34;
    const bottom = h - 24;
    const top = 8;
    const stripX = w - 22;
    const right = stripX - 34;
    return { left, right, top, bottom, stripX, stripTop: top, stripBottom: bottom };
  }

  function drawMap(p: ShellParams) {
    const { w, h } = mapSize;
    const ctx = mapCtx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const L = mapLayout();
    const X = (x: number) => L.left + x * (L.right - L.left);
    const Y = (y: number) => L.bottom - y * (L.bottom - L.top);
    ctx.font = `10px ${mono}`;
    ctx.textBaseline = 'middle';

    // Frame and grid.
    ctx.fillStyle = css(palette.base, 0.025);
    ctx.fillRect(L.left, L.top, L.right - L.left, L.bottom - L.top);
    ctx.strokeStyle = css(palette.base, 0.07);
    ctx.lineWidth = 1;
    ctx.fillStyle = css(muted, 1);
    ctx.textAlign = 'center';
    for (let e = 0; e <= 6; e++) {
      const x = X(mapPoint({ W: Math.max(1.01, 10 ** e), D: 0 })[0]);
      ctx.beginPath();
      ctx.moveTo(x, L.top);
      ctx.lineTo(x, L.bottom);
      ctx.stroke();
      ctx.fillText(e === 0 ? '1' : e === 1 ? '10' : `10${'⁰¹²³⁴⁵⁶'[e]}`, x, L.bottom + 12);
    }
    ctx.textAlign = 'right';
    for (const d of [0, 0.25, 0.5, 0.75]) {
      const y = Y(d / 0.95);
      ctx.beginPath();
      ctx.moveTo(L.left, y);
      ctx.lineTo(L.right, y);
      ctx.stroke();
      ctx.fillText(String(d), L.left - 6, y);
    }
    // Axis names inside the plot corners, clear of the tick labels.
    ctx.fillStyle = css(palette.line, 0.9);
    ctx.textAlign = 'right';
    ctx.fillText('W →', L.right - 6, L.bottom - 9);
    ctx.textAlign = 'left';
    ctx.fillText('↑ D', L.left + 6, L.top + 10);

    // Regions, sliced at the current T.
    if (root.dataset.cube === 'revealed') {
      for (const s of regionSlices(p.T)) {
        const [x0, y0, x1, y1] = s.rect;
        const col = regionColour[s.region.id];
        const rx = X(x0), ry = Y(y1), rw = X(x1) - X(x0), rh = Y(y0) - Y(y1);
        if (s.active) {
          ctx.fillStyle = css(col, 0.16);
          ctx.fillRect(rx, ry, rw, rh);
          ctx.setLineDash([]);
          ctx.strokeStyle = css(col, 0.6);
        } else {
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = css(col, 0.22);
        }
        ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
        ctx.setLineDash([]);
        // Only regions in this T slice are named; the others are outlines.
        if (s.active) {
          ctx.fillStyle = css(col, 0.95);
          ctx.textAlign = 'left';
          ctx.fillText(s.region.name, rx + 5, ry + 10);
        }
      }
    }

    // Where whorls stop touching, for this T.
    ctx.strokeStyle = css(palette.edge, 0.85);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    boundaryPolyline(p.T).forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.stroke();

    // The current shell.
    const [px, py] = mapPoint(p);
    const cx = X(px), cy = Y(py);
    ctx.strokeStyle = css(palette.line, 0.25);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, L.top);
    ctx.lineTo(cx, L.bottom);
    ctx.moveTo(L.left, cy);
    ctx.lineTo(L.right, cy);
    ctx.stroke();
    dot(ctx, cx, cy);

    // T strip.
    const sy = (t: number) => L.stripBottom - stripPos(t) * (L.stripBottom - L.stripTop);
    ctx.strokeStyle = css(palette.base, 0.14);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(L.stripX, L.stripTop);
    ctx.lineTo(L.stripX, L.stripBottom);
    ctx.stroke();
    ctx.strokeStyle = css(palette.line, 0.7);
    ctx.beginPath();
    ctx.moveTo(L.stripX, L.stripBottom);
    ctx.lineTo(L.stripX, sy(p.T));
    ctx.stroke();
    ctx.fillStyle = css(muted, 1);
    ctx.textAlign = 'right';
    for (const t of [0, 1, 2, 3, 4]) ctx.fillText(String(t), L.stripX - 8, sy(t));
    ctx.fillStyle = css(palette.line, 0.9);
    ctx.textAlign = 'center';
    ctx.fillText('T', L.stripX, L.bottom + 12);
    dot(ctx, L.stripX, sy(p.T));
  }

  function dot(ctx: CanvasRenderingContext2D, x: number, y: number) {
    ctx.fillStyle = css(palette.line, 0.18);
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = css(palette.line, 1);
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }

  mapCanvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    mapCanvas.setPointerCapture(e.pointerId);
    const r = mapCanvas.getBoundingClientRect();
    dragging = e.clientX - r.left > mapLayout().right + 12 ? 'strip' : 'map';
    clearLessonFocus();
    mapDrag(e);
  });
  mapCanvas.addEventListener('pointermove', (e) => {
    if (dragging === 'map' || dragging === 'strip') mapDrag(e);
  });
  const mapEnd = () => {
    if (dragging !== 'map' && dragging !== 'strip') return;
    dragging = null;
    commit();
  };
  mapCanvas.addEventListener('pointerup', mapEnd);
  mapCanvas.addEventListener('pointercancel', mapEnd);

  function mapDrag(e: PointerEvent) {
    const r = mapCanvas.getBoundingClientRect();
    const L = mapLayout();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (dragging === 'strip') {
      setTarget({ T: fromStrip((L.stripBottom - y) / (L.stripBottom - L.stripTop)) }, true);
    } else {
      setTarget(fromMap((x - L.left) / (L.right - L.left), (L.bottom - y) / (L.bottom - L.top)), true);
    }
  }

  for (const b of presetBtns) {
    b.addEventListener('click', () => {
      const p = PRESETS.find((q) => q.id === b.dataset.preset)!;
      jump(p, p.name, p.W >= PAIR_MIN_W);
    });
  }

  let seed = (Date.now() & 0xffff) + 1;
  $('[data-random]').addEventListener('click', () => {
    revealCube();
    jump(randomEmptyPoint(seed++), 'A shell no animal has built', false);
  });

  /** Presets and the random shell: spring there, reframe, regrow, announce. */
  function jump(p: ShellParams, name: string, pair: boolean) {
    clearLessonFocus();
    setTarget(p);
    frame3d(p);
    setPair(pair);
    regrow();
    commit(name);
  }

  // ------------------------------------------------------------ identify
  const identifyBtn = $<HTMLButtonElement>('[data-identify]');
  const resultEl = $('[data-result]');
  const tierEl = $('[data-tier]');
  const noteEl = $('[data-note]');
  const entryEls = [...root.querySelectorAll<HTMLElement>('[data-entry]')];
  const alsoBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-also]')];
  const cardIn = new Spring(1, 0.35);
  /** The shell the open card describes, as a hash string; null while no card is open. */
  let identified: string | null = null;

  function identify() {
    const t = target();
    const result = identifyFromCache(t);
    identified = serializeParams(t);
    showResult(result, TIER_TEXT[result.tier]);
    noteEl.hidden = coilKind(t) === 'loose';
    const lead = result.tier === 'none' ? 'No known animal builds this. Nearest real shell' : TIER_TEXT[result.tier];
    live.textContent = `${lead}: ${result.entry.name}, ${result.entry.latin}.`;
  }

  /** Open the card for `result.entry`, with its runners-up as chips. */
  function showResult(result: Pick<Identification, 'entry' | 'runnersUp'> & { tier?: Identification['tier'] }, tierText: string) {
    const wasHidden = resultEl.hidden;
    resultEl.hidden = false;
    resultEl.classList.remove('is-stale');
    tierEl.textContent = tierText;
    tierEl.dataset.tier = result.tier ?? 'resembles';
    for (const el of entryEls) el.hidden = el.dataset.entry !== result.entry.id;
    const also = result.runnersUp.map((e) => e.id);
    for (const b of alsoBtns) {
      const k = also.indexOf(b.dataset.also!);
      b.hidden = k < 0;
      b.style.order = String(k);
    }
    if (wasHidden) {
      if (reduced()) cardIn.snap(1);
      else {
        cardIn.snap(0);
        cardIn.target = 1;
      }
      resultEl.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    }
    schedule();
  }

  /** The card dims once the shell no longer matches what it describes. */
  function syncStale(t: ShellParams) {
    if (identified === null) return;
    resultEl.classList.toggle('is-stale', serializeParams(t) !== identified);
  }

  identifyBtn.addEventListener('click', identify);

  /** Spring to a real shell and open its card (now an exact match, so the card says so). */
  function growEntry(id: string) {
    const e = getEntry(id)!;
    jump(e, e.name, e.W >= PAIR_MIN_W);
    identify();
  }

  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-grow]')) {
    b.addEventListener('click', () => growEntry(b.dataset.grow!));
  }

  // A runner-up opens its own card; the shell stays as it is until "Grow the real one".
  for (const b of alsoBtns) {
    b.addEventListener('click', () => {
      const e = getEntry(b.dataset.also!)!;
      const r = identifyFromCache(target());
      const runnersUp = [r.entry, ...r.runnersUp].filter((x) => x.id !== e.id).slice(0, 2);
      showResult({ entry: e, runnersUp }, 'Also close');
      live.textContent = `Also close: ${e.name}, ${e.latin}.`;
    });
  }

  /** Tilt for the shell's kind, and turn a valve to face the camera. */
  function frame3d(p: ShellParams) {
    pitch.target = preferredPitch(p);
    if (p.W >= PAIR_MIN_W) {
      // The nearest equivalent of VALVE_YAW, so it never spins the long way round.
      yawAim = VALVE_YAW + Math.round((yaw - VALVE_YAW) / (2 * Math.PI)) * 2 * Math.PI;
    } else {
      yawAim = null;
    }
    if (reduced()) {
      pitch.snap(pitch.target);
      if (yawAim !== null) yaw = yawAim;
      yawAim = null;
    }
  }

  // ------------------------------------------------------------ hash and announcements
  let hashTimer = 0;
  function commit(name?: string) {
    const t = target();
    const r = classify(t);
    const where = root.dataset.cube === 'revealed' ? (r ? ` ${r.name}.` : ' Empty morphospace.') : '';
    live.textContent = `${name ? `${name}. ` : ''}W ${formatParam('W', t.W)}, D ${formatParam('D', t.D)}, T ${formatParam('T', t.T)}.${where}`;
    clearTimeout(hashTimer);
    hashTimer = window.setTimeout(() => {
      history.replaceState(null, '', `${location.pathname}${location.search}#${serializeParams(target())}`);
    }, 250);
  }

  function clearHash() {
    clearTimeout(hashTimer);
    if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  }

  // ------------------------------------------------------------ orbit
  let last = { x: 0, y: 0, t: 0 };
  let flick = 0; // rad/s, smoothed while dragging
  shellCanvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    shellCanvas.setPointerCapture(e.pointerId);
    dragging = 'orbit';
    vYaw = 0;
    yawAim = null;
    flick = 0;
    last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    schedule();
  });
  shellCanvas.addEventListener('pointermove', (e) => {
    if (dragging !== 'orbit') return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    const dt = Math.max(1, e.timeStamp - last.t) / 1000;
    yaw -= dx * YAW_PER_PX;
    // Vertical drags tilt with a mouse; on touch they scroll the page (touch-action: pan-y).
    pitch.snap(Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch.value + dy * PITCH_PER_PX)));
    flick = flick * 0.6 + ((-dx * YAW_PER_PX) / dt) * 0.4;
    last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    schedule();
  });
  const orbitEnd = (e: PointerEvent) => {
    if (dragging !== 'orbit') return;
    dragging = null;
    // A pause before letting go means no flick; the idle turn then eases back in.
    const stale = e.timeStamp - last.t > 80;
    vYaw = reduced() || stale ? 0 : Math.max(-6, Math.min(6, flick));
    schedule();
  };
  shellCanvas.addEventListener('pointerup', orbitEnd);
  shellCanvas.addEventListener('pointercancel', orbitEnd);

  // ------------------------------------------------------------ frame loop
  let view = { w: 1, h: 1 };
  let dpr = 1;
  let raf = 0;
  let lastFrame = 0;
  let visible = true;
  let firstBuild = true;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vr = shellCanvas.getBoundingClientRect();
    view = { w: Math.max(1, vr.width), h: Math.max(1, vr.height) };
    shellRenderer.resize(view.w, view.h, dpr);
    if (viewMode === 'slice') {
      const mr = mapWrap.getBoundingClientRect();
      mapSize = { w: Math.max(1, mr.width), h: Math.max(1, mr.height) };
      mapCanvas.width = Math.round(mapSize.w * dpr);
      mapCanvas.height = Math.round(mapSize.h * dpr);
    } else {
      const cr = cubeWrap.getBoundingClientRect();
      cube.resize(cr.width, cr.height, dpr);
    }
    schedule();
  }

  // With motion the shell always turns slowly, so the loop runs while the page is on screen.
  // Reduced motion draws one frame per change.
  const moving = () => !reduced() || dragging === 'orbit';

  function schedule() {
    if (!raf && visible) raf = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    raf = 0;
    const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
    lastFrame = now;
    const still = reduced();
    for (const s of [...KEYS.map((k) => springs[k]), grow, pitch, cardIn, ...Object.values(fit)]) {
      if (still) s.snap(s.target);
      else s.step(dt);
    }
    if (still) {
      vYaw = 0;
    } else if (dragging !== 'orbit' && yawAim !== null) {
      yaw += (yawAim - yaw) * (1 - Math.exp(-dt / 0.35));
      if (Math.abs(yawAim - yaw) < 0.005) {
        yawAim = null;
        vYaw = 0; // the idle turn eases back in from rest
      }
    } else if (dragging !== 'orbit') {
      yaw += vYaw * dt;
      vYaw += (IDLE_YAW - vYaw) * (1 - Math.exp(-dt / 1.2));
    }
    if (viewMode === 'cube') cube.step(dt);
    render();
    if (moving()) schedule();
    else lastFrame = 0;
  }

  function render() {
    const p = current();
    const paired = pairOn && p.W >= PAIR_MIN_W;
    const key = `${p.W}|${p.D}|${p.T}|${paired}`;
    if (key !== built) {
      built = key;
      mesh.build(p, paired);
      shellRenderer.upload(mesh);
      const { centre, radius } = mesh.bounds;
      fit.x.target = centre[0];
      fit.y.target = centre[1];
      fit.z.target = centre[2];
      fit.r.target = radius;
      if (firstBuild || reduced()) {
        for (const s of Object.values(fit)) s.snap(s.target);
        firstBuild = false;
      }
    }

    for (const c of ctls) {
      const v = p[c.key];
      c.el.style.setProperty('--pos', toPos(c.key, v).toFixed(4));
      const text = formatParam(c.key, v);
      if (text !== c.shown) c.value.textContent = c.shown = text;
    }

    const camera = orbitCamera([fit.x.value, fit.y.value, fit.z.value], Math.max(1e-6, fit.r.value), yaw, pitch.value, view.w / view.h);
    const edge = Math.min(0.012, Math.max(0.0025, EDGE_TURNS / Math.max(mesh.whorls, 0.01)));
    shellRenderer.draw({ camera, grow: Math.min(grow.value, GROW_END), edge, paired });
    if (viewMode === 'cube') cube.draw(p, root.dataset.cube === 'revealed');
    else drawMap(p);
    resultEl.style.setProperty('--in', cardIn.value.toFixed(3));
  }

  // ------------------------------------------------------------ start
  if (progress.cubeSeen) root.dataset.cube = 'revealed';
  openLesson(fromHash ? LESSONS.length - 1 : progress.step, !fromHash);
  if (fromHash) {
    frame3d(fromHash);
    setPair(fromHash.W >= PAIR_MIN_W);
  }
  // The first frame starts framed: no spring in from defaults.
  for (const k of KEYS) springs[k].snap(springs[k].target);
  pitch.snap(pitch.target);
  if (yawAim !== null) yaw = yawAim;
  yawAim = null;
  syncTargetUi();
  regrow();

  new ResizeObserver(resize).observe(root);
  resize();
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) schedule();
    else {
      cancelAnimationFrame(raf);
      raf = 0;
      lastFrame = 0;
    }
  }).observe(root);
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
    vYaw = reduced() ? 0 : IDLE_YAW;
    schedule();
  });
}
