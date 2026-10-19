import { GridSim, RATIO, type StepMode } from './sim';
import { computeLattice, placeNodes, toPx, type Lattice } from './layout';
import type { MapNode } from './nodes';
import { CanvasRenderer, WebGLRenderer, drawMesh, type Renderer } from './renderers';
import { Spring } from './spring';

const FACTS = {
  up: 'Step-up ×25: 13.8 kV → 345 kV. Same 50 MW, 25× less current, so far less is lost as heat. Electrons drift slower, but each one carries more energy.',
  down: 'Step-down to 480 V: current climbs, electrons drift faster, each carrying less energy. The last hop before a building.',
  ac: 'In AC, electrons barely travel. They jiggle back and forth (60× a second in real life, slowed down here). What flows outward is the energy: watch the waves.',
  dc: 'Back to DC. An iron-core transformer can’t step DC at all. This one is solid-state: the power electronics behind HVDC links.',
} as const;
type Fact = keyof typeof FACTS;

export function mountGrid(root: HTMLElement, nodes: MapNode[]) {
  const meshCanvas = root.querySelector<HTMLCanvasElement>('[data-mesh]')!;
  const electronCanvas = root.querySelector<HTMLCanvasElement>('[data-electrons]')!;
  const nodeEls = [...root.querySelectorAll<HTMLElement>('[data-node]')];
  const glyph = root.querySelector<HTMLElement>('[data-transformer]')!;
  const meter = root.querySelector<HTMLElement>('[data-meter]')!;
  const toast = root.querySelector<HTMLElement>('[data-toast]')!;
  const out = {
    v: meter.querySelector<HTMLElement>('[data-v]')!,
    i: meter.querySelector<HTMLElement>('[data-i]')!,
    p: meter.querySelector<HTMLElement>('[data-p]')!,
    mode: meter.querySelector<HTMLElement>('[data-mode]')!,
    chip: meter.querySelector<HTMLElement>('[data-chip-v]')!,
  };

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = matchMedia('(pointer: coarse)').matches;
  const forceCanvas = new URLSearchParams(location.search).get('renderer') === 'canvas';
  const renderer: Renderer = (!forceCanvas && WebGLRenderer.create(electronCanvas)) || new CanvasRenderer(electronCanvas);
  root.dataset.renderer = renderer.kind;

  let width = 0;
  let height = 0;
  let lat: Lattice = computeLattice(1, 1);
  let sim!: GridSim;
  let mode: StepMode = 'up';
  let isAC = false;
  let pointerPx: { x: number; y: number } | null = null;
  let touchRelease = 0;
  const pulses = nodeEls.map(() => new Spring(0, 0.5));
  let lastAbsorbed: number[] = [];

  // ---------- layout ----------
  function build() {
    const rect = root.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const portrait = height > width;
    lat = computeLattice(width, height);
    const placed = placeNodes(nodes, lat, width, height, portrait);
    const verts = lat.cols * lat.rows;
    sim = new GridSim({
      cols: lat.cols,
      rows: lat.rows,
      nodes: placed,
      count: coarse ? Math.min(1100, verts * 8) : Math.min(3200, verts * 12),
      fieldRadius: coarse ? 1.8 : 2.2,
    });
    sim.mode = mode;
    sim.setAC(isAC);
    sim.drift.snap(isAC ? 0 : 1);
    sim.acMix.snap(isAC ? 1 : 0);
    for (let k = 0; k < 300; k++) sim.step(1 / 30); // pre-warm: open on a grid already in flow
    lastAbsorbed = [...sim.absorbed];

    placed.forEach((p, i) => {
      const { x, y } = toPx(lat, p.col, p.row);
      const el = nodeEls[i];
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      const label = el.querySelector<HTMLElement>('.node__label');
      const reach = (label?.offsetWidth ?? 0) + 40; // label width + glyph gap
      el.classList.toggle('node--flip', x + reach > width - 12 && x - reach > 12);
    });
    glyph.style.setProperty('--field', `${sim.fieldRadius * lat.spacing * 2}px`);

    drawMesh(meshCanvas, width, height, dpr, lat);
    renderer.resize(width, height, dpr, lat);
    root.dataset.ready = '';

    if (reduceMotion.matches) renderer.draw(sim, 1 / 60);
  }

  // ---------- input ----------
  const toLattice = (x: number, y: number) => ({ x: (x - lat.ox) / lat.spacing, y: (y - lat.oy) / lat.spacing });
  const local = (e: PointerEvent) => {
    const r = root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onChrome = (e: Event) => (e.target as HTMLElement).closest('[data-meter], [data-node], a, button') !== null;

  root.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && !touchRelease) return;
    pointerPx = local(e);
  });
  root.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'touch') pointerPx = null;
  });
  root.addEventListener('pointerdown', (e) => {
    if (onChrome(e)) return;
    pointerPx = local(e);
    if (e.pointerType === 'touch') {
      touchRelease = performance.now() + 1e9; // held
    } else {
      setMode(mode === 'up' ? 'down' : 'up'); // instant, on press
    }
  });
  const endTouch = (e: PointerEvent) => {
    if (e.pointerType === 'touch' && touchRelease) touchRelease = performance.now() + 1400; // linger, then fade
  };
  root.addEventListener('pointerup', endTouch);
  root.addEventListener('pointercancel', endTouch);

  nodeEls.forEach((el, i) => {
    const on = () => (sim.hover = i);
    const off = () => sim.hover === i && (sim.hover = -1);
    el.addEventListener('pointerenter', on);
    el.addEventListener('pointerleave', off);
    el.addEventListener('focus', on);
    el.addEventListener('blur', off);
    el.addEventListener('pointerdown', () => {
      on();
      pulses[i].velocity += 14; // charge-up kick, on press
    });
  });

  meter.querySelector('[data-step]')!.addEventListener('click', () => setMode(mode === 'up' ? 'down' : 'up'));
  meter.querySelectorAll<HTMLButtonElement>('[data-current]').forEach((b) =>
    b.addEventListener('click', () => setAC(b.dataset.current === 'ac')),
  );
  meter.querySelector('[data-chip]')?.addEventListener('click', () => meter.classList.toggle('is-open'));

  function setMode(m: StepMode) {
    mode = m;
    sim.mode = m;
    meter.dataset.stepMode = m;
    glyph.dataset.stepMode = m;
    if (sim.strength.value > 0.3 || reduceMotion.matches) showFact(m);
    if (reduceMotion.matches) staticFrame();
  }

  function setAC(on: boolean) {
    if (on === isAC) return;
    isAC = on;
    sim.setAC(on);
    meter.dataset.current = on ? 'ac' : 'dc';
    meter.querySelectorAll<HTMLButtonElement>('[data-current]').forEach((b) =>
      b.setAttribute('aria-pressed', String((b.dataset.current === 'ac') === on)),
    );
    showFact(on ? 'ac' : 'dc');
    if (reduceMotion.matches) staticFrame();
  }

  // ---------- fun facts ----------
  const queue: Fact[] = [];
  let toastBusy = false;
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
  function showFact(f: Fact) {
    if (queue.includes(f) || seen(f)) return;
    queue.push(f);
    if (!toastBusy) nextFact();
  }
  function nextFact() {
    const f = queue.shift();
    if (!f) {
      toastBusy = false;
      return;
    }
    toastBusy = true;
    toast.querySelector('[data-toast-text]')!.textContent = FACTS[f];
    toast.classList.add('is-visible');
    setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(nextFact, 450);
    }, 7000);
  }

  // ---------- readouts ----------
  let lastText = 0;
  function updateMeter(now: number) {
    if (now - lastText < 80) return;
    lastText = now;
    const s = sim.strength.value;
    const { voltage, current, power } = sim.reading;
    out.v.textContent = formatVolts(voltage);
    out.chip.textContent = formatVolts(voltage);
    out.i.textContent = formatAmps(current);
    out.p.textContent = `${(power / 1e6).toFixed(1)} MW`;
    const ratio = RATIO[mode];
    out.mode.textContent =
      s < 0.05 ? 'Point to energize' : mode === 'up' ? `Step-up ×${ratio}` : `Step-down ÷${Math.round(1 / ratio * 100) / 100}`;
  }

  // Reduced motion: no animation, but the meter still answers the buttons.
  function staticFrame() {
    sim.strength.snap(1);
    renderer.draw(sim, 1 / 60);
    updateMeter(Infinity);
    lastText = 0;
  }

  // ---------- loop ----------
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

    if (touchRelease && now > touchRelease) {
      touchRelease = 0;
      pointerPx = null;
    }
    sim.pointer = pointerPx ? toLattice(pointerPx.x, pointerPx.y) : null;
    sim.step(dt);
    renderer.draw(sim, dt);

    // Transformer glyph: position is 1:1 with the pointer; presence rides the field spring.
    const s = sim.strength.value;
    if (pointerPx) glyph.style.transform = `translate3d(${pointerPx.x}px, ${pointerPx.y}px, 0)`;
    glyph.style.opacity = (s * (sim.hover >= 0 ? 0.25 : 1)).toFixed(3); // step aside for the node
    glyph.style.setProperty('--s', s.toFixed(3));
    if (s > 0.6) showFact(mode);

    sim.absorbed.forEach((n, i) => {
      if (n > lastAbsorbed[i]) pulses[i].velocity += Math.min(6, (n - lastAbsorbed[i]) * 1.5);
      lastAbsorbed[i] = n;
      pulses[i].target = sim.hover === i ? 0.6 : 0;
      nodeEls[i].style.setProperty('--pulse', Math.max(0, pulses[i].step(dt)).toFixed(3));
      nodeEls[i].classList.toggle('is-hot', sim.hover === i);
    });
    updateMeter(now);
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
  reduceMotion.addEventListener('change', () => (reduceMotion.matches ? (stop(), staticFrame()) : start()));

  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(build, 120);
  }).observe(root);

  build();
  meter.dataset.stepMode = mode;
  glyph.dataset.stepMode = mode;
  meter.dataset.current = 'dc';
  updateMeter(Infinity);
  lastText = 0;
  start();

  // Debug handle for verification in the browser.
  (window as unknown as { __grid: unknown }).__grid = { get sim() { return sim; }, renderer: renderer.kind };
}

function formatVolts(v: number) {
  if (v >= 1000) return `${v >= 100_000 ? Math.round(v / 1000) : (v / 1000).toFixed(1)} kV`;
  return `${Math.round(v)} V`;
}

function formatAmps(a: number) {
  if (a >= 1000) return `${(a / 1000).toFixed(2)} kA`;
  return `${Math.round(a)} A`;
}
