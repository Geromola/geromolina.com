import {
  GridGame,
  MENU_PX,
  circuitPaths,
  circuitTransformers,
  menuLayout,
  visibleBounds,
  type GameNode,
  type LatticeRect,
  type MenuLayout,
  type MenuSectionLayout,
} from './game';
import type { Lattice } from './layout';
import { CanvasRenderer, CorridorLayer, WebGLRenderer, drawMesh, type CorridorSegment, type Renderer } from './renderers';
import { Spring } from './spring';

/**
 * DOM wiring for the home hero v3.2 (SPEC "Home hero v3: the node menu"). The
 * root node "Gero" powers two fenced sections, ABOUT ME and PROJECTS, each
 * behind a switch node that expands and collapses it like a dropdown on the
 * grid. Everything sits on lattice vertices (`menuLayout`); a decorative
 * `GridGame` runs the flow root → switch → child along hidden-transformer
 * corridors, and a section's children are only fed while it's open. On load
 * the power-on runs in sequence (root, About me, Projects); input works
 * throughout. The game itself stays DOM-free in `./game`.
 */

/** sessionStorage: the clicked glyph's viewport circle, for the view transition (Base.astro). */
const VT_KEY = 'gero-vt';
const VT_NAME = 'plant-glyph';
const SIM_DT = 1 / 30;
const PREWARM_S = 4; // simulated seconds on build, so open branches show mid-flow
const PREWARM_DT = 1 / 20;
const STILL_S = 3; // reduced motion: simulated seconds before each still frame
const FOCUS_SHARE = 0.6; // share of the flow a hovered or focused node pulls toward itself
const AMBIENT = 0.25;
// Power-on (option A), unhurried: the root ignites, then each section in turn.
const ROOT_IGNITE_S = 0.6; // the root's charge sweep
const FEED_S = 0.55; // a root → switch corridor draws in this long
const OPEN_DELAY_S = 0.12; // a powered switch opens its section after this
const NEXT_FEED_S = 0.7; // after About me opens, the Projects corridor starts
const SECTION_RESPONSE = 1.15; // Spring response of a section's energy front (both ways)
const FRONT_STEPS = 2; // the front's soft edge, in corridor segments
const RING_S = 0.45; // a ring filling (and a node lighting) as power arrives
const SHOW_RESPONSE = 0.42; // a child's plate springing in or out
const SHIFT_RESPONSE = 0.5; // stacked and column: what follows a section sliding up or down
const SHIFT_AFTER = 0.2; // collapsing: the slide starts once the front is back under this
const OPEN_AFTER = 0.25; // expanding: the children start once the slide is back under this
const CORRIDOR_REST = 0.42; // corridor alpha at rest; a hovered node's corridor goes to 1
const LIFT_PX = -2;
const PRESS_SCALE = 0.98;
const HINT_MS = 1600;
const PULL = 0.35; // a hidden child sits this share of the way toward its switch
const PROJECT_PATH = /^\/projects\/[^/]+\/?$/;

type Role = 'root' | 'switch' | 'child';

interface MNode {
  role: Role;
  /** The element the CSS vars go on (header, button or link). */
  el: HTMLElement;
  /** The absolutely placed element. */
  item: HTMLElement;
  glyph: HTMLElement;
  ring: SVGPathElement | null;
  id: string;
  /** Section index (0 about, 1 projects), −1 for the root. */
  section: number;
  soon: boolean;
  fillTo: number;
  lift: Spring;
  press: Spring;
  pulse: Spring;
  glow: Spring;
  charge: Spring;
  fill: Spring;
  power: Spring;
  shown: Spring;
  hot: boolean;
  clicked: boolean;
  powered: boolean;
  /** Pixel position of its vertex (map px) and the pull toward its switch while hidden. */
  x: number;
  y: number;
  /** Top (px) of its placed element with nothing collapsed above it. */
  top0: number;
  paint: Record<string, number>;
  hintTimer: number;
}

interface Section {
  key: string;
  el: HTMLElement;
  button: HTMLButtonElement;
  list: HTMLElement;
  fence: HTMLElement;
  /** Node indices. */
  switchNode: number;
  children: number[];
  /** Target state, and whether a click has taken it over from the intro. */
  open: boolean;
  manual: boolean;
  /** Energy front, 0 (at the switch) .. 1 (past the farthest child). */
  front: Spring;
  chev: Spring;
  /** Intro bookkeeping (intro seconds): when the intro opens it, and when it did. */
  openAt: number;
  openedAt: number;
  layout: MenuSectionLayout | null;
  fenceShown: string;
  /**
   * Stacked and column only: the rows this section gives back when collapsed
   * (0 in wide), and how far it has (0 open .. 1 collapsed). What follows it
   * slides up by `shift × rows` lattice rows.
   */
  rows: number;
  shift: Spring;
}

