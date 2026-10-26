import { GridGame, LEVELS, LIT_THRESHOLD, layoutGame, type Evaluation, type GameLayout } from './game';
import { toPx, type Lattice } from './layout';
import type { MapNode } from './nodes';
import { CanvasRenderer, WebGLRenderer, drawMesh, type Renderer } from './renderers';
import { Spring } from './spring';

/**
 * DOM wiring for the "Grid operator" puzzle (SPEC "The grid game"): layout,
 * transformer input, the level panel, toasts and the render loop. The game
 * itself is `GridGame` (DOM-free).
 */

const STORE_KEY = 'gero-grid-v1';
/** sessionStorage: the current level's transformers, so a trip to a project page keeps the board. */
const BOARD_KEY = 'gero-grid-board';
/** sessionStorage: the clicked plant glyph's viewport circle, for the view transition (Base.astro). */
const VT_KEY = 'gero-vt';
const VT_NAME = 'plant-glyph';
const SIM_DT = 1 / 30;
const PREWARM_S = 4; // simulated seconds on build, so the page opens mid-flow
const PREWARM_DT = 1 / 20; // the engine's largest step: fewest steps for the same flow (main-thread time at load)
const STILL_S = 3; // reduced motion: simulated seconds before each still frame
const SNAP_RADIUS = 0.45; // × spacing
const DRAG_PX = 10;
const TOAST_MS = 7000;
const HEAT_FACT_AT = 0.3; // renderer.maxHeat that counts as "visible heat"
const BEAT_S = 0.9; // min seconds between delivery pulses on a lit load
const BLOCK_PAD = 8; // css px around hero text and the panel where transformers can't go
const LIVE_GAP_MS = 1200; // min ms between screen-reader announcements
const LIVE_SETTLE_MS = 500; // wait this long after the last change before announcing

const FACTS = {
  place: '345 kV means 25× less current, so 625× less heat (I²R).',
  heat: 'That amber glow is I²R loss: low-voltage lines run hot over distance.',
  lit: 'Lit! Power arrives at 13.8 kV with ≥ 80% left.',
  budget: 'Out of transformers. Move or remove one.',
  spark: 'Overvoltage! Power must step back down before a node can use it.',
} as const;
type Fact = keyof typeof FACTS | 'intro';

interface Progress {
  /** Number of unlocked levels (1 = only the first). */
  unlocked: number;
  /** Best stars per level index. */
  best: Record<number, number>;
  /** Level index (0-based) to open on. */
  current: number;
}

interface Xf {
  col: number;
  row: number;
  el: HTMLButtonElement;
  x: Spring;
  y: Spring;
  scale: Spring;
  leaving: boolean;
  dragging: boolean;
  /** Stops an in-progress pointer gesture (window listeners). */
  release?: () => void;
}

interface Board {
  /** Map size and level the placements belong to: `${w}x${h}:${level}`. */
  key: string;
  xfs: [number, number][];
}

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

interface Spot {
  col: number;
  row: number;
  x: number;
  y: number;
}

