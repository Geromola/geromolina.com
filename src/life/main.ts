/**
 * DOM wiring for Conway's Life (`/life`): the board (draw, stamp, pan, pinch, wheel zoom,
 * keyboard cursor), the transport dock, the readout (generation, population chart, status),
 * the tour, the library, the Signals series with its receiver lamps, the phone bottom sheet,
 * the URL hash and tour progress in localStorage. Life itself lives in the DOM-free modules.
 */
import { Spring } from '../grid/spring';
import { Detector, speed as speedText, type Status } from './detect';
import { LifeBoard, type Rect } from './engine';
import { getEntry, patternOf } from './patterns';
import { CanvasLifeRenderer, css } from './render-canvas';
import { GLLifeRenderer, type LifeRenderer, type Palette, type RGB } from './render-gl';
import { normalize, parseRLE, toRLE, transform, type Cell, type Pattern } from './rle';
import { ReceiverReader, cleanText, decodeBits, getScene, place, type Label } from './scenes';
import { TOUR, TOUR_KEY, parseProgress, serializeProgress, type Progress } from './tour';
import { clampScale, fit, screenToCell, zoomAt, cellToScreen, type Camera, type Insets } from './view';

const SPEEDS = [1, 2, 4, 8, 15, 30, 60, Infinity];
const HISTORY = 240;
const MAX_UNDO = 40;
/** Time per frame spent stepping at Max speed. */
const BUDGET_MS = 9;
/** At most this many generations per frame at a fixed speed (a long hidden tab catches up slowly). */
const MAX_STEPS = 60;
const SOUP = 64;
const SOUP_DENSITY = 0.37;
const MAX_HASH_CELLS = 3000;
const PHONE = '(max-width: 899px)';

function token(name: string): RGB {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as RGB;
  const [r, g, b] = v.split(',').map((s) => Number.parseFloat(s) / 255);
  return [r || 0, g || 0, b || 0];
}

function loadProgress(): Progress {
  try {
    return parseProgress(localStorage.getItem(TOUR_KEY));
  } catch {
    return parseProgress(null);
  }
}

function saveProgress(p: Progress) {
  try {
    localStorage.setItem(TOUR_KEY, serializeProgress(p));
  } catch {
    // Storage blocked: the tour still works, it just starts at step 1 next time.
  }
}

const union = (a: Rect | null, b: Rect | null): Rect | null =>
  !a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };

function statusText(s: Status): string {
  switch (s.kind) {
    case 'empty':
      return 'Empty';
    case 'still':
      return 'Still life';
    case 'oscillator':
      return `Oscillator · p${s.period}`;
    case 'spaceship':
      return `Spaceship · ${speedText(s.period, s.dx, s.dy)}`;
    case 'output':
      return `Steady stream · p${s.period}`;
    case 'new':
      return 'Ready';
    default:
      return 'Evolving';
  }
}

