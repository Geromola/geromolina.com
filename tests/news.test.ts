import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clusterItems, jaccard, joinClassified, titleTokens } from '../src/news/cluster';
import { ageLabel, buildEdition, clockPT, editionDate, headline, isStale, longDate, seenIn, toEntry } from '../src/news/edition';
import { articleText, robotsAllows, wordCount } from '../src/news/extract';
import { FakeBriefer, FakeClassifier, FakeEditor } from '../src/news/fake';
import { parseFeed } from '../src/news/feed';
import { canonicalUrl, cleanText, hashId, normalizeItems } from '../src/news/normalize';
import { copiedRun, copiesSource } from '../src/news/overlap';
import { CostCapError, FatalError, NoClassificationsError, mapLimit, runPipeline, slug, tidyClassification, type PipelineDeps } from '../src/news/pipeline';
import { editionSchema, type Edition } from '../src/news/schema';
import { pickCandidates, scoreStories } from '../src/news/score';
import { fallbackPicks, sanitizePicks } from '../src/news/select';
import { SOURCES, outletName, sourceById } from '../src/news/sources';
import type { ClassifiedItem, Classifier, Editor, FeedItem, Item, Source, Story } from '../src/news/types';

const FEEDS = new URL('./fixtures/news/feeds/', import.meta.url);
const NOW = new Date('2026-10-27T13:00:00Z');
const fixtureIds = readdirSync(FEEDS).map((f) => f.replace(/\.xml$/, ''));
const fixtureSources = SOURCES.filter((s) => fixtureIds.includes(s.id));
const sourceMap = new Map(SOURCES.map((s) => [s.id, s]));
const feed = (id: string) => readFileSync(new URL(`${id}.xml`, FEEDS), 'utf8');

const item = (over: Partial<Item> = {}): Item => ({
  id: 'i1',
  sourceId: 'bbc-world',
  title: 'A title',
  url: 'https://example.test/a',
  summary: 'A summary of the story with enough words to matter here.',
  publishedAt: '2026-10-27T10:00:00.000Z',
  ...over,
});

const classified = (over: Partial<ClassifiedItem> = {}): ClassifiedItem => ({
  ...item(),
  category: 'world',
  relevance: 5,
  importance: 5,
  snippet: 'A snippet.',
  titleEn: null,
  eventKey: '',
  ...over,
});

const story = (id: string, over: Partial<Story> = {}): Story => ({
  id,
  category: 'world',
  items: [classified({ id: `${id}-item`, url: `https://example.test/${id}` })],
  relevance: 5,
  importance: 5,
  score: 10,
  ...over,
});

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    sources: fixtureSources,
    fetchFeed: async (s) => feed(s.id),
    fetchArticle: async () => null,
    extractArticle: articleText,
    classifier: new FakeClassifier(),
    editor: new FakeEditor(),
    briefer: new FakeBriefer(),
    previous: [],
    now: NOW,
    ...over,
  };
}

describe('sources', () => {
  it('have unique ids, https feeds, sane weights', () => {
    expect(new Set(SOURCES.map((s) => s.id)).size).toBe(SOURCES.length);
    for (const s of SOURCES) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.weight).toBeGreaterThanOrEqual(0.5);
      expect(s.weight).toBeLessThanOrEqual(1.5);
    }
    expect(sourceById('canary')?.name).toBe('Canary Media');
  });

  it('credit an aggregator item to the linked site', () => {
    expect(outletName('hacker-news', 'https://www.anthropic.com/news/drug-development', sourceMap)).toBe('anthropic.com');
    expect(outletName('canary', 'https://example.test/x', sourceMap)).toBe('Canary Media');
    expect(outletName('unknown', 'https://example.test/x', sourceMap)).toBe('unknown');
  });

  it('cover every section, and Mexico in Spanish', () => {
    for (const hint of ['cleantech', 'ai', 'world'] as const) expect(SOURCES.some((s) => s.hint === hint)).toBe(true);
    expect(SOURCES.some((s) => s.lang === 'es')).toBe(true);
  });
});

