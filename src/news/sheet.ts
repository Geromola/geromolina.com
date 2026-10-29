/**
 * The home page's story panel (SPEC "Home hero v4"): tapping a news wire story opens a glass
 * panel with its brief, why it matters, and the way out to the outlet, on a spring (from where it
 * is, so a tap mid-way reverses it). Another story swaps the panel's content; Escape, the close
 * button or a press elsewhere closes it. Without JS a story opens its card on /news instead.
 */
import { Spring } from '../grid/spring';
import { ageLabel } from './edition';
import { markRead } from './read';

const reduced = () =>
  document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mountStorySheet(menu: HTMLElement) {
  const sheet = document.querySelector<HTMLElement>('[data-sheet]');
  const body = sheet?.querySelector<HTMLElement>('[data-sheet-body]');
  const closeBtn = sheet?.querySelector<HTMLButtonElement>('[data-sheet-close]');
  if (!sheet || !body || !closeBtn) return;

  // 0 closed .. 1 open; the CSS reads it as --sheet.
  const spring = new Spring(0, 0.34, 1);
  let current = '';
  let trigger: HTMLElement | null = null;
  let raf = 0;
  let last = 0;

  const paint = () => sheet.style.setProperty('--sheet', Math.min(1, Math.max(0, spring.value)).toFixed(4));
  const settled = () => Math.abs(spring.target - spring.value) < 0.002 && Math.abs(spring.velocity) < 0.01;
  const done = () => {
    spring.snap(spring.target);
    paint();
    if (spring.target === 0) sheet.hidden = true;
  };
  const tick = (t: number) => {
    spring.step(last ? (t - last) / 1000 : 1 / 60);
    last = t;
    paint();
    if (settled()) {
      raf = 0;
      last = 0;
      done();
    } else raf = requestAnimationFrame(tick);
  };
  const run = () => {
    if (reduced()) {
      cancelAnimationFrame(raf);
      raf = 0;
      done();
    } else if (!raf) raf = requestAnimationFrame(tick);
  };

  function open(id: string, from: HTMLElement): boolean {
    const tpl = document.querySelector<HTMLTemplateElement>(`template[data-story-tpl="${CSS.escape(id)}"]`);
    if (!tpl) return false;
    if (current !== id) {
      body!.replaceChildren(tpl.content.cloneNode(true));
      const now = new Date();
      for (const t of body!.querySelectorAll<HTMLTimeElement>('time[data-age]')) t.textContent = ageLabel(t.dateTime, now);
      current = id;
    }
    trigger = from;
    sheet!.hidden = false;
    spring.target = 1;
    paint();
    run();
    markRead(id);
    body!.querySelector<HTMLElement>('#nsheet-title')?.focus({ preventScroll: true });
    return true;
  }

  function close(restoreFocus = true) {
    if (sheet!.hidden || spring.target === 0) return;
    spring.target = 0;
    run();
    if (restoreFocus && trigger && sheet!.contains(document.activeElement)) trigger.focus({ preventScroll: true });
  }

  // A story (in the capture phase, before the menu's own handler, which then lets the node go).
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest<HTMLAnchorElement>('a[data-story]');
      if (!a || !menu.contains(a)) return;
      // A modified click still opens the card on /news, elsewhere.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (open(a.dataset.story!, a)) e.preventDefault();
    },
    true,
  );
  closeBtn.addEventListener('click', () => close());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  // A press anywhere else lets it go (a story swaps it instead).
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Element | null;
    if (sheet.hidden || !t || sheet.contains(t) || t.closest('a[data-story]')) return;
    close(false);
  });
}