export function mountLife(root: HTMLElement) {
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const $$ = <T extends Element = HTMLElement>(sel: string) => [...root.querySelectorAll<T>(sel)];
  const reduced = () =>
    document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const phone = () => matchMedia(PHONE).matches;

  // ------------------------------------------------------------ board and renderer
  const board = new LifeBoard(1024);
  board.trails = !reduced();
  const detector = new Detector();
  const overlay = new Uint8Array(board.w * board.h);
  let overlayRect: Rect | null = null;

  const palette: Palette = {
    live: token('--cyan-rgb'),
    hot: token('--hot'),
    trail: token('--amber-rgb'),
    bg: token('--bg'),
    grid: matchMedia('(prefers-contrast: more)').matches ? token('--ink-2') : token('--muted'),
  };
  let canvas = $<HTMLCanvasElement>('[data-canvas]');
  const forceCanvas = new URLSearchParams(location.search).get('renderer') === 'canvas';
  let made: LifeRenderer | null = forceCanvas ? null : GLLifeRenderer.create(canvas, board, palette);
  if (!made) {
    if (!forceCanvas) {
      // A canvas that handed out a WebGL context can't give a 2D one.
      const fresh = canvas.cloneNode() as HTMLCanvasElement;
      canvas.replaceWith(fresh);
      canvas = fresh;
    }
    made = new CanvasLifeRenderer(canvas, board, palette);
  }
  const renderer = made;
  root.dataset.renderer = renderer.kind;

  // ------------------------------------------------------------ elements
  const genEl = $('[data-gen]');
  const popEl = $('[data-pop]');
  const statusEl = $('[data-status]');
  const chart = $<HTMLCanvasElement>('[data-chart]');
  const chartCtx = chart.getContext('2d')!;
  const labelsEl = $('[data-labels]');
  const tipEl = $('[data-tip]');
  const liveEl = $('[data-live]');
  const playBtn = $<HTMLButtonElement>('[data-play]');
  const stepBtn = $<HTMLButtonElement>('[data-step]');
  const speedIn = $<HTMLInputElement>('[data-speed]');
  const speedLabel = $('[data-speed-label]');
  const previewBtn = $<HTMLButtonElement>('[data-preview]');
  const undoBtn = $<HTMLButtonElement>('[data-undo]');
  const stampEl = $('[data-stamp]');
  const stampName = $('[data-stamp-name]');
  const panel = $('[data-panel]');
  const panes = $('[data-panes]');
  const dock = $('[data-dock]');
  const readout = $('[data-readout]');
  const clauses = $$('[data-clause]');

  // ------------------------------------------------------------ camera
  let W = 1,
    H = 1;
  let cam: Camera = { cx: board.w / 2, cy: board.h / 2, scale: 12 };
  // Programmatic moves (fit a scene, keyboard zoom) spring; gestures follow 1:1.
  const camX = new Spring(cam.cx, 0.55);
  const camY = new Spring(cam.cy, 0.55);
  const camS = new Spring(Math.log(cam.scale), 0.55);
  let camMoving = false;

  function moveCamera(to: Camera, animate = true) {
    to = { ...to, scale: clampScale(to.scale) };
    if (!animate || reduced()) {
      cam = to;
      camX.snap(to.cx);
      camY.snap(to.cy);
      camS.snap(Math.log(to.scale));
      camMoving = false;
    } else {
      camX.target = to.cx;
      camY.target = to.cy;
      camS.target = Math.log(to.scale);
      camMoving = true;
    }
    schedule();
  }

  /** A gesture takes over: stop any spring where it is. */
  function holdCamera() {
    camMoving = false;
    camX.snap(cam.cx);
    camY.snap(cam.cy);
    camS.snap(Math.log(cam.scale));
  }

  function setCam(c: Camera) {
    cam = { ...c, scale: clampScale(c.scale) };
    holdCamera();
    schedule();
  }

  /** Screen area the chrome leaves free, for fitting a scene. */
  function insets(): Insets {
    const box = canvas.getBoundingClientRect();
    const r = readout.getBoundingClientRect();
    const d = dock.getBoundingClientRect();
    const top = r.bottom - box.top + 12;
    if (phone()) return { top, right: 12, left: 12, bottom: H - (d.top - box.top) + 12 };
    const p = panel.getBoundingClientRect();
    return { top, left: 16, right: W - (p.left - box.left) + 16, bottom: H - (d.top - box.top) + 12 };
  }

  // ------------------------------------------------------------ state
  let running = false;
  let speedIdx = 4;
  let acc = 0;
  let previewOn = false;
  let previewDirty = true;
  let tool: 'draw' | 'move' = 'draw';
  let stamp: { id: string; base: Pattern; rot: number; flip: boolean; p: Pattern } | null = null;
  let ghostAt: [number, number] | null = null;
  let cursor: [number, number] | null = null;
  let pops: number[] = [];
  const undo: { cells: Uint32Array; gen: number }[] = [];
  let scene: { id: string; labels: Label[] } | null = null;
  let receiver: ReceiverReader | null = null;
  let progress = loadProgress();
  let readoutDirty = true;
  let labelEls: HTMLElement[] = [];

  // ------------------------------------------------------------ transport
  function setRunning(on: boolean) {
    running = on;
    playBtn.setAttribute('aria-pressed', String(on));
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    stepBtn.disabled = on;
    acc = 0;
    previewDirty = true;
    if (on) hideTip();
    schedule();
  }

  function setSpeed(i: number) {
    speedIdx = Math.max(0, Math.min(SPEEDS.length - 1, i));
    speedIn.value = String(speedIdx);
    const v = SPEEDS[speedIdx];
    const text = v === Infinity ? 'Max' : `${v}/s`;
    speedLabel.textContent = text;
    speedIn.setAttribute('aria-valuetext', v === Infinity ? 'As fast as possible' : `${v} per second`);
  }

  const nearestSpeed = (v: number) => {
    let best = 0;
    SPEEDS.forEach((s, i) => {
      if (Math.abs(Math.log(s === Infinity ? 240 : s) - Math.log(v)) < Math.abs(Math.log(SPEEDS[best]) - Math.log(v))) best = i;
    });
    return best;
  };

  function stepOnce() {
    board.step();
    detector.observe(board);
    if (receiver) {
      const j = receiver.observe(board);
      if (j >= 0) showBit(j);
    }
    pops.push(board.population);
    if (pops.length > HISTORY) pops.shift();
    readoutDirty = true;
    previewDirty = true;
  }

  // ------------------------------------------------------------ editing
  function pushUndo() {
    undo.push({ cells: board.snapshot(), gen: board.generation });
    if (undo.length > MAX_UNDO) undo.shift();
    undoBtn.disabled = false;
  }

  function edited(writeUrl = true) {
    detector.reset();
    detector.observe(board);
    pops.push(board.population);
    if (pops.length > HISTORY) pops.shift();
    readoutDirty = true;
    previewDirty = true;
    if (writeUrl) scheduleHash();
    schedule();
  }

  function forgetScene() {
    scene = null;
    receiver = null;
    renderLabels([]);
    markCurrent(null);
  }

  function paintLine(x0: number, y0: number, x1: number, y1: number, alive: boolean) {
    // Bresenham, so a fast drag leaves no gaps.
    const dx = Math.abs(x1 - x0),
      dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1,
      sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      board.set(x0, y0, alive);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  function stampAt(x: number, y: number) {
    if (!stamp) return;
    pushUndo();
    const ox = x - (stamp.p.w >> 1),
      oy = y - (stamp.p.h >> 1);
    for (const [cx, cy] of stamp.p.cells) board.set(ox + cx, oy + cy, true);
    edited();
    announce(`Placed ${getEntry(stamp.id)?.name ?? 'pattern'}`);
  }

  function setStamp(id: string | null) {
    if (!id) {
      stamp = null;
      ghostAt = null;
      stampEl.hidden = true;
      previewDirty = true;
      schedule();
      return;
    }
    const base = patternOf(id);
    stamp = { id, base, rot: 0, flip: false, p: base };
    stampName.textContent = getEntry(id)?.name ?? id;
    stampEl.hidden = false;
    setTool('draw');
    if (phone()) sheetTo('peek');
    announce(`Stamp ${getEntry(id)?.name}: tap the board to place it. R rotates, F flips, Escape stops.`);
  }

  function turnStamp(rot: number, flip: boolean) {
    if (!stamp) return;
    stamp.rot = (stamp.rot + rot) % 4;
    stamp.flip = stamp.flip !== flip;
    stamp.p = transform(stamp.base, stamp.rot, stamp.flip);
    previewDirty = true;
    schedule();
  }

  function setTool(t: 'draw' | 'move') {
    tool = t;
    root.dataset.tool = t;
    for (const b of $$<HTMLButtonElement>('[data-tool-btn]')) b.setAttribute('aria-pressed', String(b.dataset.toolBtn === t));
  }

  function setPreview(on: boolean) {
    previewOn = on;
    previewBtn.setAttribute('aria-pressed', String(on));
    previewDirty = true;
    schedule();
  }

  // ------------------------------------------------------------ scenes
  function load(id: string, arg?: string, opts: { play?: boolean; url?: boolean; room?: number } = {}) {
    const def = getScene(id);
    if (!def) return;
    if (board.population) pushUndo();
    setStamp(null);
    // Every scene starts from `clear()`, which marks the whole board for upload.
    const info = def.build(board, arg);
    board.trails = !reduced();
    scene = { id, labels: info.labels };
    receiver = info.receiver ? new ReceiverReader(info.receiver) : null;
    resetSignalsUi(id);
    renderLabels(info.labels);
    detector.reset();
    detector.observe(board);
    pops = [board.population];
    readoutDirty = true;
    previewDirty = true;
    setSpeed(nearestSpeed(info.speed));
    moveCamera(fit(info.focus, opts.room ?? info.room, W, H, insets()));
    markCurrent(id);
    if (opts.url !== false) writeHash(id === 'message' ? `msg=${encodeURIComponent(cleanText(arg ?? ''))}` : `p=${id}`);
    setRunning(!!opts.play && !reduced());
    const name = getEntry(id)?.name;
    if (name) announce(`Loaded ${name}`);
  }

  function markCurrent(id: string | null) {
    for (const c of $$('[data-entry]')) c.classList.toggle('is-current', c.dataset.entry === id);
    for (const s of $$('[data-sig]')) {
      const on = s.dataset.sig === id;
      s.classList.toggle('is-current', on);
      // Keep the running signal's card (its truth table or lamps) in view.
      if (on && !s.closest<HTMLElement>('[data-pane]')!.hidden && !phone()) s.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    }
  }

  function soup() {
    pushUndo();
    forgetScene();
    board.clear();
    const [cx, cy] = [Math.round(cam.cx), Math.round(cam.cy)];
    for (let y = 0; y < SOUP; y++)
      for (let x = 0; x < SOUP; x++) if (Math.random() < SOUP_DENSITY) board.set(cx - SOUP / 2 + x, cy - SOUP / 2 + y, true);
    pops = [];
    edited();
    moveCamera(fit({ x0: cx - SOUP / 2, y0: cy - SOUP / 2, x1: cx + SOUP / 2, y1: cy + SOUP / 2 }, 40, W, H, insets()));
    setSpeed(5);
    setRunning(!reduced());
    announce('Random soup');
  }

  // ------------------------------------------------------------ labels (scene annotations)
  function renderLabels(labels: Label[]) {
    labelsEl.replaceChildren();
    labelEls = labels.map((l) => {
      const el = document.createElement('span');
      el.className = 'label';
      el.textContent = l.text;
      labelsEl.append(el);
      return el;
    });
  }

  function placeLabels() {
    if (!scene) return;
    const show = cam.scale >= 2.5;
    labelsEl.hidden = !show;
    if (!show) return;
    scene.labels.forEach((l, i) => {
      const [x, y] = cellToScreen(cam, W, H, l.x, l.y);
      labelEls[i].style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    });
  }

  // ------------------------------------------------------------ signals UI
  const lamps = $$('[data-lamp]');
  const bytes = $$('[data-byte]');
  const chars = $$('[data-char]');
  const truthIn = $$('[data-in]');
  const truthOut = $$('[data-out]');
  const gotEl = $('[data-got]');

  function resetSignalsUi(id: string) {
    const rx = receiver?.rx;
    if (id === 'message' && rx) {
      const n = rx.bits / 8;
      bytes.forEach((b, i) => (b.hidden = i >= n));
      lamps.forEach((l) => delete l.dataset.v);
      chars.forEach((c) => (c.textContent = ''));
      gotEl.textContent = 'Waiting for the first bit…';
    }
    if (id === 'not-gate' && rx?.data) {
      truthIn.forEach((td, j) => {
        td.textContent = rx.data![j] ? '1' : '0';
        td.dataset.v = rx.data![j] ? '1' : '0';
      });
      truthOut.forEach((td) => {
        td.textContent = '';
        delete td.dataset.v;
      });
    }
  }

  function showBit(j: number) {
    if (!receiver || !scene) return;
    const v = receiver.bits[j] ? '1' : '0';
    if (scene.id === 'message') {
      lamps[j].dataset.v = v;
      if ((j + 1) % 8 === 0) {
        const c = (j + 1) / 8 - 1;
        const text = decodeBits(receiver.bits.slice(c * 8, c * 8 + 8));
        chars[c].textContent = text === ' ' ? '␣' : text;
        const got = decodeBits(receiver.bits);
        gotEl.textContent = receiver.done ? `Received “${got}” in ${board.generation} generations.` : `Received so far: ${got}`;
        announce(receiver.done ? `Message received: ${got}` : `Received ${text}`);
      }
    } else if (scene.id === 'not-gate' && j < truthOut.length) {
      truthOut[j].textContent = v;
      truthOut[j].dataset.v = v;
    }
  }

  // ------------------------------------------------------------ overlay (preview and stamp ghost)
  function refreshOverlay() {
    if (!previewDirty) return;
    previewDirty = false;
    const old = overlayRect;
    if (old)
      for (let y = old.y0; y < old.y1; y++) overlay.fill(0, y * board.w + old.x0, y * board.w + old.x1);
    let r: Rect | null = null;
    if (!running && previewOn) r = board.preview(overlay);
    if (stamp && ghostAt) {
      const ox = ghostAt[0] - (stamp.p.w >> 1),
        oy = ghostAt[1] - (stamp.p.h >> 1);
      for (const [cx, cy] of stamp.p.cells) {
        const x = ox + cx,
          y = oy + cy;
        if (board.inside(x, y)) overlay[y * board.w + x] = 3;
      }
      r = union(r, {
        x0: Math.max(0, ox),
        y0: Math.max(0, oy),
        x1: Math.min(board.w, ox + stamp.p.w),
        y1: Math.min(board.h, oy + stamp.p.h),
      });
    }
    const up = union(old, r);
    if (up) renderer.uploadOverlay(overlay, up);
    overlayRect = r;
  }

  // ------------------------------------------------------------ readout
  let lastStatus = '';
  let lastAnnounced = 0;
  function drawReadout() {
    if (!readoutDirty) return;
    readoutDirty = false;
    genEl.textContent = board.generation.toLocaleString('en-US');
    popEl.textContent = board.population.toLocaleString('en-US');
    const s = detector.status;
    const text = statusText(s);
    if (text !== lastStatus) {
      statusEl.textContent = text;
      statusEl.dataset.kind = s.kind;
      lastStatus = text;
      const now = performance.now();
      if (s.kind !== 'evolving' && now - lastAnnounced > 2000) {
        lastAnnounced = now;
        announce(text);
      }
    }
    // Population chart.
    const dpr = Math.min(2, devicePixelRatio || 1);
    const cw = chart.clientWidth,
      ch = chart.clientHeight;
    if (chart.width !== Math.round(cw * dpr)) {
      chart.width = Math.round(cw * dpr);
      chart.height = Math.round(ch * dpr);
    }
    chartCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    chartCtx.clearRect(0, 0, cw, ch);
    chartCtx.fillStyle = css(palette.grid, 0.08);
    chartCtx.fillRect(0, 0, cw, ch);
    if (pops.length > 1) {
      const max = Math.max(4, ...pops);
      const n = HISTORY - 1;
      const x0 = cw - ((pops.length - 1) / n) * cw;
      chartCtx.beginPath();
      pops.forEach((p, i) => {
        const x = x0 + (i / n) * cw,
          y = ch - 2 - (p / max) * (ch - 4);
        if (i) chartCtx.lineTo(x, y);
        else chartCtx.moveTo(x, y);
      });
      chartCtx.strokeStyle = css(palette.live);
      chartCtx.lineWidth = 1.25;
      chartCtx.stroke();
      chartCtx.lineTo(cw, ch);
      chartCtx.lineTo(x0, ch);
      chartCtx.closePath();
      chartCtx.fillStyle = css(palette.live, 0.12);
      chartCtx.fill();
    }
  }

  function announce(text: string) {
    liveEl.textContent = text;
  }

  // ------------------------------------------------------------ loop
  let raf = 0;
  let lastT = 0;
  function schedule() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame(t: number) {
    raf = 0;
    const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 1 / 60;
    lastT = t;
    if (camMoving) {
      cam = { cx: camX.step(dt), cy: camY.step(dt), scale: Math.exp(camS.step(dt)) };
      const settled =
        Math.abs(camX.value - camX.target) < 0.01 && Math.abs(camY.value - camY.target) < 0.01 && Math.abs(camS.value - camS.target) < 0.001;
      if (settled && Math.abs(camX.velocity) + Math.abs(camY.velocity) < 0.05) {
        cam = { cx: camX.target, cy: camY.target, scale: Math.exp(camS.target) };
        camMoving = false;
      }
    }
    if (running) {
      const v = SPEEDS[speedIdx];
      if (v === Infinity) {
        const end = performance.now() + BUDGET_MS;
        do stepOnce();
        while (performance.now() < end);
      } else {
        acc += dt * v;
        let n = Math.min(MAX_STEPS, Math.floor(acc));
        acc -= Math.floor(acc);
        while (n-- > 0) stepOnce();
      }
    }
    const fading = board.dirty() !== null;
    renderer.upload(board);
    refreshOverlay();
    renderer.draw({ camera: cam, cursor });
    placeLabels();
    drawReadout();
    if (running || camMoving || fading) raf = requestAnimationFrame(frame);
    else lastT = 0;
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width);
    H = Math.max(1, r.height);
    renderer.resize(W, H, Math.min(2, devicePixelRatio || 1));
    layoutSheet();
    readoutDirty = true;
    schedule();
  }

  // ------------------------------------------------------------ pointer on the board
  const pointers = new Map<number, { x: number; y: number }>();
  let mode: 'idle' | 'draw' | 'pan' | 'pinch' = 'idle';
  let paint = true;
  let lastCell: [number, number] = [0, 0];
  let strokeUndo = false;
  let panStart = { x: 0, y: 0, cam };
  let pinchStart = { d: 1, cam, cell: [0, 0] as [number, number] };

  const local = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const cellAt = (x: number, y: number): [number, number] => {
    const [cx, cy] = screenToCell(cam, W, H, x, y);
    return [Math.floor(cx), Math.floor(cy)];
  };

  function startPinch() {
    const [a, b] = [...pointers.values()];
    const mx = (a.x + b.x) / 2,
      my = (a.y + b.y) / 2;
    const [cx, cy] = screenToCell(cam, W, H, mx, my);
    pinchStart = { d: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), cam, cell: [cx, cy] };
    mode = 'pinch';
  }

  canvas.addEventListener('pointerdown', (e) => {
    const p = local(e);
    pointers.set(e.pointerId, p);
    canvas.setPointerCapture(e.pointerId);
    holdCamera();
    hideTip();
    if (pointers.size === 2) {
      // A second finger turns a stroke into a pinch: take the stroke back.
      if (mode === 'draw' && strokeUndo) {
        const u = undo.pop();
        if (u) board.restore(u.cells, u.gen);
        undoBtn.disabled = !undo.length;
        edited(false);
      }
      strokeUndo = false;
      startPinch();
      return;
    }
    if (pointers.size > 2) return;
    const pan = tool === 'move' || e.button === 1 || e.button === 2;
    if (pan) {
      mode = 'pan';
      root.dataset.panning = '';
      panStart = { x: p.x, y: p.y, cam };
      return;
    }
    if (e.button !== 0) return;
    const [x, y] = cellAt(p.x, p.y);
    if (stamp) {
      stampAt(x, y);
      mode = 'idle';
      return;
    }
    pushUndo();
    strokeUndo = true;
    paint = !board.get(x, y);
    board.set(x, y, paint);
    lastCell = [x, y];
    mode = 'draw';
    previewDirty = true;
    schedule();
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (mode === 'pan') {
      setCam({ ...panStart.cam, cx: panStart.cam.cx - (p.x - panStart.x) / cam.scale, cy: panStart.cam.cy - (p.y - panStart.y) / cam.scale });
    } else if (mode === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2,
        my = (a.y + b.y) / 2;
      const s = clampScale(pinchStart.cam.scale * (d / pinchStart.d));
      // Keep the cell that started under the fingers' midpoint under it.
      setCam({ scale: s, cx: pinchStart.cell[0] - (mx - W / 2) / s, cy: pinchStart.cell[1] - (my - H / 2) / s });
    } else if (mode === 'draw') {
      const [x, y] = cellAt(p.x, p.y);
      if (x !== lastCell[0] || y !== lastCell[1]) {
        paintLine(lastCell[0], lastCell[1], x, y, paint);
        lastCell = [x, y];
        previewDirty = true;
        schedule();
      }
    } else if (e.pointerType === 'mouse' && mode === 'idle') {
      hover(p.x, p.y);
    }
  });

  function endPointer(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (mode === 'draw' && pointers.size === 0) {
      strokeUndo = false;
      edited();
    }
    if (mode === 'pinch' && pointers.size === 1) {
      const [only] = [...pointers.values()];
      panStart = { x: only.x, y: only.y, cam };
      mode = 'pan';
      return;
    }
    if (pointers.size === 0) {
      mode = 'idle';
      delete root.dataset.panning;
    }
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && mode === 'idle') {
      hideTip();
      if (ghostAt) {
        ghostAt = null;
        previewDirty = true;
        schedule();
      }
    }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
      const dx = e.deltaX * unit,
        dy = e.deltaY * unit;
      // Pinch on a trackpad arrives as ctrl + wheel; a mouse wheel as big whole-number steps.
      const mouseWheel = e.deltaMode !== 0 || (dx === 0 && Number.isInteger(dy) && Math.abs(dy) >= 40);
      if (e.ctrlKey || mouseWheel) {
        const k = e.ctrlKey ? 0.012 : 0.0018;
        setCam(zoomAt(cam, W, H, p.x, p.y, cam.scale * Math.exp(-dy * k)));
      } else {
        setCam({ ...cam, cx: cam.cx + dx / cam.scale, cy: cam.cy + dy / cam.scale });
      }
      hideTip();
    },
    { passive: false },
  );

  function hover(x: number, y: number) {
    const [cx, cy] = cellAt(x, y);
    if (stamp) {
      if (!ghostAt || ghostAt[0] !== cx || ghostAt[1] !== cy) {
        ghostAt = [cx, cy];
        previewDirty = true;
        schedule();
      }
      return;
    }
    if (running || cam.scale < 4) return hideTip();
    const n = board.neighbours(cx, cy);
    const fate = board.fate(cx, cy);
    const word = { born: 'is born', survives: 'survives', dies: 'dies', empty: 'stays empty' }[fate];
    tipEl.textContent = `${n} neighbour${n === 1 ? '' : 's'} · ${word}`;
    tipEl.hidden = false;
    tipEl.style.transform = `translate(${(x + 14).toFixed(0)}px, ${(y + 14).toFixed(0)}px)`;
    for (const c of clauses) c.classList.toggle('is-on', c.dataset.clause === fate);
  }

  function hideTip() {
    if (!tipEl.hidden) tipEl.hidden = true;
    for (const c of clauses) c.classList.remove('is-on');
  }

  // ------------------------------------------------------------ keyboard
  /** The cell in the middle of the area the chrome leaves free. */
  const middleCell = (): [number, number] => {
    const m = insets();
    return cellAt((m.left + W - m.right) / 2, (m.top + H - m.bottom) / 2);
  };
  const typing = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
  const pressable = (t: EventTarget | null) => t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement;

  document.addEventListener('keydown', (e) => {
    if (typing(e.target)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      doUndo();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const onBoard = e.target === canvas;
    if (e.key === ' ' && !pressable(e.target)) {
      e.preventDefault();
      setRunning(!running);
    } else if (e.key === '.' || (e.key === 'ArrowRight' && !onBoard && !pressable(e.target) && e.target === document.body)) {
      e.preventDefault();
      if (!running) {
        stepOnce();
        schedule();
      }
    } else if (e.key === 'Escape') {
      if (stamp) setStamp(null);
    } else if ((e.key === 'r' || e.key === 'R') && stamp) {
      turnStamp(1, false);
    } else if ((e.key === 'f' || e.key === 'F') && stamp) {
      turnStamp(0, true);
    } else if (e.key === '+' || e.key === '=') {
      moveCamera({ ...cam, scale: cam.scale * 1.5 });
    } else if (e.key === '-' || e.key === '_') {
      moveCamera({ ...cam, scale: cam.scale / 1.5 });
    }
  });

  canvas.addEventListener('keydown', (e) => {
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dirs[e.key];
    if (d) {
      e.preventDefault();
      if (e.shiftKey) {
        moveCamera({ ...cam, cx: cam.cx + d[0] * 8, cy: cam.cy + d[1] * 8 });
        return;
      }
      if (!cursor) cursor = middleCell();
      cursor = [cursor[0] + d[0], cursor[1] + d[1]];
      // Keep the cursor on screen.
      const [sx, sy] = cellToScreen(cam, W, H, cursor[0] + 0.5, cursor[1] + 0.5);
      const m = insets();
      if (sx < m.left || sx > W - m.right || sy < m.top || sy > H - m.bottom) moveCamera({ ...cam, cx: cursor[0] + 0.5, cy: cursor[1] + 0.5 });
      if (stamp) {
        ghostAt = cursor;
        previewDirty = true;
      }
      const n = board.neighbours(cursor[0], cursor[1]);
      announce(`${board.get(cursor[0], cursor[1]) ? 'Live' : 'Empty'} cell, ${n} neighbour${n === 1 ? '' : 's'}`);
      schedule();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!cursor) cursor = middleCell();
      if (stamp) stampAt(cursor[0], cursor[1]);
      else {
        pushUndo();
        const alive = !board.get(cursor[0], cursor[1]);
        board.set(cursor[0], cursor[1], alive);
        edited();
        announce(alive ? 'Cell on' : 'Cell off');
      }
    }
  });
  canvas.addEventListener('focus', () => {
    if (canvas.matches(':focus-visible') && !cursor) {
      cursor = middleCell();
      schedule();
    }
  });
  canvas.addEventListener('blur', () => {
    cursor = null;
    schedule();
  });

  // ------------------------------------------------------------ dock
  playBtn.addEventListener('click', () => setRunning(!running));
  stepBtn.addEventListener('click', () => {
    if (running) return;
    stepOnce();
    schedule();
  });
  speedIn.addEventListener('input', () => setSpeed(Number(speedIn.value)));
  for (const b of $$<HTMLButtonElement>('[data-tool-btn]')) b.addEventListener('click', () => setTool(b.dataset.toolBtn as 'draw' | 'move'));
  previewBtn.addEventListener('click', () => setPreview(!previewOn));
  $('[data-soup]').addEventListener('click', soup);
  $('[data-clear]').addEventListener('click', () => {
    if (board.population) pushUndo();
    forgetScene();
    board.clear();
    pops = [];
    setRunning(false);
    edited();
    announce('Board cleared');
  });
  undoBtn.addEventListener('click', doUndo);
  $('[data-stamp-cancel]').addEventListener('click', () => setStamp(null));

  function doUndo() {
    const u = undo.pop();
    undoBtn.disabled = !undo.length;
    if (!u) return;
    board.restore(u.cells, u.gen);
    renderer.upload(board);
    edited();
    announce('Undone');
  }

  // ------------------------------------------------------------ tabs
  const tabs = $$<HTMLButtonElement>('[data-tab]');
  function selectTab(name: string, focus = false) {
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    }
    for (const p of $$('[data-pane]')) p.hidden = p.dataset.pane !== name;
    panes.scrollTop = 0;
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => {
      selectTab(t.dataset.tab!);
      if (phone() && sheetState === 'peek') sheetTo('half');
    });
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      selectTab(tabs[(i + d + tabs.length) % tabs.length].dataset.tab!, true);
    });
  });

  // ------------------------------------------------------------ tour
  const stepN = $('[data-step-n]');
  const tourTitle = $('[data-tour-title]');
  const tourBody = $('[data-tour-body]');
  const prevBtn = $<HTMLButtonElement>('[data-prev]');
  const nextBtn = $<HTMLButtonElement>('[data-next]');
  const dots = $$<HTMLButtonElement>('[data-dot]');

  function openStep(i: number, opts: { url?: boolean } = {}) {
    const s = TOUR[i];
    progress = { step: i, seen: Math.max(progress.seen, i) };
    saveProgress(progress);
    stepN.textContent = String(i + 1);
    tourTitle.textContent = s.title;
    tourBody.textContent = s.body;
    prevBtn.disabled = i === 0;
    nextBtn.textContent = i === TOUR.length - 1 ? 'Start over' : 'Next';
    dots.forEach((d, k) => {
      if (k === i) d.setAttribute('aria-current', 'step');
      else d.removeAttribute('aria-current');
      d.classList.toggle('is-seen', k <= progress.seen);
    });
    root.dataset.focus = s.focus ?? '';
    setPreview(!!s.preview);
    load(s.load, undefined, { play: s.play, url: opts.url, room: s.room });
  }
  prevBtn.addEventListener('click', () => openStep(Math.max(0, progress.step - 1)));
  nextBtn.addEventListener('click', () => openStep(progress.step === TOUR.length - 1 ? 0 : progress.step + 1));
  dots.forEach((d, i) => d.addEventListener('click', () => openStep(i)));

  // ------------------------------------------------------------ library and signals
  const peekOnPhone = () => {
    if (phone()) sheetTo('peek');
  };
  for (const b of $$<HTMLButtonElement>('[data-load]'))
    b.addEventListener('click', () => {
      root.dataset.focus = '';
      load(b.dataset.load!, undefined, { play: true });
      peekOnPhone();
    });
  for (const b of $$<HTMLButtonElement>('[data-stamp-id]')) b.addEventListener('click', () => setStamp(b.dataset.stampId!));
  for (const b of $$<HTMLButtonElement>('[data-run]'))
    b.addEventListener('click', () => {
      root.dataset.focus = '';
      load(b.dataset.run!, undefined, { play: true });
      peekOnPhone();
    });
  const msgIn = $<HTMLInputElement>('[data-msg-in]');
  $<HTMLFormElement>('[data-msg]').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = cleanText(msgIn.value) || 'LIFE';
    msgIn.value = text;
    root.dataset.focus = '';
    load('message', text, { play: true });
    if (phone()) sheetTo('half');
  });

  // ------------------------------------------------------------ phone sheet
  type Sheet = 'peek' | 'half' | 'full';
  let sheetState: Sheet = 'peek';
  const sheetY = new Spring(0, 0.38);
  let sheetH = 1;
  let sheetDrag: { id: number; y0: number; v0: number; t: number; vy: number; moved: boolean } | null = null;
  let sheetRaf = 0;

  function snaps(): Record<Sheet, number> {
    const peek = parseFloat(getComputedStyle(root).getPropertyValue('--peek')) * 16 || 140;
    return { full: 0, half: Math.round(sheetH * 0.42), peek: Math.max(0, sheetH - peek) };
  }

  function layoutSheet() {
    sheetH = panel.getBoundingClientRect().height || 1;
    sheetY.snap(snaps()[sheetState]);
    applySheet();
  }

  function applySheet() {
    if (!phone()) {
      root.style.removeProperty('--sheet-y');
      return;
    }
    root.style.setProperty('--sheet-y', `${sheetY.value.toFixed(1)}px`);
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

  // ------------------------------------------------------------ URL hash
  let hashTimer = 0;
  function writeHash(h: string) {
    try {
      history.replaceState(null, '', `#${h}`);
    } catch {
      // Some sandboxes forbid it; sharing just won't carry the pattern.
    }
  }
  function scheduleHash() {
    clearTimeout(hashTimer);
    hashTimer = window.setTimeout(() => {
      if (!board.population || board.population > MAX_HASH_CELLS) return writeHash('');
      const cells: Cell[] = [];
      board.forEachLive((i) => cells.push([i % board.w, Math.floor(i / board.w)]));
      writeHash(`rle=${encodeURIComponent(toRLE(normalize(cells)))}`);
    }, 400);
  }

  function openFromHash(): boolean {
    const params = new URLSearchParams(location.hash.slice(1));
    const p = params.get('p');
    const msg = params.get('msg');
    const rle = params.get('rle');
    if (p && getScene(p)) {
      selectTab(getEntry(p) ? 'library' : root.querySelector(`[data-sig="${p}"]`) ? 'signals' : 'tour');
      load(p, undefined, { play: true, url: false });
      return true;
    }
    if (msg !== null) {
      selectTab('signals');
      msgIn.value = cleanText(msg) || 'LIFE';
      load('message', msgIn.value, { play: true, url: false });
      return true;
    }
    if (rle) {
      const pat = parseRLE(rle);
      if (!pat.cells.length) return false;
      board.clear();
      const x = (board.w >> 1) - (pat.w >> 1),
        y = (board.h >> 1) - (pat.h >> 1);
      place(board, pat, x, y);
      edited(false);
      moveCamera(fit({ x0: x, y0: y, x1: x + pat.w, y1: y + pat.h }, 10, W, H, insets()), false);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ start
  new ResizeObserver(resize).observe(root);
  resize();
  setSpeed(speedIdx);
  if (!openFromHash()) openStep(progress.step, { url: false });
  // The first frame starts framed: no spring in from the default camera.
  moveCamera({ cx: camX.target, cy: camY.target, scale: Math.exp(camS.target) }, false);
  matchMedia(PHONE).addEventListener('change', () => {
    sheetTo('peek');
    layoutSheet();
  });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
    board.trails = !reduced();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedule();
  });
}
