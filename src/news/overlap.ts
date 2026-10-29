/**
 * The copy check (SPEC "Guardrails"): a snippet or brief must not repeat a run of `RUN` or more
 * consecutive words of its source text that carries real wording, i.e. at least `CONTENT`
 * content words. Figures, proper names and function words don't count toward that, so restating
 * "92.3bn in total revenue and more than 36.6bn in profit" or "the U.K." passes while copying a
 * clause like "an inexplicable decision by traffic control operators" doesn't. Pure.
 */
export const RUN = 8;
export const CONTENT = 5;

const STOP = new Set(
  (
    'the and for with from into onto over under about after before than that this these those their there them they ' +
    'its it his her our your was were are has have had been being will would could should may might can not but per ' +
    'more most less least some any all each other such also just only very then when where which while who whom whose ' +
    'what how why out off down near across between during through against within without upon via amid plus'
  ).split(' '),
);

interface Word {
  /** Lowercase, accent-free: what's matched. */
  key: string;
  /** Carries wording: not a figure, a proper name, a function word or a single letter. */
  content: boolean;
}

const words = (s: string): Word[] =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => {
      const key = w.toLowerCase();
      return { key, content: key.length >= 3 && !/\p{N}/u.test(w) && !/\p{Lu}/u.test(w) && !STOP.has(key) };
    });

/**
 * The longest run of `run` or more consecutive words that `draft` repeats from `source` with at
 * least `content` content words in it (normalized: lowercase, no accents or punctuation), or null.
 */
export function copiedRun(draft: string, source: string, run = RUN, content = CONTENT): string | null {
  const d = words(draft);
  const s = words(source).map((w) => w.key);
  if (d.length < run || s.length < run) return null;
  const grams = new Set<string>();
  for (let i = 0; i + run <= s.length; i++) grams.add(s.slice(i, i + run).join(' '));
  const gram = (i: number) => d.slice(i, i + run).map((w) => w.key).join(' ');
  let best: [number, number] | null = null;
  for (let i = 0; i + run <= d.length; i++) {
    if (!grams.has(gram(i))) continue;
    // Extend while each next window still appears in the source.
    let end = i + run;
    while (end < d.length && grams.has(gram(end - run + 1))) end++;
    const wording = d.slice(i, end).filter((w) => w.content).length;
    if (wording >= content && (!best || end - i > best[1] - best[0])) best = [i, end];
    i = end - run;
  }
  return best ? d.slice(best[0], best[1]).map((w) => w.key).join(' ') : null;
}

/** True when `draft` repeats a run of `source` that carries real wording (see `copiedRun`). */
export const copiesSource = (draft: string, source: string, run = RUN): boolean => copiedRun(draft, source, run) !== null;