describe('feed parsing', () => {
  it('reads RSS: title, link, HTML summary, date', () => {
    const items = parseFeed(feed('canary'), 'canary');
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Northgate Energy switches on 400 MW sodium-ion battery plant');
    expect(items[0].url).toBe('https://www.example-clean.test/batteries/northgate-sodium-ion');
    expect(items[0].summary).toContain('<p>');
    expect(items[0].publishedAt).toBe('Tue, 27 Oct 2026 04:00:00 GMT');
  });

  it('reads Atom: the alternate link, summary or content, published or updated', () => {
    const items = parseFeed(feed('simon-willison'), 'simon-willison');
    expect(items.map((i) => i.url)).toEqual(['https://example-blog.test/2026/Oct/27/atlas-3/', 'https://example-blog.test/2026/Oct/26/laptop-models/']);
    expect(items[1].summary).toContain('Quantised');
    expect(items[1].publishedAt).toBe('2026-10-26T18:00:00+00:00');
  });

  it('decodes entities in links and keeps a non-permalink guid out of the url', () => {
    const items = parseFeed(feed('bbc-world'), 'bbc-world');
    expect(items[0].url).toContain('?utm_source=rss&utm_medium=feed');
    const times = parseFeed(feed('nyt-world'), 'nyt-world');
    expect(times[0].url).toBe('https://www.example-times.test/2026/10/27/world/geneva-talks.html');
  });

  it('returns nothing for broken or unknown XML', () => {
    expect(parseFeed('<html><body>not a feed</body></html>', 'x')).toEqual([]);
    expect(parseFeed('<<<', 'x')).toEqual([]);
  });
});

