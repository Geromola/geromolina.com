/**
 * DOM wiring for Ballpark (`/ballpark`): the log-scale slider, the reveal, the run summary and
 * progress in localStorage. Game logic lives in the DOM-free modules next to this one.
 */
import { Spring } from '../grid/spring';
import { ANCHORS, anchorWh, getItem, type Line } from './catalog';
import { BallparkGame, biasText, parseProgress, serializeProgress, type RoundResult } from './game';
import { ROUNDS_PER_RUN, isLearned } from './rounds';
import {
  AXIS_MAX,
  AXIS_MIN,
  AXIS_SPAN,
  equivalence,
  factorText,
  formatCount,
  formatEnergy,
  formatHours,
  formatWatts,
  posToWh,
  roundSig,
  tier,
  whToPos,
} from './scale';

const KEY = 'ballpark-progress';
const FINE = 0.05 / AXIS_SPAN;
const DECADE = 1 / AXIS_SPAN;
/** Share colours, in line order. Tokens only. */
const SEGMENTS = ['rgba(var(--cyan-rgb), 0.9)', 'rgba(var(--amber-rgb), 0.85)', 'var(--hot)'];

function loadProgress() {
  try {
    return parseProgress(localStorage.getItem(KEY));
  } catch {
    return parseProgress(null);
  }
}