export function mountGrid(root: HTMLElement, nodes: MapNode[]) {
  const $ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = root) => from.querySelector<T>(sel)!;
  const meshCanvas = $<HTMLCanvasElement>('[data-mesh]');
  const electronCanvas = $<HTMLCanvasElement>('[data-electrons]');
  const nodeEls = [...root.querySelectorAll<HTMLAnchorElement>('[data-node]')];
  const ringEls = nodeEls.map((el) => $<SVGPathElement>('[data-ring]', el));
  const glyphEls = nodeEls.map((el) => $('.node__glyph', el));
  const isPlant = nodes.map((n) => n.kind === 'plant');
  const xfLayer = $('[data-xfs]');
  const ghost = $('[data-ghost]');
  const xfTemplate = $<HTMLTemplateElement>('[data-xf-template]');
  const toast = $('[data-toast]');
  const live = $('[data-live]');
  const panel = $('[data-panel]');
  const heroEls = [...root.querySelectorAll<HTMLElement>('[data-hero-block]')];
  const ui = {
    chip: $<HTMLButtonElement>('[data-chip]', panel),
    chipText: $('[data-chip-text]', panel),
    level: $('[data-level-label]', panel),
    levelDots: [...panel.querySelectorAll<HTMLButtonElement>('[data-level]')],
    title: $('[data-title]', panel),
    objective: $('[data-objective]', panel),
    budget: $('[data-budget]', panel),
    eff: $('[data-eff]', panel),
    stars: $('[data-stars]', panel),
    starEls: [...panel.querySelectorAll<HTMLElement>('[data-stars] span')],
    delivered: $('[data-delivered]', panel),
    lost: $('[data-lost]', panel),
    loads: $('[data-loads]', panel),
    reset: $<HTMLButtonElement>('[data-reset]', panel),
    next: $<HTMLButtonElement>('[data-next]', panel),
  };

  // `?motion=reduce` (remembered for the tab by Base.astro as html[data-motion]) forces the reduced path.
  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const forceReduce = document.documentElement.dataset.motion === 'reduce';
  const reduceMotion = {
    get matches() {
      return forceReduce || reduceQuery.matches;
    },
  };
  const coarse = matchMedia('(pointer: coarse)').matches;
  const forceCanvas = new URLSearchParams(location.search).get('renderer') === 'canvas';
  const renderer: Renderer = (!forceCanvas && WebGLRenderer.create(electronCanvas)) || new CanvasRenderer(electronCanvas);
  root.dataset.renderer = renderer.kind;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let layout: GameLayout;
  let lat: Lattice;
  let game!: GridGame;
  let progress = loadProgress();
  let xfs: Xf[] = [];
  let wasWon = false;
  let everPlaced = false;
  let heatEligible = false;
  let dragging: Xf | null = null;
  /** Vertices kept free of transformers: hero text plus the resting panel, and hero only (fallback). */
  let blocks: { all: number[]; hero: number[] } = { all: [], hero: [] };
  let panelBox: Box | null = null;

  // Per-node animation state.
  const pulses = nodeEls.map(() => new Spring(0, 0.5));
  const sparks = nodeEls.map(() => new Spring(0, 0.35));
  const fills = nodeEls.map(() => new Spring(0, 0.5));
  const fillShown = nodeEls.map(() => -1);
  // Plant charge-up arc (0..1): sweeps on press, springs back if the press doesn't become a click.
  const charges = nodeEls.map(() => new Spring(0, 0.22, 1));
  const chargeShown = nodeEls.map(() => -1);
  const clicked = nodeEls.map(() => false);
  const beatAcc = nodeEls.map(() => 0);
  const beatT = nodeEls.map(() => 0);
  let lastDelivered: number[] = [];
  let lastSparked: number[] = [];
  let hover = -1;
  let litNodes = new Set<number>();
  let targetNodes = new Set<number>();

  // Panel animation state.
  const effSpring = new Spring(0, 0.45);
  let effShown = '';
  const shake = new Spring(0, 0.22, 0.2);
  const stars = ui.starEls.map(() => ({ s: new Spring(0, 0.35), delay: 0 }));

  // ------------------------------------------------------------- layout
  function build() {
    const rect = root.getBoundingClientRect();
    if (game && rect.width === width && rect.height === height) return;
    const t0 = performance.now();
    width = rect.width;
    height = rect.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    layout = layoutGame(nodes, width, height);
    lat = layout.lattice;

    const prevLevel = game ? game.levelIndex : progress.current;
    const prevXfs = game ? game.transformers : loadBoard(prevLevel);
    const verts = lat.cols * lat.rows;
    blocks = blockedVertices();
    game = GridGame.fromLayout(layout, {
      count: coarse ? Math.min(1100, verts * 8) : Math.min(3200, verts * 12),
      level: prevLevel,
      blocked: blocks.all,
    });
    applyBlocked();
    // Keep the transformers if every vertex is still valid; otherwise the level resets.
    if (prevXfs.length && prevXfs.every((t) => game.canPlace(t.col, t.row))) {
      for (const t of prevXfs) game.placeTransformer(t.col, t.row);
    }
    prewarm();
    lastDelivered = [...game.delivered];
    lastSparked = [...game.sparked];

    layout.nodes.forEach((p, i) => {
      const { x, y } = toPx(lat, p.col, p.row);
      const el = nodeEls[i];
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      const label = el.querySelector<HTMLElement>('.node__label');
      const reach = (label?.offsetWidth ?? 0) + 40; // label width + glyph gap
      el.classList.toggle('node--flip', x + reach > width - 12 && x - reach > 12);
    });

    drawMesh(meshCanvas, width, height, dpr, lat, game.faulted);
    renderer.resize(width, height, dpr, lat);

    // Rebuild the transformer buttons at their (possibly new) pixel positions.
    for (const t of xfs) dropXf(t);
    xfs = game.transformers.map((t) => addXf(t.col, t.row, false));
    hideGhost();

    renderLevel();
    onChange(true);
    root.dataset.ready = '';
    if (reduceMotion.matches) still();
    else {
      // Paint now so the map never shows an empty first frame before rAF starts.
      renderer.draw(game, 0);
      animate(0);
    }
    performance.measure('grid:build', { start: t0 });
  }

  /**
   * Junctions under the hero kicker, name and line (their text's client rects)
   * and under the level panel at rest (desktop, or the collapsed chip up to 1024px),
   * each padded by BLOCK_PAD. In map coordinates.
   */
  function blockedVertices() {
    const origin = root.getBoundingClientRect();
    const rel = (r: DOMRect): Box => ({
      l: r.left - origin.left - BLOCK_PAD,
      t: r.top - origin.top - BLOCK_PAD,
      r: r.right - origin.left + BLOCK_PAD,
      b: r.bottom - origin.top + BLOCK_PAD,
    });
    const range = document.createRange();
    const hero = heroEls.flatMap((el) => {
      range.selectNodeContents(el);
      return [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0).map(rel);
    });
    // The expanded chip panel is a temporary overlay: keep the last resting rect.
    if (!compact.matches || !panel.classList.contains('is-open')) panelBox = rel(panel.getBoundingClientRect());
    const inside = (boxes: Box[]) => {
      const out: number[] = [];
      const { minC, maxC, minR, maxR } = layout.bounds;
      for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
          const p = toPx(lat, c, r);
          if (boxes.some((q) => p.x >= q.l && p.x <= q.r && p.y >= q.t && p.y <= q.b)) out.push(r * lat.cols + c);
        }
      }
      return out;
    };
    return { all: inside(panelBox ? [...hero, panelBox] : hero), hero: inside(hero) };
  }

  /**
   * Block the hero and panel; if that leaves the level unsolvable (a node under
   * the panel at some tablet sizes), block the hero only, then nothing.
   */
  function applyBlocked() {
    game.setBlocked(blocks.all);
    if (!game.solvable) game.setBlocked(blocks.hero);
    if (!game.solvable) game.setBlocked([]);
  }

  /** Simulate PREWARM_S seconds so the page opens mid-flow. */
  function prewarm() {
    const t0 = performance.now();
    for (let k = 0; k < PREWARM_S / PREWARM_DT; k++) game.step(PREWARM_DT);
    performance.measure('grid:prewarm', { start: t0 });
  }

  const vertexPx = (col: number, row: number) => toPx(lat, col, row);
  const local = (e: PointerEvent) => {
    const r = root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  /** Nearest junction within 0.45 × spacing of (x, y), or null. */
  function snapAt(x: number, y: number): Spot | null {
    const col = Math.round((x - lat.ox) / lat.spacing);
    const row = Math.round((y - lat.oy) / lat.spacing);
    const p = vertexPx(col, row);
    if (Math.hypot(p.x - x, p.y - y) > SNAP_RADIUS * lat.spacing) return null;
    return { col, row, ...p };
  }
  const isChrome = (t: EventTarget | null) =>
    t instanceof Element && t.closest('[data-panel], [data-node], [data-toast], a, button') !== null;

  // -------------------------------------------------------- transformers
  function addXf(col: number, row: number, animate: boolean): Xf {
    const el = xfTemplate.content.firstElementChild!.cloneNode(true) as HTMLButtonElement;
    const p = vertexPx(col, row);
    const xf: Xf = {
      col,
      row,
      el,
      x: new Spring(p.x, 0.3),
      y: new Spring(p.y, 0.3),
      scale: new Spring(animate && !reduceMotion.matches ? 0.6 : 1, 0.3, 1),
      leaving: false,
      dragging: false,
    };
    xf.scale.target = 1;
    paintXf(xf);
    labelXf(xf);
    el.addEventListener('pointerdown', (e) => onXfDown(xf, e));
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (xf.leaving || xf.dragging) return;
      const rest = xfs.filter((t) => t !== xf && !t.leaving);
      removeXf(xf);
      (rest[0]?.el ?? ui.reset).focus({ preventScroll: true });
    });
    xfLayer.append(el);
    return xf;
  }

  function labelXf(xf: Xf) {
    const c = xf.col - layout.bounds.minC + 1;
    const r = xf.row - layout.bounds.minR + 1;
    xf.el.setAttribute('aria-label', `Transformer at column ${c}, row ${r}. Press Enter to remove it, or drag to move it.`);
  }

  function paintXf(xf: Xf) {
    xf.el.style.transform = `translate3d(${xf.x.value.toFixed(1)}px, ${xf.y.value.toFixed(1)}px, 0) scale(${Math.max(0, xf.scale.value).toFixed(3)})`;
  }

  /** Remove the DOM element right away (no animation). */
  function dropXf(xf: Xf) {
    xf.release?.();
    xf.el.remove();
  }

  /** Remove from the game now; the button scales out on a spring. */
  function removeXf(xf: Xf) {
    if (xf.leaving) return;
    game.removeTransformer(xf.col, xf.row);
    leave(xf);
    onChange();
  }

  function leave(xf: Xf) {
    xf.release?.();
    xf.leaving = true;
    xf.dragging = false;
    xf.el.classList.add('is-leaving');
    xf.el.classList.remove('is-dragging');
    xf.el.blur();
    xf.scale.target = 0;
    if (reduceMotion.matches) {
      xf.el.remove();
      xfs = xfs.filter((t) => t !== xf);
    }
  }

  function placeAt(spot: Spot): Xf | null {
    if (!game.placeTransformer(spot.col, spot.row)) return null;
    everPlaced = true;
    heatEligible = true;
    const xf = addXf(spot.col, spot.row, true);
    xfs.push(xf);
    if (game.budgetLeft <= 0) hideGhost();
    onChange();
    return xf;
  }

  function outOfBudget() {
    if (!reduceMotion.matches) shake.velocity -= 420;
    showFact('budget');
  }

  function onXfDown(xf: Xf, e: PointerEvent) {
    e.stopPropagation();
    if (xf.leaving || dragging || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const id = e.pointerId;
    const start = local(e);
    const grabX = start.x - xf.x.value;
    const grabY = start.y - xf.y.value;
    let active = false;

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      const p = local(ev);
      if (!active) {
        if (Math.hypot(p.x - start.x, p.y - start.y) <= DRAG_PX) return;
        active = true;
        xf.dragging = true;
        dragging = xf;
        try {
          xf.el.setPointerCapture(id);
        } catch {
          /* pointer already gone */
        }
        xf.el.classList.add('is-dragging');
      }
      xf.x.snap(p.x - grabX);
      xf.y.snap(p.y - grabY);
      paintXf(xf);
      const spot = dropSpot(xf);
      if (spot) showGhost(spot);
      else hideGhost();
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      release();
      if (xf.leaving) return;
      if (active) drop(xf, ev.type === 'pointerup');
      else if (ev.type === 'pointerup') removeXf(xf);
    };
    const release = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      xf.release = undefined;
      if (dragging === xf) dragging = null;
    };
    xf.release = release;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /** Where a dragged transformer would land: its own vertex, or any free valid junction. */
  function dropSpot(xf: Xf): Spot | null {
    const spot = snapAt(xf.x.value, xf.y.value);
    if (!spot) return null;
    const home = spot.col === xf.col && spot.row === xf.row;
    return home || game.canPlace(spot.col, spot.row) ? spot : null;
  }

  function drop(xf: Xf, commit: boolean) {
    xf.dragging = false;
    xf.el.classList.remove('is-dragging');
    hideGhost();
    const spot = commit ? dropSpot(xf) : null;
    let changed = false;
    if (spot && (spot.col !== xf.col || spot.row !== xf.row)) {
      changed = game.moveTransformer(xf.col, xf.row, spot.col, spot.row);
      if (changed) {
        xf.col = spot.col;
        xf.row = spot.row;
        labelXf(xf);
      }
    }
    // Valid drop settles into the junction; invalid springs back from where it is now.
    const home = vertexPx(xf.col, xf.row);
    xf.x.target = home.x;
    xf.y.target = home.y;
    if (reduceMotion.matches) {
      xf.x.snap(home.x);
      xf.y.snap(home.y);
      paintXf(xf);
    }
    if (changed) onChange();
  }

  // --------------------------------------------------------------- ghost
  function showGhost(spot: Spot) {
    ghost.style.transform = `translate3d(${spot.x}px, ${spot.y}px, 0)`;
    ghost.classList.add('is-visible');
  }
  function hideGhost() {
    ghost.classList.remove('is-visible');
  }

  // --------------------------------------------------------------- input
  /** A touch press is provisional until release: a swipe that scrolls undoes it. */
  let pendingTouch: { id: number; x: number; y: number; xf: Xf | null; empty: boolean } | null = null;

  root.addEventListener('pointerdown', (e) => {
    if (isChrome(e.target)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = local(e);
    const spot = snapAt(p.x, p.y);
    if (!spot || !game.canPlace(spot.col, spot.row)) return;
    if (e.pointerType === 'touch') {
      const empty = game.budgetLeft <= 0;
      pendingTouch = { id: e.pointerId, x: p.x, y: p.y, empty, xf: empty ? null : placeAt(spot) };
      return;
    }
    if (game.budgetLeft <= 0) outOfBudget();
    else if (placeAt(spot)) showFact('place');
  });

  root.addEventListener('pointermove', (e) => {
    if (pendingTouch && e.pointerId === pendingTouch.id) {
      const p = local(e);
      if (Math.hypot(p.x - pendingTouch.x, p.y - pendingTouch.y) > DRAG_PX) cancelTouch();
      return;
    }
    if (e.pointerType === 'touch' || dragging) return;
    if (isChrome(e.target) || game.budgetLeft <= 0) return hideGhost();
    const p = local(e);
    const spot = snapAt(p.x, p.y);
    if (spot && game.canPlace(spot.col, spot.row)) showGhost(spot);
    else hideGhost();
  });
  root.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch' && !dragging) hideGhost();
  });
  root.addEventListener('pointerup', (e) => {
    if (!pendingTouch || e.pointerId !== pendingTouch.id) return;
    const t = pendingTouch;
    pendingTouch = null;
    if (t.xf) showFact('place');
    else if (t.empty) outOfBudget();
  });
  root.addEventListener('pointercancel', (e) => {
    if (pendingTouch && e.pointerId === pendingTouch.id) cancelTouch();
  });
  function cancelTouch() {
    const t = pendingTouch;
    pendingTouch = null;
    if (t?.xf && !t.xf.leaving) removeXf(t.xf);
  }

  nodeEls.forEach((el, i) => {
    const on = () => (hover = i);
    const off = () => hover === i && (hover = -1);
    el.addEventListener('pointerenter', on);
    el.addEventListener('pointerleave', off);
    el.addEventListener('focus', on);
    el.addEventListener('blur', off);
    el.addEventListener('pointerdown', (e) => {
      on();
      hideGhost();
      if (!reduceMotion.matches) pulses[i].velocity += 14; // charge-up kick, on press
      if (isPlant[i] && (e.pointerType !== 'mouse' || e.button === 0)) chargeUp(i, e.pointerId);
    });
    el.addEventListener('click', (e) => {
      if (!isPlant[i]) return;
      // A modified click opens elsewhere (or not at all): this page stays, so discharge.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return discharge(i);
      }
      clicked[i] = true;
      markTransition(i);
    });
  });

  /** Press on a plant: sweep the arc. Release without a click springs it back from where it is. */
  function chargeUp(i: number, pointerId: number) {
    clicked[i] = false;
    setCharge(i, 1);
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (ev.type === 'pointercancel') return discharge(i);
      // The click (if any) follows pointerup; on touch it can land a moment later.
      window.setTimeout(() => clicked[i] || discharge(i), 120);
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }
  function discharge(i: number) {
    clicked[i] = false;
    setCharge(i, 0);
  }
  function setCharge(i: number, v: number) {
    charges[i].target = v;
    if (reduceMotion.matches || !raf) {
      charges[i].snap(v);
      paintCharge(i);
    }
  }
  function paintCharge(i: number) {
    const c = Math.min(1, Math.max(0, charges[i].value));
    if (c === chargeShown[i] || (Math.abs(c - chargeShown[i]) < 0.002 && c !== 0 && c !== 1)) return;
    chargeShown[i] = c;
    nodeEls[i].style.setProperty('--charge', c.toFixed(3));
  }

  /**
   * Clicked plant: name its glyph for the morph (only this one, so names stay unique) and
   * record its viewport circle. Base.astro's `pageswap` refreshes the record where supported.
   */
  function markTransition(i: number) {
    glyphEls.forEach((g, k) => k !== i && g.style.viewTransitionName && (g.style.viewTransitionName = ''));
    if (!reduceMotion.matches) glyphEls[i].style.viewTransitionName = VT_NAME;
    const r = glyphEls[i].getBoundingClientRect();
    try {
      sessionStorage.setItem(
        VT_KEY,
        JSON.stringify({
          id: nodes[i].id,
          path: new URL(nodeEls[i].href).pathname,
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          r: r.width / 2,
          w: innerWidth,
          h: innerHeight,
          sy: scrollY,
          t: Date.now(),
        }),
      );
    } catch {
      /* storage unavailable: the page just navigates */
    }
  }

  // Back on this page (bfcache restore after a project page): the arc lets go.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) nodeEls.forEach((_, i) => isPlant[i] && discharge(i));
  });

  // --------------------------------------------------------------- panel
  /** Up to 1024px the panel rests as a collapsed chip (GridMap.astro). */
  const compact = matchMedia('(max-width: 1024px)');
  function setPanelOpen(open: boolean) {
    panel.classList.toggle('is-open', open);
    ui.chip.setAttribute('aria-expanded', String(open));
  }
  ui.chip.addEventListener('click', () => setPanelOpen(!panel.classList.contains('is-open')));
  // Expanded chip (phones and tablets): a tap outside the panel only collapses it (capture phase,
  // so it never also places, removes or drags a transformer). Node links still work.
  root.addEventListener(
    'pointerdown',
    (e) => {
      if (!compact.matches || !panel.classList.contains('is-open')) return;
      const t = e.target as Element | null;
      if (t?.closest('[data-panel]')) return;
      setPanelOpen(false);
      if (!t?.closest('[data-node]')) e.stopPropagation();
    },
    true,
  );
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !panel.classList.contains('is-open')) return;
    const inside = panel.contains(document.activeElement);
    setPanelOpen(false);
    if (inside) ui.chip.focus({ preventScroll: true });
  });
  ui.reset.addEventListener('click', () => {
    if (!game.transformers.length) return;
    game.reset();
    for (const xf of xfs) if (!xf.leaving) leave(xf);
    onChange();
  });
  ui.next.addEventListener('click', () => {
    const i = game.levelIndex;
    setLevel(i + 1 < game.levels.length ? i + 1 : 0);
  });
  ui.levelDots.forEach((b) =>
    b.addEventListener('click', () => {
      const i = Number(b.dataset.level);
      if (i < progress.unlocked && i !== game.levelIndex) setLevel(i);
    }),
  );

  function setLevel(i: number) {
    game.setLevel(i);
    applyBlocked();
    progress.current = i;
    saveProgress(progress);
    for (const xf of xfs) if (!xf.leaving) leave(xf);
    hideGhost();
    lastDelivered = [...game.delivered];
    lastSparked = [...game.sparked];
    drawMesh(meshCanvas, width, height, dpr, lat, game.faulted);
    wasWon = false;
    renderLevel();
    say(`Level ${i + 1}: ${game.levelDef.title}. ${ui.objective.textContent}`);
    onChange();
  }

  const titleOf = (k: number) => nodes[k]?.title ?? game.nodes[k].id;
  function objectiveOf(lowercase = false) {
    const loads = list(game.activeLoads.map(titleOf));
    const plants = list(game.activePlants.map(titleOf));
    return `${lowercase ? 'power' : 'Power'} ${loads} from ${plants}`;
  }

  /** The parts of the panel and map that change only with the level. */
  function renderLevel() {
    const i = game.levelIndex;
    const n = game.levels.length;
    ui.level.textContent = `Level ${i + 1} / ${n}`;
    ui.title.textContent = game.levelDef.title;
    const b = game.budget;
    ui.objective.textContent = `${objectiveOf()}. ${b} transformer${b === 1 ? '' : 's'}.`;
    ui.next.textContent = i + 1 < n ? 'Next' : 'Replay';
    renderLevelDots();

    targetNodes = new Set(game.activeLoads);
    const active = new Set([...game.activePlants, ...game.activeLoads]);
    nodeEls.forEach((el, k) => {
      el.classList.toggle('is-idle', !active.has(k));
      el.classList.toggle('is-target', targetNodes.has(k));
      if (!targetNodes.has(k)) fills[k].snap(0);
    });

    ui.loads.replaceChildren(
      ...game.activeLoads.map((k) => {
        const li = document.createElement('li');
        li.dataset.load = String(k);
        li.innerHTML =
          '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4.5"/></svg>';
        li.append(document.createTextNode(titleOf(k)));
        return li;
      }),
    );
    for (const st of stars) {
      st.s.snap(0);
      st.delay = 0;
    }
  }

  function renderLevelDots() {
    ui.levelDots.forEach((d, k) => {
      d.disabled = k >= progress.unlocked;
      if (k === game.levelIndex) d.setAttribute('aria-current', 'step');
      else d.removeAttribute('aria-current');
    });
  }

  /** After every change to the game: re-evaluate and update the panel and node states. */
  function onChange(silent = false) {
    const ev = game.evaluate();
    const i = game.levelIndex;

    ui.delivered.textContent = `${ev.deliveredMW.toFixed(1)} MW`;
    ui.lost.textContent = `${ev.lostMW.toFixed(1)} MW`;
    effSpring.target = ev.efficiency;
    if (silent || reduceMotion.matches) effSpring.snap(ev.efficiency);
    ui.eff.dataset.state = ev.won ? 'won' : ev.efficiency < LIT_THRESHOLD ? 'low' : 'ok';
    renderBudget();

    litNodes = new Set(ev.perLoad.filter((l) => l.lit).map((l) => game.nodeIndex(l.id)));
    ev.perLoad.forEach((l) => {
      const k = game.nodeIndex(l.id);
      nodeEls[k].classList.toggle('is-lit', l.lit);
      fills[k].target = Math.min(1, Math.max(0, l.efficiency / LIT_THRESHOLD));
      if (silent || reduceMotion.matches) fills[k].snap(fills[k].target);
      ui.loads.querySelector(`[data-load="${k}"]`)?.classList.toggle('is-lit', l.lit);
    });
    if (!silent && litNodes.size) showFact('lit');

    if (!silent) {
      const lit = ev.perLoad.filter((l) => l.lit).length;
      const result = ev.won
        ? ` Level cleared, ${ev.stars} of 3 stars.`
        : ` ${lit} of ${ev.perLoad.length} load${ev.perLoad.length === 1 ? '' : 's'} lit.`;
      sayStatus(`Efficiency ${pct(ev.efficiency)}.${result}`);
    }
    if (ev.won) record(ev);
    renderStars(ev, !silent && ev.won && !wasWon);
    if (!silent && ev.won && !wasWon) celebrate(ev);
    wasWon = ev.won;

    const cleared = (progress.best[i] ?? 0) > 0;
    ui.next.disabled = !(ev.won || cleared);
    renderChip();
    saveBoard();
    if (reduceMotion.matches) still();
  }

  function renderBudget() {
    const left = game.budgetLeft;
    const total = game.budget;
    if (ui.budget.childElementCount !== total) {
      ui.budget.replaceChildren(...Array.from({ length: total }, () => document.createElement('span')));
    }
    [...ui.budget.children].forEach((d, k) => d.classList.toggle('is-left', k < left));
    ui.budget.setAttribute('aria-label', `${left} of ${total} transformers left`);
  }

  function renderChip() {
    const left = game.budgetLeft;
    const dots = '●'.repeat(left) + '○'.repeat(game.budget - left);
    ui.chipText.textContent = `Lv ${game.levelIndex + 1} · ${dots} · ${effShown || pct(effSpring.value)}`;
  }

  function renderStars(ev: Evaluation, entering: boolean) {
    ui.starEls.forEach((el, k) => {
      const on = k < ev.stars;
      const wasOn = el.classList.contains('is-on');
      el.classList.toggle('is-on', on);
      const st = stars[k];
      if (!ev.won) {
        st.s.target = 0;
        st.delay = 0;
      } else if (entering) {
        st.s.snap(0);
        st.delay = 0.12 * k;
      } else {
        st.s.target = 1;
        if (on && !wasOn && !reduceMotion.matches) st.s.value = 0.6; // a star just earned
      }
    });
    ui.stars.setAttribute('aria-label', ev.won ? `${ev.stars} of 3 stars` : 'Not cleared yet');
  }

  function record(ev: Evaluation) {
    const i = game.levelIndex;
    const best = Math.max(progress.best[i] ?? 0, ev.stars);
    const unlocked = Math.max(progress.unlocked, Math.min(game.levels.length, i + 2));
    if (best === progress.best[i] && unlocked === progress.unlocked) return;
    progress.best[i] = best;
    progress.unlocked = unlocked;
    saveProgress(progress);
    renderLevelDots();
  }

  function celebrate(ev: Evaluation) {
    if (!reduceMotion.matches) for (const k of litNodes) pulses[k].velocity += 26;
    showToast({ text: `Level cleared ${'★'.repeat(ev.stars)}${'☆'.repeat(3 - ev.stars)}`, win: true });
  }

  // --------------------------------------------------------- fun facts
  type Toast = { text: string; win?: boolean };
  const queue: Toast[] = [];
  let toastBusy = false;
  let shown: Toast | null = null;
  let toastTimer = 0;
  const toastText = $('[data-toast-text]', toast);

  function seen(f: Fact) {
    try {
      const s = JSON.parse(sessionStorage.getItem('facts') ?? '[]') as string[];
      if (s.includes(f)) return true;
      sessionStorage.setItem('facts', JSON.stringify([...s, f]));
    } catch {
      /* storage unavailable: just show it */
    }
    return false;
  }
  const factsQueued = new Set<Fact>();
  function showFact(f: Fact) {
    if (factsQueued.has(f) || seen(f)) return;
    factsQueued.add(f);
    if (f === 'intro') heatEligible = true;
    showToast({
      text:
        f === 'intro'
          ? `Level ${game.levelIndex + 1}: ${objectiveOf(true)}. Click a junction to place a transformer. (They only work on AC — that's why the grid is AC.)`
          : FACTS[f],
    });
  }
  function showToast(t: Toast) {
    if (t.win) {
      // A newer result replaces an older one instead of queueing behind it.
      if (shown?.win) {
        shown.text = t.text;
        toastText.textContent = t.text;
        clearTimeout(toastTimer);
        toastTimer = window.setTimeout(hideToast, TOAST_MS);
        return;
      }
      const queued = queue.find((q) => q.win);
      if (queued) return void (queued.text = t.text);
    }
    queue.push(t);
    if (!toastBusy) nextToast();
  }
  function nextToast() {
    const t = queue.shift();
    if (!t) {
      toastBusy = false;
      return;
    }
    toastBusy = true;
    shown = t;
    toastText.textContent = t.text;
    if (!t.win) say(t.text); // the win is in the panel status
    toast.classList.add('is-visible');
    toastTimer = window.setTimeout(hideToast, TOAST_MS);
  }
  function hideToast() {
    shown = null;
    toast.classList.remove('is-visible');
    setTimeout(nextToast, 450);
  }

  // ------------------------------------------------- screen readers
  // One polite live region: facts and level changes queue up, the panel status
  // keeps only its latest value. Announced once things settle, at most every LIVE_GAP_MS.
  const liveQueue: string[] = [];
  let liveStatus = '';
  let liveTimer = 0;
  let liveAt = 0;
  function say(text: string) {
    liveQueue.push(text);
    scheduleLive();
  }
  function sayStatus(text: string) {
    liveStatus = text;
    scheduleLive();
  }
  function scheduleLive() {
    clearTimeout(liveTimer);
    const wait = Math.max(LIVE_SETTLE_MS, LIVE_GAP_MS - (performance.now() - liveAt));
    liveTimer = window.setTimeout(() => {
      const text = [...liveQueue.splice(0), liveStatus].filter(Boolean).join(' ');
      liveStatus = '';
      if (!text) return;
      liveAt = performance.now();
      live.textContent = text;
    }, wait);
  }

  /** Facts that depend on what the simulation is doing (heat, sparks). */
  function watchSim() {
    if (heatEligible && renderer.maxHeat > HEAT_FACT_AT) showFact('heat');
    game.sparked.forEach((n, k) => {
      if (n > lastSparked[k]) {
        if (!reduceMotion.matches) {
          sparks[k].snap(1); // flash, then fade on the spring
          sparks[k].target = 0;
        }
        showFact('spark');
      }
      lastSparked[k] = n;
    });
  }

  // ------------------------------------------------------------ animate
  function animate(dt: number) {
    // Transformers.
    for (const xf of xfs) {
      if (!xf.dragging) {
        xf.x.step(dt);
        xf.y.step(dt);
      }
      xf.scale.step(dt);
      paintXf(xf);
      if (xf.leaving && xf.scale.value < 0.04) xf.el.remove();
    }
    if (xfs.some((t) => t.leaving && !t.el.isConnected)) xfs = xfs.filter((t) => t.el.isConnected);

    // Nodes: delivery beats on lit loads, sparks, ring fill, hover.
    game.delivered.forEach((n, k) => {
      beatAcc[k] += n - (lastDelivered[k] ?? n);
      lastDelivered[k] = n;
      beatT[k] += dt;
      if (litNodes.has(k) && beatAcc[k] > 0 && beatT[k] >= BEAT_S) {
        pulses[k].velocity += 12;
        beatAcc[k] = 0;
        beatT[k] = 0;
      }
    });
    nodeEls.forEach((el, k) => {
      pulses[k].target = hover === k ? 0.6 : 0;
      el.style.setProperty('--pulse', Math.max(0, pulses[k].step(dt)).toFixed(3));
      el.style.setProperty('--spark', Math.max(0, sparks[k].step(dt)).toFixed(3));
      el.classList.toggle('is-hot', hover === k);
      if (isPlant[k]) {
        charges[k].step(dt);
        paintCharge(k);
      }
      const f = fills[k].step(dt);
      if (Math.abs(f - fillShown[k]) > 0.002) {
        fillShown[k] = f;
        ringEls[k].style.strokeDasharray = `${(Math.max(0, f) * 100).toFixed(2)} 100`;
      }
    });

    // Panel.
    const t = pct(effSpring.step(dt));
    if (t !== effShown) {
      effShown = t;
      ui.eff.textContent = t;
      renderChip();
    }
    ui.budget.style.transform = `translateX(${shake.step(dt).toFixed(2)}px)`;
    stars.forEach((st, k) => {
      if (st.delay > 0 && (st.delay -= dt) <= 0) st.s.target = 1;
      else if (st.delay <= 0 && wasWon && st.s.target === 0) st.s.target = 1;
      ui.starEls[k].style.transform = `scale(${Math.max(0, st.s.step(dt)).toFixed(3)})`;
    });
  }

  /** Snap every spring to its target and paint once (reduced motion). */
  function settle() {
    for (const xf of xfs) {
      xf.x.snap(xf.x.target);
      xf.y.snap(xf.y.target);
      xf.scale.snap(xf.scale.target);
    }
    for (const s of [...pulses, ...sparks, ...fills, ...charges, effSpring, shake]) s.snap(s.target);
    for (const st of stars) {
      st.delay = 0;
      st.s.snap(wasWon ? 1 : 0);
    }
    lastDelivered = [...game.delivered];
    animate(0);
  }

  /** Reduced motion: run the engine offline, then draw one still frame. */
  function still() {
    for (let k = 0; k < STILL_S / SIM_DT; k++) game.step(SIM_DT);
    renderer.draw(game, 0);
    watchSim();
    settle();
  }

  // --------------------------------------------------------------- loop
  let visible = true;
  let raf = 0;
  let last = performance.now();
  const frameBudget = coarse ? 1000 / 31 : 0;

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const elapsed = now - last;
    if (elapsed < frameBudget) return;
    const dt = Math.min(elapsed / 1000, 1 / 20);
    last = now;
    game.step(dt);
    renderer.draw(game, dt);
    watchSim();
    animate(dt);
  }

  function start() {
    if (raf || reduceMotion.matches || !visible || document.hidden) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    visible ? start() : stop();
  }).observe(root);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  reduceQuery.addEventListener('change', () => (reduceMotion.matches ? (stop(), still()) : start()));

  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(build, 120);
  }).observe(root);

  build();
  start();
  setTimeout(() => {
    if (!everPlaced && !game.transformers.length) showFact('intro');
  }, 2000);

  // Debug handle for verification in the browser.
  (window as unknown as { __grid: unknown }).__grid = {
    get game() {
      return game;
    },
    get lattice() {
      return lat;
    },
    renderer: renderer.kind,
    /** True while the rAF loop runs (never under reduced motion). */
    get animating() {
      return raf !== 0;
    },
    get reducedMotion() {
      return reduceMotion.matches;
    },
  };

  // ------------------------------------------------------------ storage
  // Function declarations (hoisted): `build()` runs above, before this point is reached.
  function boardKey(level: number) {
    return `${Math.round(width)}x${Math.round(height)}:${level}`;
  }

  /** This visit's placements for `level`, if they were made at the same map size. */
  function loadBoard(level: number): { col: number; row: number }[] {
    try {
      const raw = JSON.parse(sessionStorage.getItem(BOARD_KEY) ?? 'null') as Partial<Board> | null;
      if (!raw || raw.key !== boardKey(level) || !Array.isArray(raw.xfs)) return [];
      return raw.xfs
        .filter((p) => Array.isArray(p) && Number.isInteger(p[0]) && Number.isInteger(p[1]))
        .map(([col, row]) => ({ col, row }));
    } catch {
      return [];
    }
  }
  function saveBoard() {
    try {
      const board: Board = {
        key: boardKey(game.levelIndex),
        xfs: game.transformers.map((t) => [t.col, t.row]),
      };
      sessionStorage.setItem(BOARD_KEY, JSON.stringify(board));
    } catch {
      /* storage unavailable: the board lasts for this page load */
    }
  }

  function loadProgress(): Progress {
    const n = LEVELS.length;
    const fallback: Progress = { unlocked: 1, best: {}, current: 0 };
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<Progress> | null;
      if (!raw || typeof raw !== 'object') return fallback;
      const unlocked = Number.isInteger(raw.unlocked) ? Math.min(n, Math.max(1, raw.unlocked!)) : 1;
      const best: Record<number, number> = {};
      for (const [k, v] of Object.entries(raw.best ?? {})) {
        const i = Number(k);
        if (Number.isInteger(i) && i >= 0 && i < n && Number.isInteger(v) && v >= 1 && v <= 3) best[i] = v;
      }
      const current = Number.isInteger(raw.current) ? Math.min(unlocked - 1, Math.max(0, raw.current!)) : 0;
      return { unlocked, best, current };
    } catch {
      return fallback;
    }
  }
}

function saveProgress(p: Progress) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: progress lasts for this visit */
  }
}

function pct(v: number) {
  return `${Math.round(Math.max(0, v) * 100)}%`;
}

/** "A", "A and B", "A, B and C". */
function list(items: string[]) {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
