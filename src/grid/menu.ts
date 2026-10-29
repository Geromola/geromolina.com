import {
  GridGame,
  MENU_PX,
  bandSqueeze,
  circuitPaths,
  circuitTransformers,
  menuBands,
  menuLayout,
  squeezeRow,
  visibleBounds,
  type Band,
  type GameNode,
  type LatticeRect,
  type MenuCategoryLayout,
  type MenuLayout,
  type MenuSectionLayout,
} from './game';
import type { Lattice } from './layout';
import { CanvasRenderer, CorridorLayer, WebGLRenderer, drawMesh, type CorridorSegment, type Renderer } from './renderers';
import { Spring } from './spring';

/**
 * DOM wiring for the home hero (SPEC "Home hero v3: the node menu", "Home hero
 * v4"). The root node "Gero" powers its links (About, Off the grid, Contact:
 * small nodes beside it) and two fenced sections, NEWS WIRE and PROJECTS, each
 * behind a switch node that expands and collapses it like a dropdown on the
 * grid. Everything sits on lattice vertices (`menuLayout`); a decorative
 * `GridGame` runs the flow root → link and root → switch → child along
 * hidden-transformer corridors, and a section's children are only fed while
 * it's open. On load the power-on runs in sequence (root and its links, News
 * wire, Projects); input works throughout. The game itself stays DOM-free in
 * `./game`.
 *
 * PROJECTS by category (SPEC "Projects menu by category"): the switch feeds a
 * header per category down the trunk, and each header its cards. A category
 * shows its first few cards; "Show more" reveals the rest. The engine always
 * runs on the fully expanded layout: a collapsed category's hidden cards are
 * disabled loads (no anchors), and its rows are squeezed shut on screen
 * (`menuBands`), the way NEWS WIRE's are.
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
const NEXT_FEED_S = 0.7; // after News wire opens, the Projects corridor starts
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
/** sessionStorage: the expanded categories, so a return visit in the tab keeps them. */
const CATS_KEY = 'gero-menu-cats';
/** The root glyph's radius (its plate sits beside it). */
const ROOT_R = MENU_PX.rootGlyph / 2;
/** The full news wire's URL hash. */
const NEWS_HASH = '#news';
/** Shares of new packets a heading gets (a section switch, a category header): more current on the trunk. */
const SWITCH_WEIGHT = 4;
const HEADER_WEIGHT = 2;
/** Corridor alpha at rest on the trunk (root → switch → header), and its stroke scale. */
const TRUNK_REST = 0.72;

type Role = 'root' | 'switch' | 'header' | 'child';

interface MNode {
  role: Role;
  /** The element the CSS vars go on (header, button or link). */
  el: HTMLElement;
  /** The absolutely placed element. */
  item: HTMLElement;
  glyph: HTMLElement;
  ring: SVGPathElement | null;
  id: string;
  /** Section index (0 news, 1 projects), −1 for the root and its links. */
  section: number;
  /** The node a hidden plate retracts into (its switch, its category header, or the root for a link); −1 for the root. */
  parent: number;
  /** Its vertex in layout units (the root at 0, 0), expanded. */
  col: number;
  row: number;
  soon: boolean;
  /** Not on the map in this layout (NEWS WIRE's other stories while only its top ones show). */
  off: boolean;
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
  /** Longest chain of corridors from the switch (segments): the front's full reach. */
  reach: number;
}

/** A PROJECTS category: a header node, its cards, and a Show more control when some are hidden. */
interface Category {
  id: string;
  /** Its section, and its index among that section's categories. */
  section: number;
  local: number;
  el: HTMLElement;
  list: HTMLElement;
  more: HTMLButtonElement | null;
  /** Node indices. */
  head: number;
  cards: number[];
  /** Target state: every card shown. */
  open: boolean;
  /** The hidden cards' energy front (0 .. 1), and how far its band is squeezed (0 expanded .. 1 collapsed). */
  front: Spring;
  shift: Spring;
  /** From the layout: cards shown while collapsed, and the rows the rest add. */
  visible: number;
  rows: number;
  layout: MenuCategoryLayout | null;
  /** Where its Show more control was last painted. */
  moreShown: string;
  /** On the map in this layout (a hidden one is dark, out of reach, and not in the flow). */
  active: boolean;
}

