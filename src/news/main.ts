/**
 * DOM wiring for the news wire (`/news`, SPEC "News wire", "The page"): each story card presses
 * on pointer-down and expands or collapses on a spring when tapped; read state lives in
 * localStorage; ages and the stale banner follow the viewer's clock. Without this script the
 * cards are plain <details> and still work.
 */
import { Spring } from '../grid/spring';
import { ageLabel, isStale } from './edition';
import { loadRead, saveRead } from './read';

const PRESSED = 0.98;

const reduced = () =>
  document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Card {
  el: HTMLDetailsElement;
  head: HTMLElement;
  height: Spring;
  scale: Spring;
  /** Where the card is heading; `el.open` stays true until a collapse settles. */
  wantOpen: boolean;
}

export function mountNews() {
  const root = document.querySelector<HTMLElement>('[data-news]');
  if (!root) return;

  // Ages and staleness against the viewer's clock (the page was built hours earlier).
  const now = new Date();
  for (const t of root.querySelectorAll<HTMLTimeElement>('time[data-age]')) t.textContent = ageLabel(t.dateTime, now);
  const generated = root.dataset.generated;
  const stale = root.querySelector<HTMLElement>('[data-stale]');
  if (generated && stale && root.hasAttribute('data-latest') && isStale(generated, now)) {
    const since = stale.querySelector('[data-stale-since]');
    if (since) since.textContent = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(generated));
    stale.hidden = false;
  }

  // Read state.
  const read = new Set(loadRead());
  const counter = root.querySelector<HTMLElement>('[data-new-count]');
  const cardsById = new Map<string, HTMLElement[]>();
  for (const el of root.querySelectorAll<HTMLElement>('[data-story]')) {
    const id = el.dataset.story!;
    cardsById.set(id, [...(cardsById.get(id) ?? []), el]);
  }
  const paint = () => {
    for (const [id, els] of cardsById) for (const el of els) el.toggleAttribute('data-read', read.has(id));
    const unread = [...cardsById.keys()].filter((id) => !read.has(id)).length;
    if (counter) {
      counter.textContent = unread === 0 ? 'All read' : `${unread} new`;
      counter.hidden = false;
    }
  };
  const markRead = (id: string) => {
    if (read.has(id)) return;
    read.add(id);
    saveRead([...read]);
    paint();
  };
  paint();
  document.documentElement.dataset.newsReady = '';

  // Cards: spring height and press scale, one shared frame loop while anything moves.
  const cards: Card[] = [];
  const moving = new Set<Card>();
  let frame = 0;
  let last = 0;

  // The summary plus the card's own borders.
  const closedHeight = (c: Card) => c.head.offsetHeight + (c.el.offsetHeight - c.el.clientHeight);
  const openHeight = (c: Card) => {
    const h = c.el.style.height;
    c.el.style.height = '';
    const full = c.el.offsetHeight;
    c.el.style.height = h;
    return full;
  };

  const settle = (c: Card) => {
    if (!c.wantOpen) c.el.open = false;
    delete c.el.dataset.closing;
    c.el.style.height = '';
    c.el.style.transform = '';
    moving.delete(c);
  };

  const tick = (t: number) => {
    const dt = last ? (t - last) / 1000 : 1 / 60;
    last = t;
    for (const c of moving) {
      const h = c.height.step(dt);
      const s = c.scale.step(dt);
      c.el.style.height = `${h}px`;
      c.el.style.transform = s === 1 ? '' : `scale(${s})`;
      const still = (sp: Spring) => Math.abs(sp.target - sp.value) < 0.5 / 100 && Math.abs(sp.velocity) < 0.01;
      const heightDone = Math.abs(c.height.target - h) < 0.5 && Math.abs(c.height.velocity) < 5;
      if (heightDone && still(c.scale)) {
        c.height.snap(c.height.target);
        c.scale.snap(c.scale.target);
        if (c.scale.target === 1) settle(c);
      }
    }
    frame = moving.size ? requestAnimationFrame(tick) : 0;
    if (!frame) last = 0;
  };
  const run = (c: Card) => {
    moving.add(c);
    if (!frame) frame = requestAnimationFrame(tick);
  };

  const toggle = (c: Card) => {
    c.wantOpen = !c.wantOpen;
    if (c.wantOpen) markRead(c.el.dataset.story!);
    c.el.toggleAttribute('data-closing', !c.wantOpen);
    if (reduced()) {
      c.el.open = c.wantOpen;
      c.height.snap(c.wantOpen ? openHeight(c) : closedHeight(c));
      c.scale.snap(1);
      settle(c);
      return;
    }
    // Start from wherever the card is now, even mid-flight.
    if (!moving.has(c)) c.height.snap(c.el.offsetHeight);
    c.el.style.height = `${c.height.value}px`;
    if (c.wantOpen) c.el.open = true;
    c.height.target = c.wantOpen ? openHeight(c) : closedHeight(c);
    run(c);
  };

  for (const el of root.querySelectorAll<HTMLDetailsElement>('details[data-story]')) {
    const head = el.querySelector<HTMLElement>('summary');
    if (!head) continue;
    const c: Card = { el, head, height: new Spring(0, 0.38, 1), scale: new Spring(1, 0.22, 1), wantOpen: el.open };
    cards.push(c);

    // Press on pointer-down; the click (also Enter / Space on the summary) toggles.
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || reduced()) return;
      if (!moving.has(c)) c.height.snap(el.offsetHeight);
      c.scale.target = PRESSED;
      run(c);
    });
    const release = () => {
      if (c.scale.target === 1) return;
      c.scale.target = 1;
      run(c);
    };
    head.addEventListener('pointerup', release);
    head.addEventListener('pointercancel', release);
    head.addEventListener('pointerleave', release);
    head.addEventListener('click', (e) => {
      e.preventDefault();
      toggle(c);
    });
    for (const a of el.querySelectorAll<HTMLAnchorElement>('[data-read-link]')) {
      a.addEventListener('click', () => markRead(el.dataset.story!));
    }
  }

  // `/news#s-<id>` (a story picked on the home page): that card opens, already read, in view.
  const linked = location.hash.startsWith('#s-') ? cards.find((c) => `#${c.el.id}` === location.hash) : undefined;
  if (linked) {
    linked.wantOpen = true;
    linked.el.open = true;
    markRead(linked.el.dataset.story!);
    linked.el.scrollIntoView({ block: 'start' });
  }

  // An expanded card's natural height changes with the viewport: let it reflow.
  addEventListener('resize', () => {
    for (const c of cards) if (!moving.has(c)) c.el.style.height = '';
  });
}