describe('normalize', () => {
  it('canonicalizes URLs', () => {
    expect(canonicalUrl('http://WWW.Example.test/a/?utm_source=x&b=2&a=1#frag')).toBe('https://example.test/a?a=1&b=2');
    expect(canonicalUrl('https://amp.example.test/story/amp/')).toBe('https://example.test/story');
    expect(canonicalUrl('https://example.test/story.amp.html')).toBe('https://example.test/story.html');
    expect(canonicalUrl('https://example.test/')).toBe('https://example.test/');
    expect(canonicalUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalUrl('not a url')).toBeNull();
  });

  it('turns HTML into plain text and cuts at a word', () => {
    expect(cleanText('<p>Fish &amp; chips&nbsp;&#8212; <b>tonight</b></p><script>x()</script>')).toBe('Fish & chips — tonight');
    const long = cleanText('one two three four five six seven eight nine ten', 20);
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(21);
  });

  it('hashes ids stably', () => {
    expect(hashId('https://example.test/a')).toBe(hashId('https://example.test/a'));
    expect(hashId('https://example.test/a')).not.toBe(hashId('https://example.test/b'));
    expect(hashId('x')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps fresh items, one per canonical URL, newest first', () => {
    const raw = fixtureSources.flatMap((s) => parseFeed(feed(s.id), s.id));
    const items = normalizeItems(raw, NOW);
    expect(items.some((i) => i.title.startsWith('Storm season'))).toBe(false);
    expect(items.filter((i) => i.url === 'https://example-world.test/news/rates-hold')).toHaveLength(1);
    for (let k = 1; k < items.length; k++) expect(items[k - 1].publishedAt >= items[k].publishedAt).toBe(true);
  });

  it('caps items per source and skips what earlier editions ran', () => {
    const many: FeedItem[] = Array.from({ length: 30 }, (_, k) => ({
      sourceId: 's',
      title: `Story ${k}`,
      url: `https://example.test/${k}`,
      summary: '',
      publishedAt: new Date(NOW.getTime() - k * 60_000).toISOString(),
    }));
    expect(normalizeItems(many, NOW, undefined, { perSource: 5 }).map((i) => i.title)).toEqual(['Story 0', 'Story 1', 'Story 2', 'Story 3', 'Story 4']);
    const seen = { urls: new Set(['https://example.test/0']), eventKeys: new Set<string>() };
    expect(normalizeItems(many, NOW, seen, { perSource: 2 }).map((i) => i.title)).toEqual(['Story 1', 'Story 2']);
  });

  it('dates an undated item now and drops one from the future', () => {
    const items = normalizeItems(
      [
        { sourceId: 's', title: 'Undated', url: 'https://example.test/u', summary: '', publishedAt: null },
        { sourceId: 's', title: 'Future', url: 'https://example.test/f', summary: '', publishedAt: '2027-01-01T00:00:00Z' },
      ],
      NOW,
    );
    expect(items.map((i) => i.title)).toEqual(['Undated']);
    expect(items[0].publishedAt).toBe(NOW.toISOString());
  });
});

describe('cluster', () => {
  it('tokenizes titles without accents or stop words', () => {
    expect([...titleTokens('El Senado aprueba la reforma eléctrica')]).toEqual(['senado', 'aprueba', 'reforma', 'electrica']);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });

  it('joins classifications and drops `none`', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
    const joined = joinClassified(items, [
      { id: 'a', category: 'ai', relevance: 7, importance: 4, snippet: 's', titleEn: null, eventKey: 'k' },
      { id: 'b', category: 'none', relevance: 0, importance: 0, snippet: '', titleEn: null, eventKey: '' },
    ]);
    expect(joined.map((i) => [i.id, i.category])).toEqual([['a', 'ai']]);
  });

  it('groups by story key or similar titles inside a section; the heaviest source represents', () => {
    const items = [
      classified({ id: 'a', sourceId: 'cleantechnica', category: 'cleantech', title: 'Northgate sodium-ion battery plant opens in Nevada', eventKey: 'northgate-battery' }),
      classified({ id: 'b', sourceId: 'canary', category: 'cleantech', title: 'Something else entirely', eventKey: 'northgate-battery' }),
      classified({ id: 'c', sourceId: 'utility-dive', category: 'cleantech', title: 'Northgate sodium-ion battery plant opens', eventKey: '' }),
      classified({ id: 'd', sourceId: 'npr', category: 'world', title: 'Northgate sodium-ion battery plant opens in Nevada', eventKey: 'northgate-battery' }),
    ];
    const stories = clusterItems(items, sourceMap);
    expect(stories).toHaveLength(2);
    const clean = stories.find((s) => s.category === 'cleantech')!;
    expect(clean.items[0].sourceId).toBe('canary');
    expect(clean.items.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('counts one outlet once, and keeps the strongest scores', () => {
    const stories = clusterItems(
      [
        classified({ id: 'a', sourceId: 'npr', eventKey: 'k', relevance: 3, importance: 9 }),
        classified({ id: 'b', sourceId: 'npr', eventKey: 'k', relevance: 8, importance: 2 }),
      ],
      sourceMap,
    );
    expect(stories).toHaveLength(1);
    expect(stories[0].items).toHaveLength(1);
    expect(stories[0].items[0].id).toBe('a');
    expect(stories[0].importance).toBe(9);
  });
});

describe('score and candidates', () => {
  it('rewards relevance, importance and coverage, and decays with age', () => {
    const base = story('a');
    const [scored] = scoreStories([base], sourceMap, NOW);
    const [moreRelevant] = scoreStories([{ ...base, relevance: 9 }], sourceMap, NOW);
    const [covered] = scoreStories([{ ...base, items: [...base.items, classified({ id: 'x', sourceId: 'npr' })] }], sourceMap, NOW);
    const [older] = scoreStories([{ ...base, items: [classified({ publishedAt: '2026-10-26T10:00:00Z' })] }], sourceMap, NOW);
    expect(moreRelevant.score).toBeGreaterThan(scored.score);
    expect(covered.score).toBeGreaterThan(scored.score);
    expect(older.score).toBeLessThan(scored.score);
  });

  it('takes the top of each section plus the most important overall', () => {
    const stories: Story[] = [];
    for (let k = 0; k < 20; k++) stories.push(story(`w${k}`, { category: 'world', score: 100 - k, importance: 2 }));
    for (let k = 0; k < 20; k++) stories.push(story(`a${k}`, { category: 'ai', score: 50 - k, importance: k === 19 ? 10 : 1 }));
    const ids = new Set(pickCandidates(stories).map((s) => s.id));
    expect(ids.has('w14')).toBe(true);
    expect(ids.has('w15')).toBe(false);
    expect(ids.has('a19')).toBe(true); // low score, top importance
    expect(ids.size).toBe(31);
  });
});

describe('picks', () => {
  const candidates = [
    story('w1', { importance: 9, score: 20 }),
    story('w2', { importance: 8, score: 18 }),
    story('w3', { importance: 3, score: 9 }),
    story('c1', { category: 'cleantech', score: 15 }),
    story('c2', { category: 'cleantech', score: 12 }),
    story('a1', { category: 'ai', score: 14 }),
    story('a2', { category: 'ai', score: 11 }),
  ];

  it('keeps valid ids once, in their own section, with short whys', () => {
    const picks = sanitizePicks(
      {
        mustKnow: [{ id: 'w1', why: 'one two three four five six seven eight nine ten eleven twelve thirteen' }, { id: 'nope', why: '' }],
        sections: {
          cleantech: [{ id: 'c1', why: 'x' }, { id: 'a1', why: 'wrong section' }, { id: 'c2', why: 'y' }],
          ai: [{ id: 'a1', why: '' }, { id: 'a2', why: '' }],
          world: [{ id: 'w1', why: 'repeat' }, { id: 'w2', why: '' }, { id: 'w3', why: '' }],
        },
      },
      candidates,
    );
    expect(picks).not.toBeNull();
    expect(picks!.mustKnow.map((p) => p.id)).toEqual(['w1']);
    expect(picks!.mustKnow[0].why.split(' ')).toHaveLength(12);
    expect(picks!.sections.cleantech.map((p) => p.id)).toEqual(['c1', 'c2']);
    expect(picks!.sections.world.map((p) => p.id)).toEqual(['w2', 'w3']);
  });

  it('rejects picks too thin to make an edition', () => {
    expect(sanitizePicks({ mustKnow: [], sections: { cleantech: [{ id: 'c1', why: '' }], ai: [], world: [] } }, candidates)).toBeNull();
    expect(sanitizePicks({ mustKnow: [{ id: 'bogus', why: '' }], sections: { cleantech: [], ai: [], world: [] } }, candidates)).toBeNull();
  });

  it('falls back to the scores: important stories first, no repeats', () => {
    const picks = fallbackPicks(candidates);
    expect(picks.mustKnow.map((p) => p.id)).toEqual(['w1', 'w2']);
    expect(picks.sections.world.map((p) => p.id)).toEqual(['w3']);
    expect(picks.sections.cleantech.map((p) => p.id)).toEqual(['c1', 'c2']);
    expect(picks.sections.ai.map((p) => p.id)).toEqual(['a1', 'a2']);
  });
});

describe('copy check', () => {
  const source = 'The Nevada site is the largest grid storage project built on sodium-ion cells so far.';
  it('flags a run of eight shared words, ignoring case and punctuation', () => {
    expect(copiesSource('Officials said the nevada site is the largest grid storage project in the region.', source)).toBe(true);
    expect(copiesSource('A Nevada plant now holds the record for sodium-ion grid storage.', source)).toBe(false);
    expect(copiesSource('short', source)).toBe(false);
  });

  it('names the longest reused run, for the retry prompt', () => {
    expect(copiedRun('So: the Nevada site is the largest grid storage project built yet.', source)).toBe(
      'the nevada site is the largest grid storage project built',
    );
    expect(copiedRun('A Nevada plant now holds the record.', source)).toBeNull();
  });
});

describe('article extraction and robots.txt', () => {
  it('keeps the article paragraphs and drops the chrome', () => {
    const html = `<html><nav><p>Home News Sport Weather and many other links here</p></nav>
      <article><h1>Title</h1><p>The first paragraph of the story, long enough to keep around.</p>
      <script>track()</script><p>Short.</p><figure><p>A caption that should not appear in the text at all.</p></figure>
      <p>The second paragraph, with &amp; an entity and <a href="#">a link</a> inside it.</p></article>
      <footer><p>Copyright notice and the rest of the footer text here.</p></footer></html>`;
    const text = articleText(html);
    expect(text).toBe('The first paragraph of the story, long enough to keep around.\n\nThe second paragraph, with & an entity and a link inside it.');
    expect(wordCount(text)).toBe(23);
    expect(wordCount(articleText(html, 5))).toBe(5);
  });

  it('honours robots.txt: the agent group, the longest rule, Allow on ties, wildcards', () => {
    const robots = `User-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /*.pdf$\n\nUser-agent: GPTBot\nUser-agent: newswire\nDisallow: /`;
    expect(robotsAllows(robots, '/news/a', 'Mozilla/5.0 (compatible; geromolina-newswire)')).toBe(false);
    expect(robotsAllows(robots, '/news/a', 'SomeBot')).toBe(true);
    expect(robotsAllows(robots, '/private/x', 'SomeBot')).toBe(false);
    expect(robotsAllows(robots, '/private/open/x', 'SomeBot')).toBe(true);
    expect(robotsAllows(robots, '/files/report.pdf', 'SomeBot')).toBe(false);
    expect(robotsAllows(robots, '/files/report.pdf?x=1', 'SomeBot')).toBe(true);
    expect(robotsAllows('', '/anything', 'SomeBot')).toBe(true);
  });
});

describe('edition helpers', () => {
  it('dates editions in Pacific time', () => {
    expect(editionDate(new Date('2026-10-27T06:59:00Z'))).toBe('2026-10-26');
    expect(editionDate(new Date('2026-10-27T13:00:00Z'))).toBe('2026-10-27');
    expect(longDate('2026-10-27')).toBe('Tuesday, October 27');
    expect(clockPT('2026-10-27T13:04:00Z')).toBe('06:04 PT');
  });

  it('strips live-blog and media labels from headlines', () => {
    expect(headline('Live Updates: At Least 68 Killed in Train Crash in Spain')).toEqual({ text: 'At Least 68 Killed in Train Crash in Spain', live: true });
    expect(headline("Israel 2026 election results, live: Netanyahu's party accuses Arab parties")).toEqual({
      text: "Israel 2026 election results: Netanyahu's party accuses Arab parties",
      live: true,
    });
    expect(headline('How Trump is trying to disrupt the midterms – video explainer')).toEqual({ text: 'How Trump is trying to disrupt the midterms', live: false });
    expect(headline('En vivo: Sheinbaum presenta su informe')).toEqual({ text: 'Sheinbaum presenta su informe', live: true });
    expect(headline('Fed set to hold interest rates steady')).toEqual({ text: 'Fed set to hold interest rates steady', live: false });
    // A word that only looks like a label stays.
    expect(headline('Live music venues struggle as costs rise').text).toBe('Live music venues struggle as costs rise');
  });

  it('labels ages and spots a stale edition', () => {
    expect(ageLabel('2026-10-27T12:15:00Z', NOW)).toBe('45m');
    expect(ageLabel('2026-10-27T10:00:00Z', NOW)).toBe('3h');
    expect(ageLabel('2026-10-24T13:00:00Z', NOW)).toBe('3d');
    expect(isStale('2026-10-26T13:00:00Z', NOW)).toBe(false);
    expect(isStale('2026-10-25T12:00:00Z', NOW)).toBe(true);
  });

  it('shows a translated title with the original kept, and one entry per outlet', () => {
    const s: Story = story('m', {
      items: [
        classified({ sourceId: 'elpais-mexico', title: 'El Senado aprueba', titleEn: 'Senate approves', url: 'https://example-mx.test/a' }),
        classified({ id: 'x', sourceId: 'bbc-world', url: 'https://example.test/b' }),
        classified({ id: 'y', sourceId: 'bbc-us', url: 'https://example.test/c' }),
      ],
    });
    const entry = toEntry(s, { id: 'm', why: 'w' }, undefined, sourceMap);
    expect(entry.title).toBe('Senate approves');
    expect(entry.originalTitle).toBe('El Senado aprueba');
    expect(entry.lang).toBe('es');
    expect(entry.alsoCovered).toEqual([{ source: 'BBC', url: 'https://example.test/b' }]);
    expect(entry.brief).toBeNull();
  });
});

describe('pipeline helpers', () => {
  it('runs with a concurrency limit and keeps order', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20]);
    expect(peak).toBe(2);
  });

  it('tidies a classification: clamps, slugs, drops a copied snippet', () => {
    const it0 = item({ title: 'T', summary: 'one two three four five six seven eight nine ten' });
    const tidy = tidyClassification(
      { id: 'i1', category: 'ai', relevance: 12.4, importance: -3, snippet: 'Indeed one two three four five six seven eight nine.', titleEn: '  ', eventKey: 'Atlas 3 Launch!' },
      it0,
    );
    expect(tidy).toMatchObject({ relevance: 10, importance: 0, snippet: '', titleEn: null, eventKey: 'atlas-3-launch' });
    expect(slug('México: Pemex — deuda')).toBe('mexico-pemex-deuda');
  });
});