function saveProgress(game: BallparkGame) {
  try {
    localStorage.setItem(KEY, serializeProgress(game.progress));
  } catch {
    /* storage unavailable: progress lasts for this page */
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** "LED bulb" with chips "× 10", "12 h"; "Ask an AI chatbot" with "1,000 queries". */
function lineParts(line: Line): { name: string; chips: string[] } {
  const item = getItem(line.itemId);
  if (item.kind === 'power') {
    const chips = [formatHours(line.hours ?? 0)];
    if (line.count > 1) chips.unshift(`× ${formatCount(line.count)}`);
    return { name: item.name, chips };
  }
  return { name: item.name, chips: [`${formatCount(line.count)} ${line.count === 1 ? item.unit.one : item.unit.many}`] };
}

/** "1,500 W × 5 min" or "15 Wh × 7"; empty for a single unit, whose energy says it all. */
function lineMath(line: Line): string {
  const item = getItem(line.itemId);
  if (item.kind === 'power') {
    const count = line.count > 1 ? ` × ${formatCount(line.count)}` : '';
    return `${formatWatts(item.watts)}${count} × ${formatHours(line.hours ?? 0)}`;
  }
  return line.count === 1 ? '' : `${formatEnergy(item.whPer, 3, true).text} × ${formatCount(line.count)}`;
}

/** An item name mid-sentence: "window AC", "gaming PC", but "LED bulb" and "65\" TV" stay. */
function inline(line: Line): string {
  const name = getItem(line.itemId).name;
  return /^[A-Z][a-z]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name;
}

export function mountBallpark(root: HTMLElement) {
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const ui = {
    stage: q('[data-stage]'),
    round: q('[data-round]'),
    score: q('[data-score]'),
    badge: q('[data-landmark-badge]'),
    lines: q('[data-lines]'),
    guessValue: q('[data-guess-value]'),
    guessUnit: q('[data-guess-unit]'),
    guessEq: q('[data-guess-eq]'),
    track: q('[data-track]'),
    thumb: q('[data-thumb]'),
    landmarks: q('[data-landmarks]'),
    bracket: q('[data-bracket]'),
    truth: q('[data-truth]'),
    truthLabel: q('[data-truth-label]'),
    lock: q<HTMLButtonElement>('[data-lock]'),
    reveal: q('[data-reveal]'),
    tier: q('[data-tier]'),
    points: q('[data-points]'),
    truthText: q('[data-truth-text]'),
    factor: q('[data-factor]'),
    truthEq: q('[data-truth-eq]'),
    share: q('[data-share]'),
    lesson: q('[data-lesson]'),
    fact: q('[data-fact]'),
    source: q<HTMLAnchorElement>('[data-source]'),
    learned: q('[data-learned]'),
    next: q<HTMLButtonElement>('[data-next]'),
    summary: q('[data-summary]'),
    sumTotal: q('[data-sum-total]'),
    sumMax: q('[data-sum-max]'),
    sumBest: q('[data-sum-best]'),
    sumFactor: q('[data-sum-factor]'),
    sumBias: q('[data-sum-bias]'),
    ladder: q('[data-ladder]'),
    again: q<HTMLButtonElement>('[data-again]'),
    live: q('[data-live]'),
  };

  const game = new BallparkGame(loadProgress());
  const reduced = () =>
    document.documentElement.dataset.motion === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Springs: the thumb position, the reveal (truth marker and error bracket), the share bar and
  // the score pop. All animate from their current value, so nothing waits on them.
  const thumb = new Spring(0.5, 0.22);
  const reveal = new Spring(0, 0.45);
  const bar = new Spring(0, 0.6);
  const pop = new Spring(1, 0.35, 0.55);
  const springs = [thumb, reveal, bar, pop];

  /** The guess (axis position) the player has set, or null before the first touch. */
  let guess: number | null = null;
  let truthPos = 0;
  let dragId: number | null = null;
  let raf = 0;
  let last = 0;

  function paint() {
    const g = thumb.value;
    root.style.setProperty('--guess', String(g));
    const r = reveal.value;
    const target = guess ?? g;
    const end = target + (truthPos - target) * r;
    ui.bracket.style.left = `${Math.min(target, end) * 100}%`;
    ui.bracket.style.width = `${Math.abs(end - target) * 100}%`;
    ui.truth.style.opacity = String(Math.min(1, Math.max(0, r)));
    ui.truth.style.transform = `translate(-50%, ${(1 - r) * -10}px)`;
    ui.share.style.transform = `scaleX(${Math.max(0, bar.value)})`;
    ui.points.style.transform = `scale(${pop.value})`;
  }

  function frame(now: number) {
    const dt = (now - last) / 1000;
    last = now;
    let moving = false;
    for (const s of springs) {
      s.step(dt);
      if (Math.abs(s.target - s.value) > 1e-4 || Math.abs(s.velocity) > 1e-3) moving = true;
      else s.snap(s.target);
    }
    paint();
    raf = moving ? requestAnimationFrame(frame) : 0;
  }

  function animate(spring: Spring, target: number) {
    spring.target = target;
    if (reduced()) {
      spring.snap(target);
      paint();
      return;
    }
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  function snapAll() {
    for (const s of springs) s.snap(s.target);
    paint();
  }

  // ---------- landmarks (learned anchors pinned to the axis) ----------

  function renderLandmarks(highlight?: string) {
    ui.landmarks.replaceChildren(
      ...ANCHORS.filter((a) => isLearned(game.progress, a.id)).map((a) => {
        const dot = el('span', 'landmark');
        dot.style.left = `${whToPos(anchorWh(a)) * 100}%`;
        dot.title = `${a.one}: ${formatEnergy(anchorWh(a), 2).text}`;
        if (a.id === highlight) {
          dot.classList.add('is-near');
          dot.append(el('span', 'landmark__label mono', a.short));
        }
        return dot;
      }),
    );
  }

  // ---------- guessing ----------

  function guessWh(pos: number) {
    return roundSig(posToWh(pos), 2);
  }

  function setGuess(pos: number, follow: boolean) {
    const p = Math.min(1, Math.max(0, pos));
    if (guess === null) {
      thumb.snap(p);
      root.dataset.hasGuess = '';
    }
    guess = p;
    if (follow) thumb.snap(p);
    animate(thumb, p);
    const wh = guessWh(p);
    const f = formatEnergy(wh);
    const eq = equivalence(wh);
    ui.guessValue.textContent = f.value;
    ui.guessUnit.textContent = f.unit;
    ui.guessEq.textContent = eq.text;
    ui.thumb.setAttribute('aria-valuenow', (AXIS_MIN + p * AXIS_SPAN).toFixed(2));
    ui.thumb.setAttribute('aria-valuetext', `${f.text}, ${eq.text}`);
    ui.lock.disabled = false;
    renderLandmarks(eq.anchor.id);
  }

  function posFrom(e: PointerEvent) {
    const r = ui.track.getBoundingClientRect();
    return (e.clientX - r.left) / r.width;
  }

  ui.track.addEventListener('pointerdown', (e) => {
    if (game.phase !== 'guessing' || e.button > 0) return;
    e.preventDefault();
    dragId = e.pointerId;
    ui.track.setPointerCapture(e.pointerId);
    ui.thumb.focus({ preventScroll: true });
    setGuess(posFrom(e), false);
  });
  ui.track.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragId) return;
    setGuess(posFrom(e), true);
  });
  const endDrag = (e: PointerEvent) => {
    if (e.pointerId === dragId) dragId = null;
  };
  ui.track.addEventListener('pointerup', endDrag);
  ui.track.addEventListener('pointercancel', endDrag);

  ui.thumb.addEventListener('keydown', (e) => {
    if (game.phase !== 'guessing') return;
    const step = e.shiftKey ? DECADE : FINE;
    const from = guess ?? 0.5;
    const moves: Record<string, number> = {
      ArrowRight: from + step,
      ArrowUp: from + step,
      ArrowLeft: from - step,
      ArrowDown: from - step,
      PageUp: from + DECADE,
      PageDown: from - DECADE,
      Home: 0,
      End: 1,
    };
    if (e.key in moves) {
      e.preventDefault();
      // The first arrow press starts from the middle of the scale.
      const first = guess === null && e.key !== 'Home' && e.key !== 'End';
      setGuess(first ? 0.5 : moves[e.key], false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      lockIn();
    }
  });

  // ---------- rounds ----------

  function renderHeader() {
    ui.round.textContent = String(game.round + 1);
    ui.score.textContent = String(game.score);
  }

  function renderRound() {
    root.dataset.phase = 'guessing';
    delete root.dataset.hasGuess;
    guess = null;
    reveal.snap(0);
    bar.snap(0);
    renderHeader();
    ui.badge.hidden = !game.scenario.anchorId;
    ui.lines.replaceChildren(
      ...game.scenario.lines.map((line, i) => {
        const { name, chips } = lineParts(line);
        const li = el('li', 'line');
        const swatch = el('span', 'line__swatch');
        swatch.style.background = SEGMENTS[i % SEGMENTS.length];
        const main = el('span', 'line__main');
        main.append(el('span', 'line__name', name), ...chips.map((c) => el('span', 'chip mono', c)));
        li.append(swatch, main, el('span', 'line__math mono'));
        return li;
      }),
    );
    ui.guessValue.textContent = '—';
    ui.guessUnit.textContent = '';
    ui.guessEq.textContent = 'Tap or drag the scale';
    ui.thumb.removeAttribute('aria-valuenow');
    ui.thumb.setAttribute('aria-valuetext', 'No guess yet');
    ui.lock.disabled = true;
    ui.lock.hidden = false;
    ui.reveal.hidden = true;
    ui.summary.hidden = true;
    ui.stage.hidden = false;
    renderLandmarks();
    snapAll();
  }

  /** The lesson for a combo: if the most powerful thing isn't the biggest user, say so. */
  function lessonFor(r: RoundResult): string | null {
    const lines = r.scenario.lines;
    if (lines.length < 2) return null;
    const iE = r.parts.indexOf(Math.max(...r.parts));
    const biggest = lines[iE];
    const draw = (l: Line) => {
      const item = getItem(l.itemId);
      return item.kind === 'power' ? item.watts * l.count : -1;
    };
    const mostPower = lines.reduce((a, b) => (draw(b) > draw(a) ? b : a));
    if (draw(biggest) > 0 && mostPower !== biggest) {
      return `The ${inline(mostPower)} draws the most power, but the ${inline(biggest)} used the most energy. Energy is power × time.`;
    }
    const share = Math.round((100 * r.parts[iE]) / r.truth);
    return `Biggest share: ${getItem(biggest.itemId).name}, ${share}%. In a sum, the biggest term wins.`;
  }

  function lockIn() {
    if (game.phase !== 'guessing' || guess === null) return;
    dragId = null;
    const r = game.guess(guessWh(guess));
    saveProgress(game);
    truthPos = whToPos(r.truth);
    root.style.setProperty('--truth', String(truthPos));
    root.dataset.phase = 'revealed';

    const truthF = formatEnergy(r.truth, 3, true);
    ui.truthLabel.textContent = truthF.text;
    ui.tier.textContent = tier(r.e);
    ui.points.textContent = `+${r.points}`;
    ui.truthText.textContent = `Actual ${truthF.text}`;
    ui.factor.textContent = factorText(r.guess, r.truth);
    ui.truthEq.textContent = equivalence(r.truth).text;

    const items = ui.lines.querySelectorAll('.line__math');
    r.scenario.lines.forEach((line, i) => {
      const share = r.scenario.lines.length > 1 ? `  ${Math.round((100 * r.parts[i]) / r.truth)}%` : '';
      const math = lineMath(line);
      items[i].textContent = `${math ? `${math} = ` : ''}${formatEnergy(r.parts[i], 3, true).text}${share}`;
    });
    ui.share.replaceChildren(
      ...r.parts.map((wh, i) => {
        const seg = el('span', 'share__seg');
        seg.style.flexGrow = String(wh / r.truth);
        seg.style.background = SEGMENTS[i % SEGMENTS.length];
        return seg;
      }),
    );
    ui.share.hidden = r.parts.length < 2;

    const lesson = lessonFor(r);
    ui.lesson.textContent = lesson ?? '';
    ui.lesson.hidden = !lesson;
    const dominant = r.scenario.lines[r.parts.indexOf(Math.max(...r.parts))];
    const item = getItem(dominant.itemId);
    ui.fact.textContent = item.fact;
    ui.source.href = item.source.url;
    ui.source.title = item.source.label;

    const anchor = r.learnedAnchor ? ANCHORS.find((a) => a.id === r.learnedAnchor) : undefined;
    ui.learned.hidden = !anchor;
    if (anchor) {
      ui.learned.textContent = `New landmark: ${anchor.one} (${formatEnergy(anchorWh(anchor)).text}) is now pinned to your scale.`;
    }
    renderLandmarks(anchor?.id);

    ui.next.textContent = game.results.length >= ROUNDS_PER_RUN ? 'See results' : 'Next round';
    ui.lock.hidden = true;
    ui.reveal.hidden = false;
    ui.score.textContent = String(game.score);

    pop.snap(0.6);
    animate(pop, 1);
    animate(reveal, 1);
    animate(bar, 1);
    ui.next.focus({ preventScroll: true });
    ui.reveal.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    ui.live.textContent = `${tier(r.e)}. Actual ${truthF.text}; you guessed ${formatEnergy(r.guess).text}, ${factorText(r.guess, r.truth)}. ${r.points} points.${anchor ? ' New landmark learned.' : ''}`;
  }

  function renderSummary() {
    root.dataset.phase = 'summary';
    const s = game.summary();
    ui.stage.hidden = true;
    ui.summary.hidden = false;
    ui.sumTotal.textContent = String(s.total);
    ui.sumMax.textContent = ` / ${s.max}`;
    ui.sumBest.textContent = s.newBest ? 'New best run.' : `Best run: ${s.best}.`;
    ui.sumFactor.textContent = `On average you were ×${formatCount(s.meanFactor)} off.`;
    const bias = [biasText(s.biasSmall, 'small'), biasText(s.biasBig, 'big')].filter((t): t is string => !!t);
    ui.sumBias.replaceChildren(...(bias.length ? bias : ['No consistent lean high or low. Nicely calibrated.']).map((t) => el('li', '', t)));
    const learnedNow = new Set(game.results.map((r) => r.learnedAnchor).filter(Boolean));
    ui.ladder.replaceChildren(
      ...[...ANCHORS].reverse().map((a) => {
        const li = el('li', 'rung');
        if (isLearned(game.progress, a.id)) li.classList.add('is-learned');
        if (learnedNow.has(a.id)) li.classList.add('is-new');
        li.append(el('span', 'rung__dot'), el('span', 'rung__value mono', formatEnergy(anchorWh(a)).text), el('span', 'rung__label', a.one));
        return li;
      }),
    );
    ui.again.focus({ preventScroll: true });
    ui.summary.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
    ui.live.textContent = `Run complete: ${s.total} of ${s.max} points.`;
  }

  /** Bring a new round's question into view, unless its top is already near the top of the screen. */
  function showStage() {
    const top = ui.stage.getBoundingClientRect().top;
    if (top < 56 || top > innerHeight * 0.3) ui.stage.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
  }

  ui.lock.addEventListener('click', lockIn);
  ui.next.addEventListener('click', () => {
    game.next();
    if (game.phase === 'summary') renderSummary();
    else {
      renderRound();
      showStage();
      ui.thumb.focus({ preventScroll: true });
    }
  });
  ui.again.addEventListener('click', () => {
    game.start();
    renderRound();
    showStage();
    ui.thumb.focus({ preventScroll: true });
  });

  ui.thumb.setAttribute('aria-valuemin', String(AXIS_MIN));
  ui.thumb.setAttribute('aria-valuemax', String(AXIS_MAX));
  root.dataset.ready = '';
  renderRound();
}
