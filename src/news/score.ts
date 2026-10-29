/**
 * Score stories and choose the editor's candidates (SPEC "News wire" step 5). Pure.
 */
import { SECTIONS, type Source, type Story } from './types';

export const WEIGHTS = {
  relevance: 1,
  importance: 0.8,
  /** Per doubling of the number of outlets covering the story. */
  coverage: 1.5,
  /** Times (source weight − 1). */
  source: 2,
  /** Points lost per hour since the representative was published. */
  agePerHour: 0.08,
};

export const PER_SECTION = 15;
export const BY_IMPORTANCE = 15;

export function scoreStory(story: Story, sources: ReadonlyMap<string, Source>, now: Date): number {
  const rep = story.items[0];
  const ageHours = Math.max(0, (now.getTime() - Date.parse(rep.publishedAt)) / 3600_000);
  const sourceWeight = sources.get(rep.sourceId)?.weight ?? 1;
  return (
    WEIGHTS.relevance * story.relevance +
    WEIGHTS.importance * story.importance +
    WEIGHTS.coverage * Math.log2(1 + story.items.length) +
    WEIGHTS.source * (sourceWeight - 1) -
    WEIGHTS.agePerHour * ageHours
  );
}

const byScore = (a: Story, b: Story) => b.score - a.score || a.id.localeCompare(b.id);

/** Stories with `score` filled, best first. */
export function scoreStories(stories: readonly Story[], sources: ReadonlyMap<string, Source>, now: Date): Story[] {
  return stories.map((s) => ({ ...s, score: scoreStory(s, sources, now) })).sort(byScore);
}

/** The top `PER_SECTION` of each section plus the top `BY_IMPORTANCE` overall, best first. */
export function pickCandidates(scored: readonly Story[]): Story[] {
  const chosen = new Set<string>();
  for (const section of SECTIONS) {
    for (const s of scored.filter((s) => s.category === section).slice(0, PER_SECTION)) chosen.add(s.id);
  }
  const byImportance = [...scored].sort((a, b) => b.importance - a.importance || byScore(a, b));
  for (const s of byImportance.slice(0, BY_IMPORTANCE)) chosen.add(s.id);
  return scored.filter((s) => chosen.has(s.id));
}
