/**
 * The copy check (SPEC "Guardrails"): a snippet or brief must not share a run of `RUN` or more
 * consecutive words with its source text. Pure.
 */
export const RUN = 8;

const words = (s: string): string[] =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * The longest run of `run` or more consecutive words that `draft` repeats from `source`
 * (normalized: lowercase, no accents or punctuation), or null when there is none.
 */
export function copiedRun(draft: string, source: string, run = RUN): string | null {
  const d = words(draft);
  const s = words(source);
  if (d.length < run || s.length < run) return null;
  const grams = new Set<string>();
  for (let i = 0; i + run <= s.length; i++) grams.add(s.slice(i, i + run).join(' '));
  let best: [number, number] | null = null;
  for (let i = 0; i + run <= d.length; i++) {
    if (!grams.has(d.slice(i, i + run).join(' '))) continue;
    // Extend while each next window still appears in the source.
    let end = i + run;
    while (end < d.length && grams.has(d.slice(end - run + 1, end + 1).join(' '))) end++;
    if (!best || end - i > best[1] - best[0]) best = [i, end];
    i = end - run;
  }
  return best ? d.slice(best[0], best[1]).join(' ') : null;
}

/** True when `draft` repeats `run` or more consecutive words of `source`. */
export const copiesSource = (draft: string, source: string, run = RUN): boolean => copiedRun(draft, source, run) !== null;