/** Springs that open and close something in order: a section or a category. */
interface Gated {
  open: boolean;
  rows: number;
  front: Spring;
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
  /** The feed before it in the chain (switch → header → card), −1 when it leaves the switch. */
  parent: number;
  /** A card's category and its index in it (−1 otherwise): hidden cards also wait for the category's front. */
  cat: number;
  slot: number;
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
  /** Node index → its index in the game (−1: not on the map). */
  gi: Int32Array;
  segs: CorridorSegment[];
  /** Per segment: the feeds through it and the step index along each. */
  uses: { feed: number; step: number }[][];
  alpha: Float32Array;
  /** The root's lattice vertex: layout units → lattice units (the engine's and the renderers'). */
  rootCol: number;
  rootRow: number;
  /** Pixel position of layout row 0, and the least height the menu may be. */
  originY: number;
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
  const makeNode = (role: Role, el: HTMLElement, item: HTMLElement, glyph: HTMLElement, section: number, parent = -1): MNode => ({
    role,
    el,
    item,
    glyph,
    ring: glyph.querySelector<SVGPathElement>('[data-ring]'),
    id: el.dataset.id ?? role,
    section,
    parent,
    col: 0,
    row: 0,
    soon: el.hasAttribute('data-soon'),
    off: false,
    fillTo: Number(el.dataset.fill ?? 1),
    lift: new Spring(0, 0.25, 1),
    press: new Spring(1, 0.15, 1),
    pulse: new Spring(0, 0.5),
    glow: new Spring(0, 0.25),
    charge: new Spring(0, 0.22, 1),
    fill: new Spring(0, RING_S),
    power: new Spring(0, RING_S),
    shown: new Spring(role === 'child' || role === 'header' ? 0 : 1, SHOW_RESPONSE),
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
  const rootGlyph = $('[data-root-glyph]', rootEl);
  const rootPlate = $('[data-root-plate]', rootEl);
  const nodes: MNode[] = [makeNode('root', rootEl, rootEl, rootGlyph, -1)];
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
      reach: 1,
    };
  });
  // The root's links: small nodes fed straight from the root (no switch).
  const linkNodes = [...root.querySelectorAll<HTMLElement>('[data-link]')].map((a) => {
    nodes.push(makeNode('child', a, a, $('[data-link-glyph]', a), -1, 0));
    return nodes.length - 1;
  });
  // Categories expanded earlier in this tab.
  let remembered: string[] = [];
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(CATS_KEY) || '[]');
    if (Array.isArray(v)) remembered = v.filter((x): x is string => typeof x === 'string');
  } catch {
    /* storage unavailable: everything starts collapsed */
  }
  const cats: Category[] = [];
  const child = (a: HTMLElement, s: number, parent: number) => {
    nodes.push(makeNode('child', a, a.closest<HTMLElement>('[data-menu-item]') ?? a, $('[data-menu-glyph]', a), s, parent));
    sections[s].children.push(nodes.length - 1);
    return nodes.length - 1;
  };
  sections.forEach((sec, i) => {
    const catEls = [...sec.el.querySelectorAll<HTMLElement>('[data-cat]')];
    if (!catEls.length) {
      for (const a of sec.el.querySelectorAll<HTMLElement>('[data-menu-node]')) child(a, i, sec.switchNode);
      return;
    }
    for (const el of catEls) {
      const headEl = $('[data-cat-head]', el);
      nodes.push(makeNode('header', headEl, headEl, $('[data-cat-glyph]', headEl), i, sec.switchNode));
      const head = nodes.length - 1;
      sec.children.push(head);
      const id = el.dataset.cat ?? String(cats.length);
      // NEWS WIRE's categories don't collapse: the wire shows its top stories or all of them.
      const open = i === 0 ? false : remembered.includes(id);
      cats.push({
        id,
        section: i,
        local: cats.filter((c) => c.section === i).length,
        active: true,
        el,
        list: $('[data-cat-list]', el),
        more: el.querySelector<HTMLButtonElement>('[data-cat-more]'),
        head,
        cards: [...el.querySelectorAll<HTMLElement>('[data-menu-node]')].map((a) => child(a, i, head)),
        open,
        front: new Spring(open ? 1 : 0, SECTION_RESPONSE, 1),
        shift: new Spring(open ? 0 : 1, SHIFT_RESPONSE, 1),
        visible: Infinity,
        rows: 0,
        layout: null,
        moreShown: '',
      });
    }
  });
  const projectCats = cats.filter((c) => c.section === 1);
  const newsCats = cats.filter((c) => c.section === 0);
  const catOf = new Map(cats.flatMap((c, k) => [[c.head, k] as const, ...c.cards.map((n) => [n, k] as const)]));
  // The full news wire (SPEC "Home hero v4"): every story across the page, PROJECTS collapsed
  // under it. Its back control sits on NEWS WIRE's fence, top right.
  const backEl = root.querySelector<HTMLButtonElement>('[data-news-back]');
  let newsFull = newsCats.length > 0 && location.hash === NEWS_HASH;
  let projectsWasOpen = true;

  // The circuit: root → each switch → its children; in PROJECTS, switch → each header → its cards.
  const feeds: FeedState[] = sections.map((sec) => ({
    from: 0,
    to: sec.switchNode,
    len: 1,
    d: 0,
    started: false,
    section: -1,
    parent: -1,
    cat: -1,
    slot: -1,
    users: [sec.switchNode, ...sec.children],
  }));
  sections.forEach((sec, i) => {
    for (const k of sec.children) {
      const n = nodes[k];
      if (n.role === 'child' && n.parent !== sec.switchNode) continue;
      const cat = catOf.get(k) ?? -1;
      const users = cat >= 0 ? [k, ...cats[cat].cards] : [k];
      feeds.push({ from: sec.switchNode, to: k, len: 1, d: 0, started: true, section: i, parent: -1, cat: -1, slot: -1, users });
      if (cat < 0) continue;
      const parent = feeds.length - 1;
      cats[cat].cards.forEach((card, slot) =>
        feeds.push({ from: k, to: card, len: 1, d: 0, started: true, section: i, parent, cat, slot, users: [card] }),
      );
    }
  });
  const rootFeed = (s: number) => feeds[s];
  /** The trunk: root → switch and switch → category header, drawn heavier. */
  const isTrunk = (f: FeedState) => nodes[f.to].role === 'switch' || nodes[f.to].role === 'header';
  const linkFeeds: FeedState[] = linkNodes.map((k) => ({
    from: 0,
    to: k,
    len: 1,
    d: 0,
    started: false,
    section: -1,
    parent: -1,
    cat: -1,
    slot: -1,
    users: [k],
  }));
  feeds.push(...linkFeeds);
  computeReach();

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
  // Arriving on the full wire (`#news`): PROJECTS waits, collapsed, under it.
  if (backEl) backEl.hidden = !newsFull;
  if (newsFull && sections[1]) {
    projectsWasOpen = true;
    setOpen(1, false, true, true);
  }

  // ------------------------------------------------------------ layout
  /** (Re)build positions and the scene for the menu's width. False when nothing changed. */
  function build(): boolean {
    const width = root.getBoundingClientRect().width;
    // Not laid out yet (a hidden tab or a zero-size frame): the ResizeObserver builds once it has a width.
    if (width < 160) return false;
    const gutter = Math.min(32, Math.max(16, width * 0.03));
    rootEl.style.maxWidth = '';
    const counts = {
      news: newsCats.length ? newsCats.map((c) => c.cards.length) : sections[0].children.length,
      newsFull,
      projects: projectCats.length ? projectCats.map((c) => c.cards.length) : (sections[1]?.children.length ?? 0),
      links: linkNodes.length,
      // How far the root's plate reaches right of its vertex (the glyph's centre): the links go
      // beside it when they fit. Measured on the plate itself, which never stretches.
      rootW: rootPlate.getBoundingClientRect().right - (rootGlyph.getBoundingClientRect().left + ROOT_R),
    };
    let layout = menuLayout(width, { ...counts, gutter });
    const key = `${width}|${layout.mode}|${window.devicePixelRatio}|${newsFull}`;
    if (scene && scene.key === key) return false;
    const t0 = performance.now();
    const s = layout.spacing;
    // Wide and stacked: centred. Column: the fence's left edge on the gutter.
    const ext0 = layout.extent;
    const originX = layout.mode === 'column' ? gutter - ext0.c0 * s : (width - (ext0.c1 - ext0.c0) * s) / 2 - ext0.c0 * s;
    // The root plate may not run past the right gutter.
    const rootLeft = originX + layout.root.col * s - ROOT_R;
    rootEl.style.maxWidth = `${width - gutter - rootLeft}px`;
    const rootHalf = Math.max(ROOT_R, rootEl.offsetHeight / 2);
    const originY = layout.mode === 'column' ? gutter + rootHalf + 4 : gutter + rootHalf - 8;
    // A tall root plate (it wraps on phones) pushes what's under it a row down: the fences clear of
    // the fence label (16px tall on the fence line, with 1px to spare), or the links' glyphs.
    const under = layout.links.placement === 'under' && layout.links.nodes.length > 0;
    const tallRoot = rootHalf + (under ? MENU_PX.compactGlyph / 2 + 8 : 9) > s;
    if (tallRoot) layout = menuLayout(width, { ...counts, gutter, fenceTop: 2 });
    const ext = layout.extent;
    const minHeight = Math.max(window.innerHeight, 560);
    // The engine and the canvases keep the full (expanded) size; collapsing only slides the DOM
    // and squeezes the drawn flow, and the menu itself gets shorter.
    const height = Math.max(minHeight, originY + (ext.r1 + 1) * s);
    // Stacked and column: a collapsed NEWS WIRE gives back its rows (a band), a collapsed PROJECTS
    // only shortens the menu. Wide keeps both in place.
    const stackedRows = (sec: MenuSectionLayout) => (layout.stacked ? sec.fence.r1 - sec.collapsed.r1 : 0);
    sections[0].rows = stackedRows(layout.news);
    if (sections[1]) sections[1].rows = stackedRows(layout.projects);
    const secLayouts = [layout.news, layout.projects];
    cats.forEach((c) => {
      const L = secLayouts[c.section]?.categories?.[c.local] ?? null;
      c.layout = L;
      c.active = !L?.hidden;
      c.visible = L?.visible ?? c.cards.length;
      c.rows = L?.band.rows ?? 0;
      c.moreShown = '';
      // A category with nothing hidden at this width has no control (and stays as it is).
      if (c.more) c.more.hidden = !L?.more;
      markCat(c);
    });
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
      n.col = c;
      n.row = r;
      n.x = p.x;
      n.y = p.y;
    };
    place(nodes[0], layout.root.col, layout.root.row);
    rootEl.style.left = `${nodes[0].x - ROOT_R}px`;
    rootEl.style.top = `${nodes[0].y}px`;
    nodes[0].top0 = nodes[0].y;
    // Off the map in this layout: a hidden category's header, and stories past those it lays out.
    for (const n of nodes) n.off = false;
    cats.forEach((c) => {
      if (!c.active) nodes[c.head].off = true;
      c.cards.forEach((k, j) => {
        if (!c.active || j >= (c.layout?.cards.length ?? c.cards.length)) nodes[k].off = true;
      });
    });
    for (const n of nodes) {
      n.item.hidden = n.off;
      if (n.off) n.item.inert = true;
      else if (n.role === 'header') n.item.inert = false;
    }
    // The links: a one-line plate beside the glyph, or the label under it (phones).
    const LL = layout.links;
    root.dataset.links = LL.style;
    linkNodes.forEach((k, j) => {
      const n = nodes[k];
      const p = LL.nodes[j] ?? LL.nodes[LL.nodes.length - 1] ?? layout.root;
      const cg = MENU_PX.compactGlyph / 2;
      place(n, p.col, p.row);
      const stack = LL.style === 'stack';
      n.item.style.left = `${stack ? n.x - LL.plateW / 2 : n.x - cg}px`;
      n.top0 = stack ? n.y - cg : n.y - Math.max(cg, MENU_PX.compactH / 2);
      n.item.style.setProperty('--item-w', `${stack ? LL.plateW : 2 * cg + MENU_PX.compactGap + LL.plateW}px`);
      n.item.style.setProperty('--fx', `${((nodes[0].x - n.x) * PULL).toFixed(1)}px`);
      n.item.style.setProperty('--fy', `${((nodes[0].y - n.y) * PULL).toFixed(1)}px`);
    });
    sections.forEach((sec, i) => {
      const L = secLayouts[i];
      sec.layout = L;
      sec.fenceShown = '';
      sec.el.dataset.style = L.style;
      const sw = nodes[sec.switchNode];
      place(sw, L.switch.col, L.switch.row);
      sec.button.style.left = `${sw.x - MENU_PX.switchGlyph / 2}px`;
      sw.top0 = sw.y;
      // Placed by the glyph's vertex: hanging plates centred under it, side and compact plates beside it.
      const g = L.style === 'compact' ? MENU_PX.compactGlyph : MENU_PX.glyph;
      const plateH = L.style === 'compact' ? MENU_PX.compactH : MENU_PX.sideH;
      const gap = L.style === 'compact' ? MENU_PX.compactGap : MENU_PX.sideGap;
      const itemW = L.style === 'hang' ? L.plateW : g + gap + L.plateW;
      // Category headers first (cards retract into them), on the trunk like a switch.
      sec.children.forEach((k) => {
        const n = nodes[k];
        if (n.role !== 'header' || n.off) return;
        const at = L.categories?.[cats[catOf.get(k) ?? 0]?.local ?? 0]?.header ?? L.switch;
        place(n, at.col, at.row);
        n.item.style.left = `${n.x - MENU_PX.headerGlyph / 2}px`;
        n.top0 = n.y;
        // The label and tagline stay inside the section's fence (NEWS WIRE sits beside PROJECTS on wide).
        const fenceRight = originX + L.fence.c1 * s - 12;
        n.item.style.setProperty('--head-w', `${Math.min(width - gutter, fenceRight) - n.x + MENU_PX.headerGlyph / 2}px`);
        n.item.style.setProperty('--fx', `${((sw.x - n.x) * PULL).toFixed(1)}px`);
        n.item.style.setProperty('--fy', `${((sw.y - n.y) * PULL).toFixed(1)}px`);
      });
      let flat = 0;
      sec.children.forEach((k) => {
        const n = nodes[k];
        if (n.role !== 'child') return;
        // A category's card takes its own slot there; plain children go in order.
        const cat = cats[catOf.get(k) ?? -1];
        const c = cat ? cat.layout?.cards[cat.cards.indexOf(k)] : (L.children[flat] ?? L.children[L.children.length - 1]);
        flat++;
        if (!c || n.off) return;
        place(n, c.col, c.row);
        const left = L.style === 'hang' ? n.x - L.plateW / 2 : n.x - g / 2;
        const top = L.style === 'hang' ? n.y - g / 2 : n.y - Math.max(g, plateH) / 2;
        n.item.style.left = `${left}px`;
        n.top0 = top;
        n.item.style.setProperty('--item-w', `${itemW}px`);
        // Hidden, a child sits part of the way toward its switch or header (the plate retracts into it).
        const into = nodes[n.parent] ?? sw;
        n.item.style.setProperty('--fx', `${((into.x - n.x) * PULL).toFixed(1)}px`);
        n.item.style.setProperty('--fy', `${((into.y - n.y) * PULL).toFixed(1)}px`);
      });
    });
    // Show more (and NEWS WIRE's All-stories control): under the last card row, at the row's end
    // (hanging plates) or under the glyphs (side plates).
    cats.forEach((c) => {
      const m = c.layout?.more;
      if (!c.more || !m) return;
      const SL = secLayouts[c.section];
      const p = px(m.col, m.row);
      const x = m.align === 'end' ? p.x + SL.plateW / 2 : p.x - MENU_PX.glyph / 2;
      const top =
        SL.style === 'hang' ? p.y + MENU_PX.hangH + MENU_PX.moreGap : p.y + MENU_PX.sideH / 2 + MENU_PX.moreGap;
      c.more.style.left = `${x}px`;
      c.more.dataset.align = m.align;
      c.more.dataset.top0 = String(top);
    });
    root.dataset.laid = '';
    root.dataset.mode = layout.mode;

    // The game: the root is the plant; switches, headers and children are loads.
    const vertexOf = (n: MNode) => ({ col: Math.round((n.x - ox) / s), row: Math.round((n.y - oy) / s) });
    // Only what's on the map takes part: `gi` maps a node to its game index.
    const gi = new Int32Array(nodes.length).fill(-1);
    const gameNodes: GameNode[] = [];
    nodes.forEach((n, k) => {
      if (n.off) return;
      gi[k] = gameNodes.length;
      gameNodes.push({ id: n.id, kind: n.role === 'root' ? 'plant' : 'section', ...vertexOf(n) });
    });
    const onMap = (f: FeedState) => gi[f.from] >= 0 && gi[f.to] >= 0;
    const verts = lat.cols * lat.rows;
    const game = new GridGame({
      cols: lat.cols,
      rows: lat.rows,
      nodes: gameNodes,
      bounds: visibleBounds(lat, width, height),
      levels: [{ title: 'Menu', plants: [nodes[0].id], loads: gameNodes.slice(1).map((n) => n.id), budget: 0 }],
      count: coarse ? Math.min(700, verts * 4) : Math.min(1500, verts * 6),
      ambientFraction: AMBIENT,
      seed: 0x6d656e75,
      decorative: true,
    });
    const vOf = (k: number) => game.board.vertex(gameNodes[gi[k]].col, gameNodes[gi[k]].row);
    const mapped = feeds.filter(onMap);
    game.setDecorTransformers(
      circuitTransformers(
        game.board,
        game.bounds,
        new Set(gameNodes.map((g) => game.board.vertex(g.col, g.row))),
        mapped.map((f) => ({ from: vOf(f.from), to: vOf(f.to) })),
      ),
    );
    for (const f of mapped) if (f.from !== 0) game.setLoadSource(gi[f.to], gi[f.from]);
    for (let k = 1; k < nodes.length; k++) if (gi[k] >= 0) game.setLoadEnabled(gi[k], nodes[k].powered);
    // Headings draw more of the flow: switches, then category headers.
    nodes.forEach((n, k) => {
      if (gi[k] < 0) return;
      if (n.role === 'switch') game.setLoadWeight(gi[k], SWITCH_WEIGHT);
      else if (n.role === 'header') game.setLoadWeight(gi[k], HEADER_WEIGHT);
    });
    if (focus >= 0 && gi[focus] >= 0) game.setFocus(gi[focus], FOCUS_SHARE);

    // Corridors: one segment per edge, with every feed (and step) that uses it. Off-map feeds
    // have none (and length 1).
    const mappedPaths = circuitPaths(
      game,
      mapped.map((f) => ({ from: gi[f.from], to: gi[f.to] })),
    );
    let m = 0;
    const paths = feeds.map((f) => (onMap(f) ? mappedPaths[m++] : { from: f.from, to: f.to, steps: [] }));
    const segIndex = new Map<number, number>();
    const segs: CorridorSegment[] = [];
    const uses: { feed: number; step: number }[][] = [];
    paths.forEach((p, f) => (feeds[f].len = Math.max(1, p.steps.length)));
    computeReach();
    paths.forEach((p, f) => {
      if (feeds[f].section < 0 && Number.isFinite(feeds[f].d) && feeds[f].d > feeds[f].len + FRONT_STEPS) {
        feeds[f].d = feeds[f].len + FRONT_STEPS;
      }
      p.steps.forEach((step, d) => {
        let i = segIndex.get(step.edge);
        const trunk = isTrunk(feeds[f]);
        if (i === undefined) {
          const { c0, r0, c1, r1 } = game.edgeVertices(step.edge);
          i = segs.push({ c0, r0, c1, r1, high: step.high, trunk }) - 1;
          segIndex.set(step.edge, i);
          uses.push([]);
        } else {
          segs[i].high ||= step.high;
          segs[i].trunk ||= trunk;
        }
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
      gi,
      segs,
      uses,
      alpha: new Float32Array(segs.length),
      rootCol: Math.round((originX - ox) / s),
      rootRow: Math.round((originY - oy) / s),
      originY,
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
  /**
   * Front position (segments) of feed `f`. A section's front runs down its chains (switch →
   * header → card) in one sweep; a hidden card's feed also waits for its category's front.
   */
  function feedD(f: number): number {
    const feed = feeds[f];
    if (feed.section < 0) return feed.d;
    // Off the map: dark.
    if (nodes[feed.to].off) return 0;
    const d =
      feed.parent >= 0
        ? feedD(feed.parent) - feeds[feed.parent].len
        : Math.max(0, sections[feed.section].front.value) * (sections[feed.section].reach + FRONT_STEPS);
    const cat = cats[feed.cat];
    if (!cat || feed.slot < cat.visible) return d;
    return Math.min(d, Math.max(0, cat.front.value) * (feed.len + FRONT_STEPS));
  }

  /** Each section's reach: its longest chain of corridors from the switch. */
  function computeReach() {
    const chain = (f: number): number => feeds[f].len + (feeds[f].parent >= 0 ? chain(feeds[f].parent) : 0);
    sections.forEach((sec, s) => {
      sec.reach = Math.max(1, ...feeds.map((f, i) => (f.section === s ? chain(i) : 0)));
    });
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
    if (k > 0 && scene && scene.gi[k] >= 0) scene.game.setLoadEnabled(scene.gi[k], true);
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
    if (k > 0 && scene && scene.gi[k] >= 0) scene.game.setLoadEnabled(scene.gi[k], false);
  }

  /** Power follows the fronts: a switch once its corridor arrives, anything else while its feed's front covers it. */
  function updatePower() {
    sections.forEach((sec, s) => {
      const sw = nodes[sec.switchNode];
      const f = rootFeed(s);
      if (!sw.powered && f.started && f.d >= f.len) powerOn(sw);
    });
    for (const f of linkFeeds) if (!nodes[f.to].powered && f.started && f.d >= f.len) powerOn(nodes[f.to]);
    feeds.forEach((f, i) => {
      if (f.section < 0) return;
      const reached = feedD(i) >= f.len;
      const n = nodes[f.to];
      if (reached && !n.powered) powerOn(n);
      else if (!reached && n.powered) powerOff(n);
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
    if (!open && sec.list.contains(document.activeElement)) sec.button.focus();
    sec.list.inert = !open;
    updatePower();
    if (now || reduced()) settle();
    else kick();
  }

  /** Expand or collapse category `c` (Show more / Show less). A press mid-way reverses from where it is. */
  function setCatOpen(c: number, open: boolean, now = false) {
    const cat = cats[c];
    cat.open = open;
    gate(cat);
    if (now || reduced()) land(cat);
    markCat(cat);
    updatePower();
    if (reduced()) still();
    else if (now) settle();
    else kick();
    try {
      sessionStorage.setItem(CATS_KEY, JSON.stringify(cats.filter((x) => x.open).map((x) => x.id)));
    } catch {
      /* storage unavailable: the state just isn't remembered */
    }
  }

  /** A category's control and its hidden cards: label, state, and out of reach while collapsed. */
  function markCat(cat: Category) {
    const hidden = cat.cards.length - Math.min(cat.cards.length, cat.visible);
    // NEWS WIRE's All-stories control opens the full wire instead (its label stays).
    if (cat.more && !cat.more.hasAttribute('data-news-all')) {
      cat.more.setAttribute('aria-expanded', String(cat.open));
      const label = cat.more.querySelector('[data-more-label]');
      if (label) label.textContent = cat.open ? 'Show less' : `Show ${hidden} more`;
    }
    const items = cat.cards.map((k) => nodes[k].item);
    const out = items.filter((_, j) => j >= cat.visible && !cat.open);
    // Never lose focus: a card about to go out of reach hands it to the control.
    if (out.some((el) => el.contains(document.activeElement))) cat.more?.focus();
    items.forEach((el) => (el.inert = out.includes(el)));
  }

  /**
   * The full news wire on or off (SPEC "Home hero v4"): NEWS WIRE's front drains back to its
   * switch, the menu re-lays out (every story across the width, PROJECTS collapsed under it, or
   * back to the top stories), and the front runs out again, so the stories power on along the
   * grid one by one. `push`: record it in history (the browser's back returns).
   */
  function setNewsFull(full: boolean, push = true) {
    if (!newsCats.length || full === newsFull) return;
    newsFull = full;
    if (push) {
      try {
        history.pushState({ news: full }, '', full ? NEWS_HASH : location.pathname + location.search);
      } catch {
        /* history unavailable: the view still changes */
      }
    }
    const wire = sections[0];
    const proj = sections[1];
    if (proj && full) {
      projectsWasOpen = proj.open;
      if (proj.open) setOpen(1, false, true, true);
    }
    // Dark from the switch out, at once: the new layout's stories light as the front reaches them.
    wire.front.snap(0);
    for (const k of wire.children) {
      const n = nodes[k];
      n.shown.snap(0);
      n.power.snap(0);
      n.fill.snap(0);
      n.powered = false;
    }
    build();
    setOpen(0, true, true);
    if (proj && !full && projectsWasOpen) setOpen(1, true, true);
    if (backEl) backEl.hidden = !full;
    // Bring the wire's switch into view.
    const sw = nodes[wire.switchNode];
    const top = root.getBoundingClientRect().top + window.scrollY + sw.y - 96;
    window.scrollTo({ top: Math.max(0, top), behavior: reduced() ? 'auto' : 'smooth' });
    kick();
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
      // The links light with the first corridor.
      if (r.powered) for (const f of linkFeeds) f.started = true;
      sections.forEach((sec, s) => {
        if (sec.manual || sec.open) return;
        const sw = nodes[sec.switchNode];
        if (sw.powered && sec.openAt === Infinity) sec.openAt = introT + OPEN_DELAY_S;
        if (introT >= sec.openAt) setOpen(s, true, false);
      });
      // News wire open: the Projects corridor follows.
      if (sections[1] && !rootFeed(1).started && introT >= sections[0].openedAt + NEXT_FEED_S) rootFeed(1).started = true;
      if (sections[1] && !rootFeed(1).started && sections[0].manual && !sections[0].open && r.powered) {
        // News wire was closed by hand before it opened: carry on to Projects.
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
        const rest = isTrunk(feeds[u.feed]) ? TRUNK_REST : CORRIDOR_REST;
        a = Math.max(a, lit * (rest + (1 - rest) * Math.min(1, Math.max(0, hot[u.feed]))));
      }
      alpha[i] = a;
    }
    const b = bands();
    if (b.length) {
      // Collapsed rows close up: corridors through them shrink (and fade), the rest slides.
      const { rootCol, rootRow } = scene;
      const mapped = segs.map((seg, i) => {
        const col = (seg.c0 + seg.c1) / 2 - rootCol;
        alpha[i] *= 1 - bandSqueeze((seg.r0 + seg.r1) / 2 - rootRow, col, b);
        return { ...seg, r0: squeezeRow(seg.r0 - rootRow, col, b) + rootRow, r1: squeezeRow(seg.r1 - rootRow, col, b) + rootRow };
      });
      corridors.draw(mapped, alpha);
    } else corridors.draw(segs, alpha);
  }

  /**
   * The rows squeezed shut right now (layout units): NEWS WIRE's while it collapses (stacked,
   * column) and each collapsed category's hidden rows. Empty when nothing is squeezed.
   */
  function bands(): Band[] {
    if (!scene) return [];
    const v = (x: Spring) => Math.min(1, Math.max(0, x.value));
    return menuBands(scene.layout, {
      news: sections[0] ? v(sections[0].shift) : 0,
      categories: projectCats.map((c) => v(c.shift)),
    }).filter((b) => b.v > 0);
  }

  /** Electrons follow the squeeze: below squeezed rows they slide up, inside them they shrink and fade. */
  function mapElectrons() {
    const b = bands();
    if (!scene || !b.length) return;
    const g = scene.game;
    const { rootCol, rootRow } = scene;
    for (let i = 0; i < g.count; i++) {
      const row = g.y[i] - rootRow;
      const col = g.x[i] - rootCol;
      const v = bandSqueeze(row, col, b);
      if (v > 0) g.bright[i] *= Math.max(0, 1 - 2 * v);
      g.y[i] = squeezeRow(row, col, b) + rootRow;
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
  function gate(sec: Gated) {
    if (sec.open) {
      sec.shift.target = 0;
      sec.front.target = !sec.rows || sec.shift.value < OPEN_AFTER ? 1 : 0;
    } else {
      sec.front.target = 0;
      if (!sec.rows || sec.front.value < SHIFT_AFTER) sec.shift.target = 1;
    }
  }

  /** Reduced motion or no loop: land a section's front and slide in order. */
  function land(sec: Gated) {
    gate(sec);
    sec.shift.snap(sec.shift.target);
    gate(sec);
    sec.front.snap(sec.front.target);
    gate(sec);
    sec.shift.snap(sec.shift.target);
  }

  /**
   * Everything under squeezed rows slides up with them (the Show more controls too); the menu
   * ends under the lower fence (wide), or under PROJECTS, shut as far as its switch (stacked, column).
   */
  function paintShift() {
    if (!scene) return;
    const s = scene.lat.spacing;
    const b = bands();
    const up = (row: number, col: number) => (row - squeezeRow(row, col, b)) * s;
    for (const n of nodes) {
      const top = n.top0 - (n.role === 'root' ? 0 : up(n.row, n.col));
      if (n.paint.top === top) continue;
      n.paint.top = top;
      n.item.style.top = `${top}px`;
    }
    for (const c of cats) paintMore(c, up);
    const L = scene.layout;
    const pc = L.projects.fence.c0 + 1;
    const open = squeezeRow(L.projects.fence.r1, pc, b);
    let bottom: number;
    if (!L.stacked) bottom = Math.max(L.news.ownR1, open);
    else {
      const shut = squeezeRow(L.projects.collapsed.r1, pc, b);
      bottom = open + (shut - open) * Math.min(1, Math.max(0, sections[1]?.shift.value ?? 0));
    }
    const h = Math.max(scene.minHeight, scene.originY + (bottom + 1) * s);
    const shown = `${h.toFixed(1)}px`;
    if (content.style.height !== shown) content.style.height = shown;
  }

  /** A category's Show more control: under its last shown row, there as soon as its header is. */
  function paintMore(c: Category, up: (row: number, col: number) => number) {
    const m = c.layout?.more;
    if (!c.more || !m) return;
    const top = Number(c.more.dataset.top0) - up(m.row, m.col);
    const shown = Math.min(1, Math.max(0, nodes[c.head].shown.value));
    const key = `${top.toFixed(1)}|${shown.toFixed(3)}`;
    if (key === c.moreShown) return;
    c.moreShown = key;
    c.more.style.top = `${top}px`;
    c.more.style.setProperty('--shown', shown.toFixed(3));
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
    if (n.role === 'child' || n.role === 'header') set('--shown', Math.min(1, Math.max(0, n.shown.value)));
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
    // Both rects as drawn through the squeezed rows. Wide: both fences end on the lower bottom.
    const b = bands();
    const col = L.fence.c0 + 1;
    const at = (row: number) => squeezeRow(row, col, b);
    const lay = scene.layout;
    const r1 =
      !lay.stacked
        ? Math.max(lay.news.ownR1, squeezeRow(lay.projects.fence.r1, lay.projects.fence.c0 + 1, b))
        : at(L.fence.r1);
    const r: LatticeRect = {
      c0: lerp(L.collapsed.c0, L.fence.c0),
      r0: lerp(at(L.collapsed.r0), at(L.fence.r0)),
      c1: lerp(L.collapsed.c1, L.fence.c1),
      r1: lerp(at(L.collapsed.r1), r1),
    };
    const s = scene.lat.spacing;
    const root0 = nodes[0];
    const x0 = root0.x + r.c0 * s;
    const y0 = root0.y + r.r0 * s;
    const key = `${x0.toFixed(1)},${y0.toFixed(1)},${((r.c1 - r.c0) * s).toFixed(1)},${((r.r1 - r.r0) * s).toFixed(1)}`;
    if (key !== sec.fenceShown) {
      sec.fenceShown = key;
      sec.fence.style.left = `${x0}px`;
      sec.fence.style.top = `${y0}px`;
      sec.fence.style.width = `${(r.c1 - r.c0) * s}px`;
      sec.fence.style.height = `${(r.r1 - r.r0) * s}px`;
    }
    // The full wire's back control rides NEWS WIRE's fence, on its top edge at the right.
    if (sec === sections[0] && backEl) {
      backEl.style.left = `${x0 + (r.c1 - r.c0) * s - 12}px`;
      backEl.style.top = `${y0}px`;
      backEl.style.setProperty('--open', e.toFixed(3));
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
    for (const c of cats) {
      gate(c);
      c.front.step(dt);
      c.shift.step(dt);
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
    for (const c of cats) land(c);
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
    scene?.game.setFocus(k >= 0 ? scene.gi[k] : -1, FOCUS_SHARE);
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
    // A header isn't a control: hovering it pulls the flow, its Show more does the rest.
    if (n.role === 'header') return;
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

  // Show more / Show less: the header answers on pointer-down (its charge sweep) and pulls the
  // flow while the control is hovered or focused; the click toggles, so keyboards work too.
  cats.forEach((c, i) => {
    const btn = c.more;
    if (!btn) return;
    const head = nodes[c.head];
    btn.addEventListener('pointerenter', () => setHot(c.head, true));
    btn.addEventListener('pointerleave', () => setHot(c.head, false));
    btn.addEventListener('focus', () => setHot(c.head, true));
    btn.addEventListener('blur', () => setHot(c.head, false));
    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      press(head, e);
    });
    btn.addEventListener('click', () => {
      head.clicked = false;
      window.setTimeout(() => discharge(head), 260);
      if (btn.hasAttribute('data-news-all')) setNewsFull(true);
      else setCatOpen(i, !c.open);
    });
  });

  // The full wire's back control, and the browser's back and forward between the two.
  backEl?.addEventListener('click', () => setNewsFull(false));
  window.addEventListener('popstate', () => setNewsFull(location.hash === NEWS_HASH, false));

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
    /** Category state: open (target), cards shown while collapsed, squeeze, which cards are anchors (fed loads). */
    get categories() {
      return cats.map((c) => ({
        id: c.id,
        open: c.open,
        cards: c.cards.length,
        visible: c.visible,
        rows: c.rows,
        front: Number(c.front.value.toFixed(3)),
        shift: Number(c.shift.value.toFixed(3)),
        more: c.more && !c.more.hidden ? c.more.textContent?.replace(/\s+/g, ' ').trim() : null,
        expanded: c.more?.getAttribute('aria-expanded') ?? null,
        inert: c.cards.filter((k) => nodes[k].item.inert).length,
        headFed: scene?.game.isLoadEnabled(c.head) ?? false,
        fed: c.cards.filter((k) => scene?.game.isLoadEnabled(k)).map((k) => nodes[k].id),
      }));
    },
    toggleCategory(id: string) {
      const c = cats.findIndex((x) => x.id === id);
      if (c >= 0) setCatOpen(c, !cats[c].open);
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
