import {
  GridGame,
  corridorPaths,
  corridorTransformers,
  menuLattice,
  snapMenu,
  visibleBounds,
  type GameNode,
  type MenuPoint,
} from './game';
import type { Lattice } from './layout';
import { CanvasRenderer, CorridorLayer, WebGLRenderer, drawMesh, type CorridorSegment, type Renderer } from './renderers';
import { Spring } from './spring';

/**
 * DOM wiring for the home hero v3 (SPEC "Home hero v3: the node menu"). The
 * projects are grid nodes in ordered rows (NodeMenu.astro); this snaps their
 * glyphs to lattice vertices and runs a decorative `GridGame` behind them: the
 * live plants feed every other node along solved-looking corridors (hidden
 * transformers, white-hot 345 kV with cyan branches). It plays the power-on
 * intro, surges the flow toward a hovered or focused node, charges a node on
 * press and hands the clicked glyph to the view transition (Base.astro).
 * The game itself stays DOM-free in `./game`.
 */

/** sessionStorage: the clicked glyph's viewport circle, for the view transition (Base.astro). */
const VT_KEY = 'gero-vt';
const VT_NAME = 'plant-glyph';
const SIM_DT = 1 / 30;
const PREWARM_S = 4; // simulated seconds on build, so the corridors open mid-flow
const PREWARM_DT = 1 / 20; // the engine's largest step: fewest steps for the same flow
const STILL_S = 3; // reduced motion: simulated seconds before each still frame
const FOCUS_SHARE = 0.6; // share of the flow a hovered or focused node pulls toward itself
const AMBIENT = 0.25; // ambient wanderers: fewer than the game, so the menu stays calm
const IGNITE_S = 0.32; // the plants' charge sweep, before power leaves them
const SWEEP_S = 0.9; // the power front takes this long to reach the farthest node
const FRONT_S = 0.18; // corridors and electrons fade in over this as the front passes
const INTRO_S = IGNITE_S + SWEEP_S + FRONT_S + 0.35; // plus the last ring's fill
const CORRIDOR_REST = 0.42; // corridor alpha at rest; a hovered node's corridor goes to 1
const LIFT_PX = -2;
const PRESS_SCALE = 0.98;
const HINT_MS = 1600;
const PHONE = '(max-width: 720px)';
const PROJECT_PATH = /^\/projects\/[^/]+\/?$/;

interface MenuNode {
  el: HTMLAnchorElement;
  item: HTMLElement;
  glyph: HTMLElement;
  ring: SVGPathElement | null;
  id: string;
  /** A live plant: it feeds the flow. */
  source: boolean;
  /** The Ballpark placeholder: not a link yet. */
  soon: boolean;
  /** How far its ring fills once powered (the placeholder stays half-lit). */
  fillTo: number;
  lift: Spring;
  press: Spring;
  pulse: Spring;
  glow: Spring;
  charge: Spring;
  fill: Spring;
  power: Spring;
  hot: boolean;
  clicked: boolean;
  powered: boolean;
  /** Intro time (s) when power reaches it. */
  poweredAt: number;
  shown: Record<string, number>;
  hintTimer: number;
}

/** The flow at one menu layout. */
interface Scene {
  key: string;
  width: number;
  height: number;
  lat: Lattice;
  game: GridGame;
  /** Lit corridors, one entry per lattice edge. */
  segs: CorridorSegment[];
  /** Intro time (s) when power enters each segment. */
  segAt: Float32Array;
  /** Node indices (loads and the plant feeding them) whose corridor uses each segment. */
  segUsers: number[][];
  alpha: Float32Array;
  /** Intro time (s) when power reaches each vertex: electrons show from then. */
  arriveV: Float32Array;
}