/** One leg of the circuit and its drawn corridor. */
interface FeedState {
  from: number;
  to: number;
  /** Corridor length in segments. */
  len: number;
  /** Root feeds: front position (segments), and whether it has started. Section feeds use the section front. */
  d: number;
  started: boolean;
  section: number;
  /** Nodes whose hover brightens this feed. */
  users: number[];
}

interface Scene {
  key: string;
  width: number;
  height: number;
  lat: Lattice;
  layout: MenuLayout;
  game: GridGame;
  segs: CorridorSegment[];
  /** Per segment: the feeds through it and the step index along each. */
  uses: { feed: number; step: number }[][];
  alpha: Float32Array;
  /** Lattice row where ABOUT ME's freed rows start (the flow squeezes them shut as it collapses). */
  bandAt: number;
  /** Menu height with nothing collapsed, and the least it may be. */
  fullHeight: number;
  minHeight: number;
}

/** `root` is `[data-menu]` (NodeMenu.astro). */
export function mountMenu(root: HTMLElement) {
  const $ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = root) => from.querySelector<T>(sel)!;
  const content = $('[data-content]');
  const mapEl = $('.nmenu__map');
  const meshCanvas = $<HTMLCanvasElement>('[data-mesh]');
  const corridorCanvas = $<HTMLCanvasElement>('[data-corridors]');
  const electronCanvas = $<HTMLCanvasElement>('[data-electrons]');

  // `?motion=reduce` (remembered for the tab by Base.astro as html[data-motion]) forces the reduced path.
  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const forceReduce = document.documentElement.dataset.motion === 'reduce';
  const reduced = () => forceReduce || reduceQuery.matches;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const forceCanvas = new URLSearchParams(location.search).get('renderer') === 'canvas';
  const renderer: Renderer = (!forceCanvas && WebGLRenderer.create(electronCanvas)) || new CanvasRenderer(electronCanvas);
  const corridors = new CorridorLayer(corridorCanvas);
  root.dataset.renderer = renderer.kind;

  // ------------------------------------------------------------- nodes
  const springs = (n: MNode) => [n.lift, n.press, n.pulse, n.glow, n.charge, n.fill, n.power, n.shown];
  const makeNode = (role: Role, el: HTMLElement, item: HTMLElement, glyph: HTMLElement, section: number): MNode => ({
    role,
    el,
    item,
    glyph,
    ring: glyph.querySelector<SVGPathElement>('[data-ring]'),
    id: el.dataset.id ?? role,
    section,
    soon: el.hasAttribute('data-soon'),
    fillTo: Number(el.dataset.fill ?? 1),
    lift: new Spring(0, 0.25, 1),
    press: new Spring(1, 0.15, 1),
    pulse: new Spring(0, 0.5),
    glow: new Spring(0, 0.25),
    charge: new Spring(0, 0.22, 1),
    fill: new Spring(0, RING_S),
    power: new Spring(0, RING_S),
    shown: new Spring(role === 'child' ? 0 : 1, SHOW_RESPONSE),
    hot: false,
    clicked: false,
    powered: false,
    x: 0,
    y: 0,
    top0: 0,
    paint: {},
    hintTimer: 0,
  });

  const rootEl = $('[data-root]');
  const nodes: MNode[] = [makeNode('root', rootEl, rootEl, $('[data-root-glyph]', rootEl), -1)];
  const sectionEls = [...root.querySelectorAll<HTMLElement>('[data-section]')];
  const sections: Section[] = sectionEls.map((el, i) => {
    const button = $<HTMLButtonElement>('[data-switch]', el);
    nodes.push(makeNode('switch', button, button, $('[data-switch-glyph]', button), i));
    return {
      key: el.dataset.section ?? String(i),
      el,
      button,
      list: $('[data-list]', el),
      fence: $('[data-fence]', el),
      switchNode: nodes.length - 1,
      children: [],
      open: false,
      manual: false,
      front: new Spring(0, SECTION_RESPONSE, 1),
      chev: new Spring(1, 0.3, 1),
      openAt: Infinity,
      openedAt: Infinity,
      layout: null,
      fenceShown: '',
      rows: 0,
      shift: new Spring(0, SHIFT_RESPONSE, 1),
    };
  });
  sections.forEach((sec, i) => {
    for (const a of sec.el.querySelectorAll<HTMLAnchorElement>('[data-menu-node]')) {
      nodes.push(makeNode('child', a, a.closest<HTMLElement>('[data-menu-item]') ?? a, $('[data-menu-glyph]', a), i));
      sec.children.push(nodes.length - 1);
    }
  });
  const kids = (s: number) => sections[s].children;

  // The circuit: root → each switch, each switch → its children.
  const feeds: FeedState[] = [
    ...sections.map((sec) => ({
      from: 0,
      to: sec.switchNode,
      len: 1,
      d: 0,
      started: false,
      section: -1,
      users: [sec.switchNode, ...sec.children],
    })),
    ...sections.flatMap((sec, i) =>
      sec.children.map((k) => ({ from: sec.switchNode, to: k, len: 1, d: 0, started: true, section: i, users: [k] })),
    ),
  ];
  const rootFeed = (s: number) => feeds[s];

  let scene: Scene | null = null;
  let dpr = 1;
  let focus = -1;
  // The intro plays when NodeMenu's inline script started the nodes dark.
  let introT = 'intro' in root.dataset && !reduced() ? 0 : Infinity;

  if (introT === Infinity) {
    // Everything on, both sections open.
    powerOn(nodes[0], true);
    for (const f of feeds) if (f.section < 0) (f.started = true), (f.d = Infinity);
    sections.forEach((_, s) => setOpen(s, true, false, true));
  }

  // ------------------------------------------------------------ layout
  /** (Re)build positions and the scene for the menu's width. False when nothing changed. */
  function build(): boolean {
    const width = root.getBoundingClientRect().width;
    // Not laid out yet (a hidden tab or a zero-size frame): the ResizeObserver builds once it has a width.
    if (width < 160) return false;
    const gutter = Math.min(32, Math.max(16, width * 0.03));
    let layout = menuLayout(width, { about: kids(0).length, projects: kids(1).length, gutter });
    const key = `${width}|${layout.mode}|${window.devicePixelRatio}`;
    if (scene && scene.key === key) return false;
    const t0 = performance.now();
    const s = layout.spacing;
    // Wide and stacked: centred. Column: the fence's left edge on the gutter. The root's row
    // clears the section nav (a centred pill on phones).
    const ext0 = layout.extent;
    const originX = layout.mode === 'column' ? gutter - ext0.c0 * s : (width - (ext0.c1 - ext0.c0) * s) / 2 - ext0.c0 * s;
    // The root plate may not run past the right gutter; on phones it starts under the nav pill.
    const rootLeft = originX + layout.root.col * s - 32;
    rootEl.style.maxWidth = `${width - gutter - rootLeft}px`;
    const rootHalf = Math.max(32, rootEl.offsetHeight / 2);
    const originY = layout.mode === 'column' ? 64 + rootHalf + 4 : gutter + Math.max(32, rootHalf - 8);
    // A tall root plate (it wraps on phones) pushes the fences a row down, clear of the fence label.
    if (rootHalf + 14 > s) {
      layout = menuLayout(width, { about: kids(0).length, projects: kids(1).length, gutter, fenceTop: 2 });
    }
    const ext = layout.extent;
    const minHeight = Math.max(window.innerHeight, 560);
    const fullHeight = originY + (ext.r1 + 1) * s;
    // The engine and the canvases keep the full (expanded) size; collapsing only slides the DOM
    // and squeezes the drawn flow, and the menu itself gets shorter.
    const height = Math.max(minHeight, fullHeight);
    const lopts = { about: kids(0).length, projects: kids(1).length, gutter, fenceTop: rootHalf + 14 > s ? 2 : 1 };
    const shutAbout = menuLayout(width, { ...lopts, collapsed: { about: true } });
    const shutBoth = menuLayout(width, { ...lopts, collapsed: { about: true, projects: true } });
    sections[0].rows = layout.projects.fence.r0 - shutAbout.projects.fence.r0;
    if (sections[1]) sections[1].rows = shutAbout.extent.r1 - shutBoth.extent.r1;
    mapEl.style.bottom = 'auto';
    mapEl.style.height = `${height}px`;
    const ox = originX - Math.ceil(originX / s) * s;
    const oy = originY - Math.ceil(originY / s) * s;
    const lat: Lattice = {
      spacing: s,
      ox,
      oy,
      cols: Math.ceil((width - ox) / s) + 1,
      rows: Math.ceil((height - oy) / s) + 1,
    };
    const px = (c: number, r: number) => ({ x: originX + c * s, y: originY + r * s });

    // Place the DOM.
    const place = (n: MNode, c: number, r: number) => {
      const p = px(c, r);
      n.x = p.x;
      n.y = p.y;
    };
    place(nodes[0], layout.root.col, layout.root.row);
    rootEl.style.left = `${nodes[0].x - 32}px`;
    rootEl.style.top = `${nodes[0].y}px`;
    nodes[0].top0 = nodes[0].y;
    const secLayouts = [layout.about, layout.projects];
    sections.forEach((sec, i) => {
      const L = secLayouts[i];
      sec.layout = L;
      sec.fenceShown = '';
      sec.el.dataset.style = L.style;
      const sw = nodes[sec.switchNode];
      place(sw, L.switch.col, L.switch.row);
      sec.button.style.left = `${sw.x - 14}px`;
      sw.top0 = sw.y;
      const itemW = L.style === 'hang' ? L.plateW : MENU_PX.glyph + MENU_PX.sideGap + L.plateW;
      sec.children.forEach((k, j) => {
        const n = nodes[k];
        const c = L.children[j] ?? L.children[L.children.length - 1];
        place(n, c.col, c.row);
        const left = L.style === 'hang' ? n.x - L.plateW / 2 : n.x - MENU_PX.glyph / 2;
        const top = L.style === 'hang' ? n.y - MENU_PX.glyph / 2 : n.y - MENU_PX.sideH / 2;
        n.item.style.left = `${left}px`;
        n.top0 = top;
        n.item.style.setProperty('--item-w', `${itemW}px`);
        // Hidden, a child sits part of the way toward its switch (the plate retracts into it).
        n.item.style.setProperty('--fx', `${((sw.x - n.x) * PULL).toFixed(1)}px`);
        n.item.style.setProperty('--fy', `${((sw.y - n.y) * PULL).toFixed(1)}px`);
      });
    });
    root.dataset.laid = '';

    // The game: the root is the plant; switches and children are loads.
    const vertexOf = (n: MNode) => ({ col: Math.round((n.x - ox) / s), row: Math.round((n.y - oy) / s) });
    const gameNodes: GameNode[] = nodes.map((n) => ({
      id: n.id,
      kind: n.role === 'root' ? 'plant' : 'section',
      ...vertexOf(n),
    }));
    const verts = lat.cols * lat.rows;
    const game = new GridGame({
      cols: lat.cols,
      rows: lat.rows,
      nodes: gameNodes,
      bounds: visibleBounds(lat, width, height),
      levels: [{ title: 'Menu', plants: [nodes[0].id], loads: nodes.slice(1).map((n) => n.id), budget: 0 }],
      count: coarse ? Math.min(700, verts * 4) : Math.min(1500, verts * 6),
      ambientFraction: AMBIENT,
      seed: 0x6d656e75,
      decorative: true,
    });
    const vOf = (k: number) => game.board.vertex(gameNodes[k].col, gameNodes[k].row);
    game.setDecorTransformers(
      circuitTransformers(
        game.board,
        game.bounds,
        new Set(gameNodes.map((_, k) => vOf(k))),
        feeds.map((f) => ({ from: vOf(f.from), to: vOf(f.to) })),
      ),
    );
    for (const f of feeds) if (f.from !== 0) game.setLoadSource(f.to, f.from);
    for (let k = 1; k < nodes.length; k++) game.setLoadEnabled(k, nodes[k].powered);
    if (focus >= 0) game.setFocus(focus, FOCUS_SHARE);

    // Corridors: one segment per edge, with every feed (and step) that uses it.
    const paths = circuitPaths(game, feeds);
    const segIndex = new Map<number, number>();
    const segs: CorridorSegment[] = [];
    const uses: { feed: number; step: number }[][] = [];
    paths.forEach((p, f) => {
      feeds[f].len = Math.max(1, p.steps.length);
      if (feeds[f].section < 0 && Number.isFinite(feeds[f].d) && feeds[f].d > feeds[f].len + FRONT_STEPS) {
        feeds[f].d = feeds[f].len + FRONT_STEPS;
      }
      p.steps.forEach((step, d) => {
        let i = segIndex.get(step.edge);
        if (i === undefined) {
          const { c0, r0, c1, r1 } = game.edgeVertices(step.edge);
          i = segs.push({ c0, r0, c1, r1, high: step.high }) - 1;
          segIndex.set(step.edge, i);
          uses.push([]);
        } else segs[i].high ||= step.high;
        uses[i].push({ feed: f, step: d });
      });
    });

    for (let k = 0; k < PREWARM_S / PREWARM_DT; k++) game.step(PREWARM_DT);
    scene = {
      key,
      width,
      height,
      lat,
      layout,
      game,
      segs,
      uses,
      alpha: new Float32Array(segs.length),
      bandAt: (originY + layout.about.collapsed.r1 * s - oy) / s,
      fullHeight,
      minHeight,
    };
    for (const n of nodes) n.paint.top = NaN;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    drawMesh(meshCanvas, width, height, dpr, lat);
    renderer.resize(width, height, dpr, lat);
    corridors.resize(width, height, dpr, lat);
    if (reduced()) still();
    else {
      paintAll();
      drawFlow(0);
      paintCorridors();
    }
    performance.measure('menu:build', { start: t0 });
    return true;
  }

  // ----------------------------------------------------------- circuit
  /** Front position (segments) of feed `f`. */
  function feedD(f: number): number {
    const feed = feeds[f];
    if (feed.section < 0) return feed.d;
    const sec = sections[feed.section];
    const longest = Math.max(1, ...sec.children.map((k) => feeds.find((g) => g.to === k)?.len ?? 1));
    return Math.max(0, sec.front.value) * (longest + FRONT_STEPS);
  }

  function powerOn(n: MNode, now = false) {
    n.powered = true;
    n.power.target = 1;
    n.fill.target = n.fillTo;
    n.shown.target = 1;
    if (now || reduced()) {
      n.power.snap(1);
      n.fill.snap(n.fillTo);
      n.shown.snap(1);
    }
    const k = nodes.indexOf(n);
    if (k > 0) scene?.game.setLoadEnabled(k, true);
  }

  function powerOff(n: MNode) {
    n.powered = false;
    n.power.target = 0;
    n.fill.target = 0;
    n.shown.target = 0;
    if (n.hot) setHot(nodes.indexOf(n), false);
    if (reduced()) {
      n.power.snap(0);
      n.fill.snap(0);
      n.shown.snap(0);
    }
    const k = nodes.indexOf(n);
    if (k > 0) scene?.game.setLoadEnabled(k, false);
  }

  /** Power follows the fronts: a switch once its corridor arrives, a child while its section's front covers it. */
  function updatePower() {
    sections.forEach((sec, s) => {
      const sw = nodes[sec.switchNode];
      const f = rootFeed(s);
      if (!sw.powered && f.started && f.d >= f.len) powerOn(sw);
      for (const k of sec.children) {
        const fi = feeds.findIndex((g) => g.to === k);
        const reached = feedD(fi) >= feeds[fi].len;
        const n = nodes[k];
        if (reached && !n.powered) powerOn(n);
        else if (!reached && n.powered) powerOff(n);
      }
    });
  }

  /** Open or close section `s`. A click (`manual`) takes the section over from the intro. */
  function setOpen(s: number, open: boolean, manual: boolean, now = false) {
    const sec = sections[s];
    sec.open = open;
    if (manual) sec.manual = true;
    if (open && sec.openedAt === Infinity) sec.openedAt = Number.isFinite(introT) ? introT : 0;
    // Opening before the switch has power: start its corridor now.
    const f = rootFeed(s);
    if (open && !f.started) f.started = true;
    sec.chev.target = open ? 0 : 1;
    gate(sec);
    if (now || reduced()) {
      land(sec);
      sec.chev.snap(sec.chev.target);
      f.d = Infinity;
    }
    sec.button.setAttribute('aria-expanded', String(open));
    // Collapsed children are out of reach at once (the plates retract after).
    sec.list.inert = !open;
    updatePower();
    if (now || reduced()) settle();
    else kick();
  }

  // ------------------------------------------------------------- intro
  function advance(dt: number) {
    // Root feeds draw outward at their own pace.
    for (const f of feeds) {
      if (f.section >= 0 || !f.started || !Number.isFinite(f.d)) continue;
      f.d = Math.min(f.len + FRONT_STEPS, f.d + (dt * (f.len + FRONT_STEPS)) / FEED_S);
    }
    if (introT < Infinity) {
      introT += dt;
      const r = nodes[0];
      // The root's charge arc sweeps round (eased), then it ignites and lets go.
      if (!r.powered) {
        const t = Math.min(1, introT / ROOT_IGNITE_S);
        r.charge.snap(t * t * (3 - 2 * t));
        if (introT >= ROOT_IGNITE_S) {
          powerOn(r);
          r.fill.snap(1);
          r.charge.target = 0;
        }
      }
      if (r.powered && !rootFeed(0).started) rootFeed(0).started = true;
      sections.forEach((sec, s) => {
        if (sec.manual || sec.open) return;
        const sw = nodes[sec.switchNode];
        if (sw.powered && sec.openAt === Infinity) sec.openAt = introT + OPEN_DELAY_S;
        if (introT >= sec.openAt) setOpen(s, true, false);
      });
      // About me open: the Projects corridor follows.
      if (sections[1] && !rootFeed(1).started && introT >= sections[0].openedAt + NEXT_FEED_S) rootFeed(1).started = true;
      if (sections[1] && !rootFeed(1).started && sections[0].manual && !sections[0].open && r.powered) {
        // About me was closed by hand before it opened: carry on to Projects.
        rootFeed(1).started = true;
      }
      const settled =
        r.powered &&
        feeds.every((f) => f.section >= 0 || (f.started && f.d >= f.len + FRONT_STEPS)) &&
        sections.every(
          (sec) =>
            (sec.manual || sec.open) &&
            Math.abs(sec.front.value - sec.front.target) < 0.002 &&
            Math.abs(sec.shift.value - sec.shift.target) < 0.002,
        ) &&
        nodes.every((n) => Math.abs(n.fill.value - n.fill.target) < 0.01);
      if (settled) {
        introT = Infinity;
        delete root.dataset.intro;
      }
    }
    updatePower();
  }

  /** Ambient wanderers fade in once the root is lit (counted packets only exist on fed branches). */
  function maskElectrons() {
    if (!scene || introT === Infinity) return;
    const g = scene.game;
    const m = Math.min(1, Math.max(0, (introT - ROOT_IGNITE_S) / 1.5));
    if (m >= 1) return;
    for (let i = 0; i < g.count; i++) if (g.ambient[i]) g.bright[i] *= m;
  }

  // ----------------------------------------------------------- painting
  function paintCorridors() {
    if (!scene) return;
    const { segs, uses, alpha } = scene;
    const d = feeds.map((_, f) => feedD(f));
    const hot = feeds.map((f) => f.users.reduce((m, k) => Math.max(m, nodes[k].glow.value), 0));
    for (let i = 0; i < segs.length; i++) {
      let a = 0;
      for (const u of uses[i]) {
        const lit = Math.min(1, Math.max(0, (d[u.feed] - u.step) / FRONT_STEPS));
        if (lit <= 0) continue;
        a = Math.max(a, lit * (CORRIDOR_REST + (1 - CORRIDOR_REST) * Math.min(1, Math.max(0, hot[u.feed]))));
      }
      alpha[i] = a;
    }
    const v = squeeze();
    if (v > 0) {
      // ABOUT ME's freed rows close up: corridors through them shrink (and fade), the rest slides.
      const at = scene.bandAt;
      const k = sections[0].rows;
      const mapped = segs.map((seg, i) => {
        const mid = (seg.r0 + seg.r1) / 2;
        if (mid > at && mid < at + k) alpha[i] *= 1 - v;
        return { ...seg, r0: mapRow(seg.r0), r1: mapRow(seg.r1) };
      });
      corridors.draw(mapped, alpha);
    } else corridors.draw(segs, alpha);
  }

  /** How far ABOUT ME's freed rows are squeezed shut (0 open .. 1 shut); 0 in wide. */
  function squeeze() {
    return sections[0]?.rows ? Math.min(1, Math.max(0, sections[0].shift.value)) : 0;
  }

  /** A lattice row in the engine's (expanded) layout → where it's drawn now. */
  function mapRow(y: number) {
    const v = squeeze();
    if (!scene || v <= 0) return y;
    const at = scene.bandAt;
    const k = sections[0].rows;
    if (y <= at) return y;
    if (y >= at + k) return y - v * k;
    return at + (y - at) * (1 - v);
  }

  /** Electrons follow the squeeze: below the freed rows they slide up, inside them they shrink and fade. */
  function mapElectrons() {
    const v = squeeze();
    if (!scene || v <= 0) return;
    const g = scene.game;
    const at = scene.bandAt;
    const k = sections[0].rows;
    const fade = Math.max(0, 1 - 2 * v);
    for (let i = 0; i < g.count; i++) {
      const y = g.y[i];
      if (y <= at) continue;
      if (y < at + k) g.bright[i] *= fade;
      g.y[i] = mapRow(y);
    }
  }

  /** Draw the flow right after a step (the masks rewrite this step's outputs, once). */
  function drawFlow(dt: number) {
    if (!scene) return;
    maskElectrons();
    mapElectrons();
    renderer.draw(scene.game, dt);
  }

  /**
   * Collapse: the front drains back to the switch, then what follows slides up. Expand:
   * the slide comes back down first, then the front goes out. Both follow `open` from
   * wherever the springs are, so a click mid-way reverses cleanly.
   */
  function gate(sec: Section) {
    if (sec.open) {
      sec.shift.target = 0;
      sec.front.target = !sec.rows || sec.shift.value < OPEN_AFTER ? 1 : 0;
    } else {
      sec.front.target = 0;
      if (!sec.rows || sec.front.value < SHIFT_AFTER) sec.shift.target = 1;
    }
  }

  /** Reduced motion or no loop: land a section's front and slide in order. */
  function land(sec: Section) {
    gate(sec);
    sec.shift.snap(sec.shift.target);
    gate(sec);
    sec.front.snap(sec.front.target);
    gate(sec);
    sec.shift.snap(sec.shift.target);
  }

  /** What follows ABOUT ME slides with it; the menu shortens by every collapsed section's rows. */
  function paintShift() {
    if (!scene) return;
    const s = scene.lat.spacing;
    const dy = -squeeze() * (sections[0]?.rows ?? 0) * s;
    for (const n of nodes) {
      const top = n.top0 + (n.section === 1 ? dy : 0);
      if (n.paint.top === top) continue;
      n.paint.top = top;
      n.item.style.top = `${top}px`;
    }
    const freed = sections.reduce((sum, sec) => sum + Math.min(1, Math.max(0, sec.shift.value)) * sec.rows, 0);
    const h = Math.max(scene.minHeight, scene.fullHeight - freed * s);
    const shown = `${h.toFixed(1)}px`;
    if (content.style.height !== shown) content.style.height = shown;
  }

  function paintNode(n: MNode) {
    const set = (prop: string, v: number, digits = 3) => {
      const s = Number(v.toFixed(digits));
      if (n.paint[prop] === s) return;
      n.paint[prop] = s;
      (prop === '--shown' ? n.item : n.el).style.setProperty(prop, String(s));
    };
    set('--lift', n.lift.value, 2);
    set('--press', n.press.value);
    set('--pulse', Math.max(0, n.pulse.value));
    set('--glow', Math.max(0, n.glow.value));
    set('--charge', Math.min(1, Math.max(0, n.charge.value)));
    set('--power', Math.min(1, Math.max(0, n.power.value)));
    if (n.role === 'child') set('--shown', Math.min(1, Math.max(0, n.shown.value)));
    const f = Number((Math.min(1, Math.max(0, n.fill.value)) * 100).toFixed(1));
    if (n.ring && n.paint.fill !== f) {
      n.paint.fill = f;
      n.ring.style.strokeDasharray = `${f} 100`;
    }
  }

  /** Fence between its collapsed (switch-only) and expanded rect, leading the front on the way out. */
  function paintSection(sec: Section) {
    const L = sec.layout;
    if (!L || !scene) return;
    const t = Math.min(1, Math.max(0, sec.front.value * 1.6));
    const e = t * t * (3 - 2 * t);
    const lerp = (a: number, b: number) => a + (b - a) * e;
    const r: LatticeRect = {
      c0: lerp(L.collapsed.c0, L.fence.c0),
      r0: lerp(L.collapsed.r0, L.fence.r0),
      c1: lerp(L.collapsed.c1, L.fence.c1),
      r1: lerp(L.collapsed.r1, L.fence.r1),
    };
    const s = scene.lat.spacing;
    const root0 = nodes[0];
    const x0 = root0.x + r.c0 * s;
    const y0 = root0.y + r.r0 * s - (sec === sections[1] ? squeeze() * sections[0].rows * s : 0);
    const key = `${x0.toFixed(1)},${y0.toFixed(1)},${((r.c1 - r.c0) * s).toFixed(1)},${((r.r1 - r.r0) * s).toFixed(1)}`;
    if (key !== sec.fenceShown) {
      sec.fenceShown = key;
      sec.fence.style.left = `${x0}px`;
      sec.fence.style.top = `${y0}px`;
      sec.fence.style.width = `${(r.c1 - r.c0) * s}px`;
      sec.fence.style.height = `${(r.r1 - r.r0) * s}px`;
    }
    const sw = nodes[sec.switchNode];
    sw.el.style.setProperty('--chev', Math.min(1, Math.max(0, sec.chev.value)).toFixed(3));
    sw.el.style.setProperty('--open', e.toFixed(3));
  }

  function paintAll() {
    nodes.forEach(paintNode);
    sections.forEach(paintSection);
    paintShift();
  }

  function stepAll(dt: number) {
    for (const n of nodes) for (const s of springs(n)) s.step(dt);
    for (const sec of sections) {
      gate(sec);
      sec.front.step(dt);
      sec.shift.step(dt);
      sec.chev.step(dt);
    }
    paintAll();
  }

  /** Land every spring (reduced motion, or no loop) and paint. */
  function settle() {
    for (const n of nodes) for (const s of springs(n)) s.snap(s.target);
    for (const sec of sections) {
      land(sec);
      sec.chev.snap(sec.chev.target);
    }
    updatePower();
    for (const n of nodes) for (const s of springs(n)) s.snap(s.target);
    paintAll();
    paintCorridors();
  }

  /** Something changed: let the loop animate it, or land it at once when there's no loop. */
  function kick() {
    if (raf) return;
    start();
    if (!raf) settle();
  }

  // ------------------------------------------------------------- input
  function setHot(k: number, on: boolean) {
    const n = nodes[k];
    if (n.hot === on) return;
    n.hot = on;
    n.el.classList.toggle('is-hot', on);
    n.lift.target = on && !reduced() && n.role === 'child' ? LIFT_PX : 0;
    n.glow.target = on ? 1 : 0;
    n.pulse.target = on ? 0.3 : 0;
    if (on && !reduced()) n.pulse.velocity += 8;
    setFocus(on ? k : nodes.findIndex((m) => m.hot));
    kick();
  }

  /** Node `k` (−1: none) pulls the flow toward itself. */
  function setFocus(k: number) {
    if (k === focus) return;
    focus = k;
    scene?.game.setFocus(k, FOCUS_SHARE);
    if (reduced()) still();
  }

  function discharge(n: MNode) {
    n.clicked = false;
    n.charge.target = 0;
    kick();
  }

  function hint(n: MNode) {
    n.el.classList.add('is-hinting');
    clearTimeout(n.hintTimer);
    n.hintTimer = window.setTimeout(() => n.el.classList.remove('is-hinting'), HINT_MS);
  }

  /** Press feedback on pointer-down: the charge sweep and a slight press-in; let go unless it navigates. */
  function press(n: MNode, e: PointerEvent) {
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
  }

  nodes.forEach((n, k) => {
    if (n.role === 'root') return;
    n.el.addEventListener('pointerenter', () => setHot(k, true));
    n.el.addEventListener('pointerleave', () => setHot(k, false));
    n.el.addEventListener('focus', () => setHot(k, true));
    n.el.addEventListener('blur', () => setHot(k, false));
    n.el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (n.soon) return hint(n);
      press(n, e);
    });
  });

  // Switches toggle on click, so keyboard and assistive tech work too.
  sections.forEach((sec, s) => {
    sec.button.addEventListener('click', () => {
      const n = nodes[sec.switchNode];
      n.clicked = false;
      window.setTimeout(() => discharge(n), 260);
      setOpen(s, !sec.open, true);
    });
  });

  for (const n of nodes) {
    if (n.role !== 'child') continue;
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
      const url = new URL((n.el as HTMLAnchorElement).href, location.href);
      if (url.origin === location.origin && PROJECT_PATH.test(url.pathname)) {
        markTransition(n, url.pathname);
      } else if (url.origin === location.origin && url.pathname === location.pathname && url.hash) {
        // A section node scrolls to its anchor: the page stays, so let go after the press reads.
        window.setTimeout(() => discharge(n), 450);
      }
    });
  }

  /**
   * Clicked project: name its glyph for the morph (only this one, so names stay unique) and
   * record its viewport circle. Base.astro's `pageswap` refreshes the record where supported.
   */
  function markTransition(n: MNode, path: string) {
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
  /** Reduced motion: run the flow offline, then draw one still frame. */
  function still() {
    if (!scene) return;
    if (introT !== Infinity) {
      introT = Infinity;
      delete root.dataset.intro;
      if (!nodes[0].powered) powerOn(nodes[0], true);
      for (const f of feeds) if (f.section < 0) (f.started = true), (f.d = Infinity);
      sections.forEach((sec, s) => sec.manual || setOpen(s, true, false, true));
    }
    settle();
    for (let k = 0; k < STILL_S / SIM_DT; k++) scene.game.step(SIM_DT);
    drawFlow(0);
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
    advance(dt);
    scene?.game.step(dt);
    stepAll(dt);
    drawFlow(dt);
    paintCorridors();
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

  let resizeTimer = 0;
  let lastWidth = root.getBoundingClientRect().width;
  new ResizeObserver(() => {
    const w = root.getBoundingClientRect().width;
    if (w === lastWidth) return; // our own height changes don't matter
    lastWidth = w;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(build, 120);
  }).observe(root);

  build();
  paintAll();
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
    feeds,
    /** Section state: open (target), how far its front is, who took it over, children powered. */
    get sections() {
      return sections.map((sec) => ({
        key: sec.key,
        open: sec.open,
        expanded: sec.button.getAttribute('aria-expanded') === 'true',
        front: Number(sec.front.value.toFixed(3)),
        /** Stacked and column: rows freed when collapsed, and how far what follows has slid up (0..1). */
        rows: sec.rows,
        shift: Number(sec.shift.value.toFixed(3)),
        manual: sec.manual,
        inert: sec.list.inert,
        switchPowered: nodes[sec.switchNode].powered,
        children: sec.children.length,
        powered: sec.children.filter((k) => nodes[k].powered).length,
        fed: sec.children.filter((k) => scene?.game.isLoadEnabled(k)).length,
      }));
    },
    toggle(key: string) {
      const s = sections.findIndex((sec) => sec.key === key);
      if (s >= 0) setOpen(s, !sections[s].open, true);
    },
    get layout() {
      return scene?.layout;
    },
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