describe('pipeline (fakes)', () => {
  it('builds a valid edition from the fixtures', async () => {
    const edition = await runPipeline(deps());
    expect(() => editionSchema.parse(edition)).not.toThrow();
    expect(edition.date).toBe('2026-10-27');
    expect(edition.degraded).toBe(false);
    expect(edition.meta.feeds).toEqual({ ok: fixtureSources.length, failed: [] });
    expect(edition.meta.editor).toBe('claude');
    const entries = [...edition.mustKnow, ...edition.sections.cleantech, ...edition.sections.ai, ...edition.sections.world];
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    // The celebrity item is classified `none`; the stale one is outside the window.
    expect(entries.some((e) => /chef|Storm season/.test(e.title))).toBe(false);
    // The two battery reports and the two summit reports become one story each.
    const battery = entries.find((e) => /sodium-ion/i.test(e.title))!;
    expect(battery.alsoCovered).toHaveLength(1);
    expect(entries.filter((e) => /sodium-ion/i.test(e.title))).toHaveLength(1);
    expect(entries.filter((e) => /ceasefire/i.test(e.title))).toHaveLength(1);
    // Spanish sources show an English title.
    expect(entries.find((e) => e.lang === 'es')?.originalTitle).toBeDefined();
    expect(entries.every((e) => e.brief && e.basis === 'summaries')).toBe(true);
    expect(edition.meta.counts.picked).toBe(entries.length);
  });

  it('marks failed feeds, and degrades when most fail', async () => {
    const some = await runPipeline(deps({ fetchFeed: async (s) => (s.id === 'canary' ? Promise.reject(new Error('timeout')) : feed(s.id)) }));
    expect(some.meta.feeds.failed).toEqual(['canary']);
    expect(some.degraded).toBe(false);
    const most = await runPipeline(deps({ fetchFeed: async (s) => (s.id === 'bbc-world' || s.id === 'nyt-world' ? feed(s.id) : '<rss/>') }));
    expect(most.degraded).toBe(true);
    expect(most.meta.notes).toContain('Fewer than half the feeds answered');
  });

  it('falls back to the scores when the editor fails or returns junk', async () => {
    const failing: Editor = { model: 'x', edit: async () => Promise.reject(new Error('overloaded')) };
    const failed = await runPipeline(deps({ editor: failing }));
    expect(failed.meta.editor).toBe('fallback');
    expect(failed.degraded).toBe(true);
    expect(failed.mustKnow.length + failed.sections.world.length).toBeGreaterThan(0);
    const junk: Editor = { model: 'x', edit: async () => ({ picks: { mustKnow: [{ id: 'nope', why: '' }], sections: { cleantech: [], ai: [], world: [] } }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }) };
    expect((await runPipeline(deps({ editor: junk }))).meta.editor).toBe('fallback');
  });

  it('retries a failing chunk item by item, and gives up only when nothing classifies', async () => {
    const real = new FakeClassifier();
    let calls = 0;
    const flaky: Classifier = {
      model: 'flaky',
      classify: async (items, sources) => {
        calls++;
        if (items.length > 1) throw new Error('refusal');
        if (items[0].sourceId === 'canary') throw new Error('refusal');
        return real.classify(items, sources);
      },
    };
    const edition = await runPipeline(deps({ classifier: flaky }));
    expect(calls).toBeGreaterThan(1);
    expect(edition.meta.notes.some((n) => /could not be classified/.test(n))).toBe(true);
    const dead: Classifier = { model: 'dead', classify: async () => Promise.reject(new Error('down')) };
    await expect(runPipeline(deps({ classifier: dead }))).rejects.toBeInstanceOf(NoClassificationsError);
  });

  it('stops at the first error no retry can fix, without retrying item by item', async () => {
    let calls = 0;
    const noKey: Classifier = {
      model: 'no-key',
      classify: async () => {
        calls++;
        throw new FatalError('No Anthropic credentials');
      },
    };
    await expect(runPipeline(deps({ classifier: noKey }))).rejects.toBeInstanceOf(FatalError);
    expect(calls).toBeLessThanOrEqual(4); // at most the chunks already in flight
  });

  it('stops at the cost cap', async () => {
    const pricey: Classifier = {
      model: 'pricey',
      classify: async (items, sources) => ({ ...(await new FakeClassifier().classify(items, sources)), usage: { inputTokens: 1, outputTokens: 1, costUsd: 1 } }),
    };
    await expect(runPipeline(deps({ classifier: pricey }))).rejects.toBeInstanceOf(CostCapError);
  });

  it('writes briefs from the article when it can be read, and drops copies', async () => {
    const paragraph = 'Crews finished commissioning the plant last week after eighteen months of construction work in the desert. ';
    const html = `<article><p>${paragraph.repeat(15)}</p></article>`;
    const told: (string | null)[] = [];
    const copier = {
      model: 'copier',
      brief: async ({ text, copied }: { text: string; copied: string | null }) => {
        told.push(copied);
        return { brief: text.split(' ').slice(0, 20).join(' '), usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
      },
    };
    const edition = await runPipeline(deps({ fetchArticle: async () => html, briefer: copier }));
    const entries = [...edition.mustKnow, ...edition.sections.cleantech];
    expect(entries.every((e) => e.basis === 'article' && e.brief === null)).toBe(true);
    expect(edition.meta.counts.briefs).toBe(0);
    // Each story: a first try told nothing, then a retry told the exact words it reused.
    expect(told.filter((c) => c === null).length).toBe(told.length / 2);
    expect(told.some((c) => c?.startsWith('crews finished commissioning the plant'))).toBe(true);
  });

  it('skips what the last editions ran', async () => {
    const first = await runPipeline(deps());
    const second = await runPipeline(deps({ previous: [first] }));
    const ids = (e: Edition) => [...e.mustKnow, ...e.sections.cleantech, ...e.sections.ai, ...e.sections.world].map((x) => x.url);
    expect(ids(second).filter((u) => ids(first).includes(u))).toEqual([]);
    expect(seenIn([first]).urls.size).toBeGreaterThanOrEqual(ids(first).length);
  });

  it('refuses to build an edition with a bad link', () => {
    const s = story('bad', { items: [classified({ url: 'javascript:alert(1)' })] });
    expect(() =>
      buildEdition({
        date: '2026-10-27',
        now: NOW,
        picks: { mustKnow: [{ id: 'bad', why: '' }], sections: { cleantech: [], ai: [], world: [] } },
        stories: [s],
        briefs: [],
        sources: sourceMap as Map<string, Source>,
        degraded: false,
        meta: {
          feeds: { ok: 0, failed: [] },
          counts: { fetched: 0, fresh: 0, classified: 0, kept: 0, stories: 0, candidates: 0, picked: 0, briefs: 0 },
          models: { classifier: '', editor: '', briefer: '' },
          editor: 'claude',
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          notes: [],
        },
      }),
    ).toThrow();
  });
});