/** `root` is `[data-menu]` (NodeMenu.astro). */
export function mountMenu(root: HTMLElement) {
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const meshCanvas = $<HTMLCanvasElement>('[data-mesh]');
  const corridorCanvas = $<HTMLCanvasElement>('[data-corridors]');
  const electronCanvas = $<HTMLCanvasElement>('[data-electrons]');

  // `?motion=reduce` (remembered for the tab by Base.astro as html[data-motion]) forces the reduced path.
  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const forceReduce = document.documentElement.dataset.motion === 'reduce';
  const reduced = () => forceReduce || reduceQuery.matches;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const phoneQuery = matchMedia(PHONE);
  const forceCanvas = new URLSearchParams(location.search).get('renderer') === 'canvas';
  const renderer: Renderer = (!forceCanvas && WebGLRenderer.create(electronCanvas)) || new CanvasRenderer(electronCanvas);
  const corridors = new CorridorLayer(corridorCanvas);
  root.dataset.renderer = renderer.kind;

  const nodes: MenuNode[] = [...root.querySelectorAll<HTMLAnchorElement>('[data-menu-node]')]
    .sort((a, b) => Number(a.dataset.menuNode) - Number(b.dataset.menuNode))
    .map((el) => ({
      el,
      item: el.closest<HTMLElement>('[data-menu-item]') ?? el,
      glyph: el.querySelector<HTMLElement>('[data-menu-glyph]')!,
      ring: el.querySelector<SVGPathElement>('[data-ring]'),
      id: el.dataset.id ?? '',
      source: el.hasAttribute('data-source'),
      soon: el.hasAttribute('data-soon'),
      fillTo: Number(el.dataset.fill ?? 1),
      lift: new Spring(0, 0.25, 1),
      press: new Spring(1, 0.15, 1),
      pulse: new Spring(0, 0.5),
      glow: new Spring(0, 0.25),
      charge: new Spring(0, 0.22, 1),
      fill: new Spring(0, 0.35),
      power: new Spring(0, 0.3),
      hot: false,
      clicked: false,
      powered: false,
      poweredAt: 0,
      shown: {},
      hintTimer: 0,
    }));
  // With no live plant the first node feeds the rest.
  if (nodes.length && !nodes.some((n) => n.source)) nodes[0].source = true;

  let scene: Scene | null = null;
  let dpr = 1;
  let focus = -1;
  // The intro plays when NodeMenu's inline script started the nodes dark.
  let introT = 'intro' in root.dataset && !reduced() ? 0 : Infinity;
  let corridorGlow = nodes.map(() => -1);

  if (introT === Infinity) for (const n of nodes) litNow(n);
  else for (const n of nodes) if (n.source) n.charge.target = 1; // the plants' charge sweep
  nodes.forEach(paintNode);

  // ------------------------------------------------------------ layout
  /** Glyph centres in map px, with the snap nudges and every transform off. */
  function measure(): MenuPoint[] {
    root.classList.add('is-measuring');
    for (const n of nodes) {
      n.item.style.removeProperty('--snap-x');
      n.item.style.removeProperty('--snap-y');
    }
    const o = root.getBoundingClientRect();
    const pts = nodes.map((n) => {
      const r = n.glyph.getBoundingClientRect();
      return { x: r.left + r.width / 2 - o.left, y: r.top + r.height / 2 - o.top };
    });
    root.classList.remove('is-measuring');
    return pts;
  }

  /** (Re)build the scene for the menu's layout. False when nothing changed. */
  function build(): boolean {
    if (!nodes.length) return false;
    const phone = phoneQuery.matches;
    const pts = measure();
    const width0 = root.getBoundingClientRect().width;
    // Desktop: a conductor runs down the menu's centre line. Phones: the spine through every glyph.
    const snap = phone
      ? snapMenu(pts, { anchorX: pts[0].x, spacing: Math.round(Math.min(64, Math.max(52, width0 / 6.5))) })
      : snapMenu(pts, { anchorX: width0 / 2 });
    nodes.forEach((n, k) => {
      const s = snap.snaps[k];
      if (Math.abs(s.dx) > 0.01) n.item.style.setProperty('--snap-x', `${s.dx.toFixed(2)}px`);
      if (s.dy > 0.01) n.item.style.setProperty('--snap-y', `${s.dy.toFixed(2)}px`);
    });
    const rect = root.getBoundingClientRect();
    const key = [rect.width, rect.height, phone, ...pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)].join('|');
    if (scene && scene.key === key) return false;
    const t0 = performance.now();

    const width = rect.width;
    const height = rect.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const lat = menuLattice(snap, width, height);
    const bounds = visibleBounds(lat, width, height);
    const gameNodes: GameNode[] = nodes.map((n, k) => ({
      id: n.id,
      kind: n.source ? 'plant' : 'section',
      col: Math.min(lat.cols - 1, Math.max(0, snap.snaps[k].col)),
      row: Math.min(lat.rows - 1, Math.max(0, snap.snaps[k].row)),
    }));
    const plants = nodes.filter((n) => n.source).map((n) => n.id);
    const loads = nodes.filter((n) => !n.source).map((n) => n.id);
    const verts = lat.cols * lat.rows;
    const game = new GridGame({
      cols: lat.cols,
      rows: lat.rows,
      nodes: gameNodes,
      bounds,
      levels: [{ title: 'Menu', plants, loads: loads.length ? loads : plants.slice(1), budget: 0 }],
      count: coarse ? Math.min(700, verts * 4) : Math.min(1500, verts * 6),
      ambientFraction: AMBIENT,
      seed: 0x6d656e75,
      decorative: true,
    });
    const vOf = (k: number) => game.board.vertex(gameNodes[k].col, gameNodes[k].row);
    const nodeVerts = new Set(gameNodes.map((_, k) => vOf(k)));
    game.setDecorTransformers(
      corridorTransformers(game.board, bounds, nodeVerts, game.activePlants.map(vOf), game.activeLoads.map(vOf)),
    );
    if (focus >= 0) game.setFocus(focus, FOCUS_SHARE);

    // Corridors: one segment per edge used by any load's route, timed by its step along the route.
    const paths = corridorPaths(game);
    const maxLen = Math.max(1, ...paths.map((p) => p.steps.length));
    const at = (d: number) => IGNITE_S + (d / maxLen) * SWEEP_S;
    const segIndex = new Map<number, number>();
    const segs: CorridorSegment[] = [];
    const segAt: number[] = [];
    const segUsers: number[][] = [];
    const arriveV = new Float32Array(verts);
    const plantVerts = game.activePlants.map(vOf);
    for (let v = 0; v < verts; v++) {
      const c = v % lat.cols;
      const r = (v - c) / lat.cols;
      let d = Infinity;
      for (const p of plantVerts) d = Math.min(d, Math.abs(c - (p % lat.cols)) + Math.abs(r - Math.floor(p / lat.cols)));
      arriveV[v] = at(Math.min(d, maxLen * 1.25));
    }
    for (const n of nodes) n.poweredAt = n.source ? IGNITE_S : at(maxLen);
    for (const path of paths) {
      nodes[path.load].poweredAt = at(path.steps.length);
      let v = path.plant >= 0 ? vOf(path.plant) : -1;
      path.steps.forEach((step, d) => {
        const { edgeA, edgeB } = game.board;
        let i = segIndex.get(step.edge);
        if (i === undefined) {
          const { c0, r0, c1, r1 } = game.edgeVertices(step.edge);
          i = segs.push({ c0, r0, c1, r1, high: step.high }) - 1;
          segIndex.set(step.edge, i);
          segAt.push(at(d));
          segUsers.push([]);
        } else {
          segs[i].high ||= step.high;
          segAt[i] = Math.min(segAt[i], at(d));
        }
        segUsers[i].push(path.load, path.plant);
        v = edgeA[step.edge] === v ? edgeB[step.edge] : edgeA[step.edge];
        arriveV[v] = Math.min(arriveV[v], at(d + 1));
      });
    }

    for (let k = 0; k < PREWARM_S / PREWARM_DT; k++) game.step(PREWARM_DT);
    scene = {
      key,
      width,
      height,
      lat,
      game,
      segs,
      segAt: Float32Array.from(segAt),
      segUsers,
      alpha: new Float32Array(segs.length),
      arriveV,
    };
    drawMesh(meshCanvas, width, height, dpr, lat);
    renderer.resize(width, height, dpr, lat);
    corridors.resize(width, height, dpr, lat);
    if (reduced()) still();
    else {
      // Paint now so the map never shows an empty first frame before rAF starts.
      maskElectrons();
      renderer.draw(game, 0);
      paintCorridors();
    }
    root.dataset.ready = '';
    performance.measure('menu:build', { start: t0 });
    return true;
  }

  // ------------------------------------------------------------- intro
  function introRunning() {
    return introT < INTRO_S;
  }

  function advanceIntro() {
    for (const n of nodes) {
      if (n.powered || introT < n.poweredAt) continue;
      n.powered = true;
      n.power.target = 1;
      if (n.source) {
        // Ignition: the ring is full; the hot arc lets go of it.
        n.fill.snap(n.fillTo);
        if (!n.clicked) n.charge.target = 0;
      } else {
        n.fill.target = n.fillTo;
      }
    }
    if (!introRunning()) {
      introT = Infinity;
      delete root.dataset.intro;
    }
  }

  /** Power on now (no intro): lit and filled. */
  function litNow(n: MenuNode) {
    n.powered = true;
    n.power.snap(1);
    n.fill.snap(n.fillTo);
    n.charge.snap(0);
  }

  /** During the intro, electrons only show where power has already arrived. */
  function maskElectrons() {
    if (!scene || !introRunning()) return;
    const { game, arriveV } = scene;
    const cols = game.cols;
    for (let i = 0; i < game.count; i++) {
      if (game.bright[i] <= 0) continue;
      const v = Math.round(game.y[i]) * cols + Math.round(game.x[i]);
      const m = (introT - (arriveV[v] ?? 0)) / FRONT_S;
      if (m < 1) game.bright[i] *= Math.max(0, m);
    }
  }

  function paintCorridors() {
    if (!scene) return;
    const { segs, segAt, segUsers, alpha } = scene;
    for (let i = 0; i < segs.length; i++) {
      const lit = Math.min(1, Math.max(0, (introT - segAt[i]) / FRONT_S));
      let hot = 0;
      for (const k of segUsers[i]) if (k >= 0) hot = Math.max(hot, nodes[k].glow.value);
      alpha[i] = lit * (CORRIDOR_REST + (1 - CORRIDOR_REST) * Math.min(1, Math.max(0, hot)));
    }
    corridors.draw(segs, alpha);
    corridorGlow = nodes.map((n) => n.glow.value);
  }

  // ------------------------------------------------------------- nodes
  function paintNode(n: MenuNode) {
    const set = (prop: string, v: number, digits = 3) => {
      const s = Number(v.toFixed(digits));
      if (n.shown[prop] === s) return;
      n.shown[prop] = s;
      n.el.style.setProperty(prop, String(s));
    };
    set('--lift', n.lift.value, 2);
    set('--press', n.press.value);
    set('--pulse', Math.max(0, n.pulse.value));
    set('--glow', Math.max(0, n.glow.value));
    set('--charge', Math.min(1, Math.max(0, n.charge.value)));
    set('--power', Math.min(1, Math.max(0, n.power.value)));
    const f = Number((Math.min(1, Math.max(0, n.fill.value)) * 100).toFixed(1));
    if (n.ring && n.shown.fill !== f) {
      n.shown.fill = f;
      n.ring.style.strokeDasharray = `${f} 100`;
    }
  }

  function stepNodes(dt: number) {
    for (const n of nodes) {
      for (const s of [n.lift, n.press, n.pulse, n.glow, n.charge, n.fill, n.power]) s.step(dt);
      paintNode(n);
    }
  }

  /** Reduced motion, or no loop: land every spring and paint. */
  function settle() {
    for (const n of nodes) {
      for (const s of [n.lift, n.press, n.pulse, n.glow, n.charge, n.fill, n.power]) s.snap(s.target);
      paintNode(n);
    }
    paintCorridors();
  }

  /** Something changed: let the loop animate it, or land it at once when there's no loop. */
  function kick() {
    if (raf) return;
    start();
    if (!raf) settle();
  }

  function setHot(k: number, on: boolean) {
    const n = nodes[k];
    if (n.hot === on) return;
    n.hot = on;
    n.el.classList.toggle('is-hot', on);
    n.lift.target = on && !reduced() ? LIFT_PX : 0;
    n.glow.target = on ? 1 : 0;
    n.pulse.target = on ? 0.3 : 0;
    if (on && !reduced()) n.pulse.velocity += 8;
    const latest = on ? k : nodes.findIndex((m) => m.hot);
    setFocus(latest);
    kick();
  }

  /** Node `k` (−1: none) pulls the flow toward itself. */
  function setFocus(k: number) {
    if (k === focus) return;
    focus = k;
    scene?.game.setFocus(k, FOCUS_SHARE);
    if (reduced()) still();
  }

  function discharge(n: MenuNode) {
    n.clicked = false;
    n.charge.target = 0;
    kick();
  }

  function hint(n: MenuNode) {
    n.el.classList.add('is-hinting');
    clearTimeout(n.hintTimer);
    n.hintTimer = window.setTimeout(() => n.el.classList.remove('is-hinting'), HINT_MS);
  }

  nodes.forEach((n, k) => {
    const on = () => setHot(k, true);
    const off = () => setHot(k, false);
    n.el.addEventListener('pointerenter', on);
    n.el.addEventListener('pointerleave', off);
    n.el.addEventListener('focus', on);
    n.el.addEventListener('blur', off);
    n.el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (n.soon) return hint(n);
      // Respond on press: the charge sweep and a slight press-in.
      n.clicked = false;
      n.charge.target = 1;
      if (!reduced()) {
        n.press.target = PRESS_SCALE;
        n.pulse.velocity += 14;
      }
      kick();
      const end = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        n.press.target = 1;
        kick();
        if (ev.type === 'pointercancel') return discharge(n);
        // The click (if any) follows pointerup; on touch it can land a moment later.
        window.setTimeout(() => n.clicked || discharge(n), 120);
      };
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
    n.el.addEventListener('click', (e) => {
      if (n.soon) {
        e.preventDefault();
        return hint(n);
      }
      // A modified click opens elsewhere (or not at all): this page stays, so discharge.
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return discharge(n);
      n.clicked = true;
      n.charge.target = 1; // keyboard activation charges too
      kick();
      const url = new URL(n.el.href, location.href);
      if (url.origin === location.origin && PROJECT_PATH.test(url.pathname)) {
        markTransition(n, url.pathname);
      } else if (url.origin === location.origin && url.pathname === location.pathname && url.hash) {
        // A section node scrolls to its anchor: the page stays, so let go after the press reads.
        window.setTimeout(() => discharge(n), 450);
      }
    });
  });

  /**
   * Clicked project: name its glyph for the morph (only this one, so names stay unique) and
   * record its viewport circle. Base.astro's `pageswap` refreshes the record where supported.
   */
  function markTransition(n: MenuNode, path: string) {
    for (const m of nodes) if (m !== n && m.glyph.style.viewTransitionName) m.glyph.style.viewTransitionName = '';
    if (!reduced()) n.glyph.style.viewTransitionName = VT_NAME;
    const r = n.glyph.getBoundingClientRect();
    try {
      sessionStorage.setItem(
        VT_KEY,
        JSON.stringify({
          id: n.id,
          path,
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

  // Back on this page (bfcache restore after a project page): the arcs let go.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    for (const n of nodes) discharge(n);
  });

  // ----------------------------------------------------------- reduced
  /** Reduced motion: run the flow offline, then draw one still frame with everything lit. */
  function still() {
    if (!scene) return;
    introT = Infinity;
    delete root.dataset.intro;
    for (const n of nodes) if (!n.powered) litNow(n);
    for (let k = 0; k < STILL_S / SIM_DT; k++) scene.game.step(SIM_DT);
    renderer.draw(scene.game, 0);
    settle();
  }

  // --------------------------------------------------------------- loop
  let visible = true;
  let raf = 0;
  let last = performance.now();
  // Coarse pointers (phones, tablets) run at ~30 fps to save battery.
  const frameBudget = coarse ? 1000 / 31 : 0;

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const elapsed = now - last;
    if (elapsed < frameBudget) return;
    const dt = Math.min(elapsed / 1000, 1 / 20);
    last = now;
    const intro = introRunning();
    if (intro) {
      introT += dt;
      advanceIntro();
    }
    if (scene) {
      scene.game.step(dt);
      maskElectrons();
      renderer.draw(scene.game, dt);
    }
    stepNodes(dt);
    if (intro || nodes.some((n, k) => Math.abs(n.glow.value - corridorGlow[k]) > 0.002)) paintCorridors();
  }

  function start() {
    if (raf || reduced() || !visible || document.hidden) return;
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
  reduceQuery.addEventListener('change', () => (reduced() ? (stop(), still()) : start()));

  // Re-snap on resize: the rows reflow (and on phones become one column).
  let resizeTimer = 0;
  const rebuild = () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(build, 120);
  };
  new ResizeObserver(rebuild).observe(root);
  phoneQuery.addEventListener('change', rebuild);

  build();
  start();

  // Debug handle for verification in the browser.
  (window as unknown as { __menu: unknown }).__menu = {
    get scene() {
      return scene;
    },
    get focus() {
      return focus;
    },
    get introT() {
      return introT;
    },
    nodes,
    renderer: renderer.kind,
    /** True while the rAF loop runs (never under reduced motion). */
    get animating() {
      return raf !== 0;
    },
    get reducedMotion() {
      return reduced();
    },
  };
}
