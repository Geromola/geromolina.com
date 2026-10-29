/**
 * The news wire's funnel (SPEC "News wire"): feeds → items → classified → stories → candidates
 * → picks → briefs → edition. Every input and output goes through `PipelineDeps`, so Vitest and
 * `--dry-run` run the whole funnel with fakes; `scripts/news/run.ts` wires the real ones.
 */
import { clusterItems, joinClassified } from './cluster';
import { allEntries, buildEdition, editionDate, seenIn, SEEN_EDITIONS } from './edition';
import { MIN_ARTICLE_WORDS, wordCount } from './extract';
import { normalizeItems } from './normalize';
import { copiedRun, copiesSource } from './overlap';
import { outletName } from './sources';
import type { Edition } from './schema';
import { pickCandidates, scoreStories } from './score';
import { clampWords, fallbackPicks, pickCount, sanitizePicks } from './select';
import type { Brief, Briefer, Classification, Classifier, Editor, FeedItem, Item, Source, Story, Usage } from './types';
import { parseFeed } from './feed';

export const CHUNK = 20;
export const CONCURRENCY = 4;
export const COST_CAP_USD = 0.5;
export const SNIPPET_WORDS = 30;
export const BRIEF_WORDS = 90;

export interface PipelineDeps {
  sources: readonly Source[];
  /** The feed's XML; throws when the feed can't be read. */
  fetchFeed(source: Source): Promise<string>;
  /** The article's HTML, or null when robots.txt forbids it or the fetch fails. */
  fetchArticle(url: string): Promise<string | null>;
  /** Plain article text from the page's HTML. */
  extractArticle(html: string): string;
  classifier: Classifier;
  editor: Editor;
  briefer: Briefer;
  /** Earlier editions, newest first. */
  previous: readonly Edition[];
  now: Date;
  /** Defaults to the Pacific date of `now`. */
  date?: string;
  costCapUsd?: number;
  log?(message: string): void;
}

export class CostCapError extends Error {}
/** An error no retry can fix (missing credentials, a revoked key, an unknown model): stop the run. */
export class FatalError extends Error {}

const stopsTheRun = (err: unknown) => err instanceof CostCapError || err instanceof FatalError;
export class NoClassificationsError extends Error {}

/** `fn` over `items`, at most `limit` at a time, results in input order. The first error stops new work. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed) {
      const k = next++;
      try {
        out[k] = await fn(items[k], k);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const score10 = (n: number): number => (Number.isFinite(n) ? Math.min(10, Math.max(0, Math.round(n))) : 0);

/** Clamp the scores, slug the key, and drop a snippet that is too long or copies its source. */
export function tidyClassification(c: Classification, item: Item): Classification {
  let snippet = clampWords(c.snippet ?? '', SNIPPET_WORDS);
  if (copiesSource(snippet, `${item.title} ${item.summary}`)) snippet = '';
  const titleEn = c.titleEn?.trim() || null;
  return {
    id: c.id,
    category: c.category,
    relevance: score10(c.relevance),
    importance: score10(c.importance),
    snippet,
    titleEn,
    eventKey: slug(c.eventKey ?? ''),
  };
}

