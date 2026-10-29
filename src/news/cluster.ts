/**
 * Group classified items into stories: same section, and the same story key or titles that share
 * most of their words. The representative is the item from the highest-weight source. Pure.
 */
import { hashId } from './normalize';
import type { Classification, ClassifiedItem, Item, Source, Story } from './types';

export const JACCARD_MIN = 0.5;

const STOP = new Set(
  (
    'the a an and or of to in on for with from by at as is are was were be been its it this that after over into about ' +
    'than new says say said will could would may has have had not but how why what who when more most up out amid ' +
    'el la los las un una unos unas y o de del en con por para al se su sus es son que como tras sobre ante entre'
  ).split(' '),
);

/** Lowercase, accent-free words of 3+ letters, minus stop words. */
export function titleTokens(title: string): Set<string> {
  const words = title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w));
  return new Set(words);
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Join items with their classification, dropping `none` and anything unclassified. */
export function joinClassified(items: readonly Item[], results: readonly Classification[]): ClassifiedItem[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  const out: ClassifiedItem[] = [];
  for (const item of items) {
    const c = byId.get(item.id);
    if (!c || c.category === 'none') continue;
    out.push({
      ...item,
      category: c.category,
      relevance: c.relevance,
      importance: c.importance,
      snippet: c.snippet,
      titleEn: c.titleEn,
      eventKey: c.eventKey,
    });
  }
  return out;
}

/** The title a reader sees: the English one for a translated source. */
export const displayTitle = (i: ClassifiedItem): string => i.titleEn || i.title;

export function clusterItems(items: readonly ClassifiedItem[], sources: ReadonlyMap<string, Source>): Story[] {
  const weight = (i: ClassifiedItem) => sources.get(i.sourceId)?.weight ?? 1;
  // Heaviest source first, then the earliest report, so each cluster's first item represents it.
  const ordered = [...items].sort((a, b) => weight(b) - weight(a) || a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));
  const tokens = ordered.map((i) => titleTokens(displayTitle(i)));
  // Union-find over every pair that names the same story, so A~B and B~C put all three together.
  const parent = ordered.map((_, k) => k);
  const root = (k: number): number => (parent[k] === k ? k : (parent[k] = root(parent[k])));
  for (let a = 0; a < ordered.length; a++) {
    for (let b = a + 1; b < ordered.length; b++) {
      const x = ordered[a];
      const y = ordered[b];
      if (x.category !== y.category) continue;
      if ((x.eventKey && x.eventKey === y.eventKey) || jaccard(tokens[a], tokens[b]) >= JACCARD_MIN) parent[root(b)] = root(a);
    }
  }
  const groups = new Map<number, ClassifiedItem[]>();
  ordered.forEach((item, k) => {
    const members = groups.get(root(k)) ?? [];
    // A source that already has an item in the story adds no coverage.
    if (!members.some((m) => m.sourceId === item.sourceId)) members.push(item);
    groups.set(root(k), members);
  });
  return [...groups.values()].map((members) => ({
    id: hashId(members.map((m) => m.id).join('|')),
    category: members[0].category,
    items: members,
    relevance: Math.max(...members.map((m) => m.relevance)),
    importance: Math.max(...members.map((m) => m.importance)),
    score: 0,
  }));
}