export async function runPipeline(deps: PipelineDeps): Promise<Edition> {
  const { sources, now } = deps;
  const log = deps.log ?? (() => {});
  const cap = deps.costCapUsd ?? COST_CAP_USD;
  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const notes: string[] = [];
  const spend = (u: Usage) => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.costUsd += u.costUsd;
    if (usage.costUsd > cap) throw new CostCapError(`Estimated cost $${usage.costUsd.toFixed(3)} is over the $${cap} cap`);
  };

  // 1. Fetch.
  const failed: string[] = [];
  // Per source, in `sources` order, so ties later on resolve the same way every run.
  const perSource = await mapLimit(sources, 8, async (source): Promise<FeedItem[]> => {
    try {
      const items = parseFeed(await deps.fetchFeed(source), source.id);
      if (items.length === 0) throw new Error('no items');
      return items;
    } catch (err) {
      failed.push(source.id);
      log(`feed ${source.id} failed: ${(err as Error).message}`);
      return [];
    }
  });
  const feedItems = perSource.flat();
  failed.sort();
  const feedsOk = sources.length - failed.length;
  log(`feeds: ${feedsOk}/${sources.length} ok, ${feedItems.length} items`);

  // 2. Normalize and dedupe against the last editions.
  const seen = seenIn(deps.previous.slice(0, SEEN_EDITIONS));
  const items = normalizeItems(feedItems, now, seen);
  log(`fresh: ${items.length}`);

  // 3. Classify, in chunks; a chunk that fails is retried item by item.
  const chunks: Item[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) chunks.push(items.slice(i, i + CHUNK));
  let failedItems = 0;
  const classifyChunk = async (chunk: Item[]): Promise<Classification[]> => {
    try {
      const { results, usage: u } = await deps.classifier.classify(chunk, sourceMap);
      spend(u);
      return results;
    } catch (err) {
      if (stopsTheRun(err)) throw err;
      if (chunk.length === 1) {
        failedItems++;
        log(`classify ${chunk[0].id} failed: ${(err as Error).message}`);
        return [];
      }
      log(`classify chunk failed (${(err as Error).message}); retrying one by one`);
      const singles = await mapLimit(chunk, CONCURRENCY, (item) => classifyChunk([item]));
      return singles.flat();
    }
  };
  const results = (await mapLimit(chunks, CONCURRENCY, classifyChunk)).flat();
  if (items.length > 0 && results.length === 0) throw new NoClassificationsError('The classifier returned nothing');
  if (failedItems) notes.push(`${failedItems} items could not be classified`);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const tidy = results.filter((r) => itemById.has(r.id)).map((r) => tidyClassification(r, itemById.get(r.id)!));
  const kept = joinClassified(items, tidy).filter((i) => !i.eventKey || !seen.eventKeys.has(i.eventKey));
  log(`classified: ${tidy.length}, kept: ${kept.length}`);

  // 4–5. Cluster and score.
  const stories = scoreStories(clusterItems(kept, sourceMap), sourceMap, now);
  const candidates = pickCandidates(stories);
  log(`stories: ${stories.length}, candidates: ${candidates.length}`);

  // 6. Edit, or fall back to the scores.
  const previousTitles = deps.previous[0] ? allEntries(deps.previous[0]).map((e) => e.title) : [];
  let picks = null;
  try {
    const { picks: raw, usage: u } = await deps.editor.edit({ candidates, sources: sourceMap, previousTitles, now });
    spend(u);
    picks = sanitizePicks(raw, candidates);
    if (!picks) notes.push('The editor’s picks did not validate; the scores picked the edition');
  } catch (err) {
    if (stopsTheRun(err)) throw err;
    notes.push(`The editor failed (${(err as Error).message}); the scores picked the edition`);
  }
  const editorUsed = picks !== null;
  if (!picks) picks = fallbackPicks(candidates);
  log(`picked: ${pickCount(picks)} (${editorUsed ? 'editor' : 'fallback'})`);

  // 7. Briefs for the picked stories.
  const storyById = new Map(candidates.map((s) => [s.id, s]));
  const picked = [...picks.mustKnow, ...Object.values(picks.sections).flat()]
    .map((p) => storyById.get(p.id))
    .filter((s): s is Story => s !== undefined);
  const briefs = await mapLimit(picked, CONCURRENCY, (story) => briefFor(story, deps, sourceMap, spend, log));
  const written = briefs.filter((b) => b.brief !== null).length;
  log(`briefs: ${written}/${picked.length}`);

  // 8. Validate and build.
  const degraded = !editorUsed || feedsOk < sources.length / 2;
  if (feedsOk < sources.length / 2) notes.push('Fewer than half the feeds answered');
  return buildEdition({
    date: deps.date ?? editionDate(now),
    now,
    picks,
    stories: candidates,
    briefs,
    sources: sourceMap,
    degraded,
    meta: {
      feeds: { ok: feedsOk, failed },
      counts: {
        fetched: feedItems.length,
        fresh: items.length,
        classified: tidy.length,
        kept: kept.length,
        stories: stories.length,
        candidates: candidates.length,
        picked: picked.length,
        briefs: written,
      },
      models: { classifier: deps.classifier.model, editor: deps.editor.model, briefer: deps.briefer.model },
      editor: editorUsed ? 'claude' : 'fallback',
      usage: { ...usage, costUsd: Math.round(usage.costUsd * 10000) / 10000 },
      notes,
    },
  });
}

/** The cluster's summaries, one per outlet, as the fallback source text. */
export function summariesText(story: Story, sources: ReadonlyMap<string, Source>): string {
  return story.items
    .filter((i) => i.summary)
    .map((i) => `${outletName(i.sourceId, i.url, sources)}: ${i.summary}`)
    .join('\n\n');
}

async function briefFor(
  story: Story,
  deps: PipelineDeps,
  sources: ReadonlyMap<string, Source>,
  spend: (u: Usage) => void,
  log: (m: string) => void,
): Promise<Brief> {
  const rep = story.items[0];
  let text = '';
  let basis: Brief['basis'] = 'summaries';
  try {
    const html = await deps.fetchArticle(rep.url);
    const article = html ? deps.extractArticle(html) : '';
    if (wordCount(article) >= MIN_ARTICLE_WORDS) {
      text = article;
      basis = 'article';
    }
  } catch {
    /* fall back to the summaries */
  }
  if (!text) text = summariesText(story, sources);
  if (!text) return { id: story.id, brief: null, basis };
  const sourceName = outletName(rep.sourceId, rep.url, sources);
  // A second try is told exactly which words it reused.
  let copied: string | null = null;
  for (const attempt of [1, 2]) {
    try {
      const { brief, usage } = await deps.briefer.brief({ story, sourceName, text, basis, copied });
      spend(usage);
      if (!brief) return { id: story.id, brief: null, basis };
      const clean = clampWords(brief, BRIEF_WORDS);
      copied = copiedRun(clean, text);
      if (!copied) return { id: story.id, brief: clean, basis };
      log(`brief ${story.id} reused “${copied}”${attempt === 2 ? '; dropped' : '; retrying'}`);
    } catch (err) {
      if (stopsTheRun(err)) throw err;
      log(`brief ${story.id} failed: ${(err as Error).message}`);
      return { id: story.id, brief: null, basis };
    }
  }
  return { id: story.id, brief: null, basis };
}
