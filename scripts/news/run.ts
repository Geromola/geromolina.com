/**
 * Build today's news wire edition (SPEC "News wire"):
 *
 *   npm run news                       real run: feeds + Claude → src/content/news/YYYY-MM-DD.json
 *   npm run news -- --dry-run          fixtures + fakes, offline and free → a temp folder
 *   npm run news -- --eval             classifier accuracy on the labelled golden set
 *   --date YYYY-MM-DD   the edition's date (default: today in Pacific time)
 *   --out DIR           where editions live (default: src/content/news, or a temp folder for --dry-run)
 *
 * Exits non-zero when nothing could be classified or the cost cap is hit; then nothing is written
 * and the site keeps the last edition. Committing is the GitHub workflow's job.
 */
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { editionDate, KEEP_EDITIONS, sortEditions } from '../../src/news/edition';
import { articleText } from '../../src/news/extract';
import { FakeBriefer, FakeClassifier, FakeEditor } from '../../src/news/fake';
import { normalizeItems } from '../../src/news/normalize';
import { runPipeline, type PipelineDeps } from '../../src/news/pipeline';
import { editionSchema, type Edition } from '../../src/news/schema';
import { SOURCES } from '../../src/news/sources';
import type { Classifier, FeedItem, Source } from '../../src/news/types';
import { ClaudeBriefer, ClaudeClassifier, ClaudeEditor, classifierSystem, editorSystem } from './claude';
import { fetchArticle, fetchFeed } from './fetch';

const ROOT = resolve(import.meta.dirname, '../..');
const FIXTURES = join(ROOT, 'tests/fixtures/news');
/** The fixtures' feeds are dated around this moment. */
const DRY_RUN_NOW = new Date('2026-10-27T13:00:00Z');

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    eval: { type: 'boolean', default: false },
    date: { type: 'string' },
    out: { type: 'string' },
  },
});

const log = (m: string) => console.log(`· ${m}`);

function readEditions(dir: string): Edition[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return [];
  }
  const editions: Edition[] = [];
  for (const f of files) {
    const parsed = editionSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    if (parsed.success) editions.push(parsed.data);
    else log(`skipping ${f}: not a valid edition`);
  }
  return sortEditions(editions);
}

function prune(dir: string) {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  for (const f of files.slice(KEEP_EDITIONS)) {
    rmSync(join(dir, f));
    log(`pruned ${f}`);
  }
}

function claudeSteps(profile: string) {
  const client = new Anthropic();
  return {
    classifier: new ClaudeClassifier(client, classifierSystem(profile)),
    editor: new ClaudeEditor(client, editorSystem(profile)),
    briefer: new ClaudeBriefer(client),
  };
}

interface GoldenItem {
  title: string;
  summary: string;
  lang: 'en' | 'es';
  expected: 'cleantech' | 'ai' | 'world' | 'none';
}

/** Classifier accuracy on `tests/fixtures/news/golden.json`, with every miss listed. */
async function evaluate(classifier: Classifier) {
  const golden = JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf8')) as GoldenItem[];
  const sources = new Map<string, Source>([
    ['golden-en', { id: 'golden-en', name: 'Golden', url: 'https://example.test/', hint: 'world', weight: 1, lang: 'en' }],
    ['golden-es', { id: 'golden-es', name: 'Golden', url: 'https://example.test/', hint: 'world', weight: 1, lang: 'es' }],
  ]);
  const feedItems: FeedItem[] = golden.map((g, k) => ({
    sourceId: `golden-${g.lang}`,
    title: g.title,
    url: `https://example.test/golden/${k}`,
    summary: g.summary,
    publishedAt: null,
  }));
  const items = normalizeItems(feedItems, new Date(), undefined, { perSource: 1000 });
  const expected = new Map(items.map((i) => [i.id, golden[Number(i.url.split('/').pop())].expected]));
  const results = [];
  for (let k = 0; k < items.length; k += 20) results.push(...(await classifier.classify(items.slice(k, k + 20), sources)).results);
  let right = 0;
  for (const r of results) {
    const want = expected.get(r.id);
    if (r.category === want) right++;
    else console.log(`  miss: got ${r.category}, want ${want}: ${items.find((i) => i.id === r.id)?.title}`);
  }
  console.log(`classifier accuracy: ${right}/${items.length} (${Math.round((100 * right) / items.length)}%)`);
}

async function main() {
  const dry = args['dry-run'];
  const profile = readFileSync(join(ROOT, 'src/news/profile.md'), 'utf8');

  if (args.eval) {
    await evaluate(dry ? new FakeClassifier() : claudeSteps(profile).classifier);
    return;
  }

  const out = resolve(args.out ?? (dry ? join(tmpdir(), 'news-dry-run') : join(ROOT, 'src/content/news')));
  const now = dry ? DRY_RUN_NOW : new Date();
  const date = args.date ?? editionDate(now);
  const previous = readEditions(out).filter((e) => e.date < date);

  let deps: PipelineDeps;
  if (dry) {
    const ids = readdirSync(join(FIXTURES, 'feeds')).map((f) => f.replace(/\.xml$/, ''));
    deps = {
      sources: SOURCES.filter((s) => ids.includes(s.id)),
      fetchFeed: async (s) => readFileSync(join(FIXTURES, 'feeds', `${s.id}.xml`), 'utf8'),
      fetchArticle: async () => null,
      extractArticle: articleText,
      classifier: new FakeClassifier(),
      editor: new FakeEditor(),
      briefer: new FakeBriefer(),
      previous,
      now,
      date,
      log,
    };
  } else {
    deps = {
      sources: SOURCES,
      fetchFeed: (s) => fetchFeed(s.url),
      fetchArticle,
      extractArticle: articleText,
      ...claudeSteps(profile),
      previous,
      now,
      date,
      log,
    };
  }

  const edition = await runPipeline(deps);
  mkdirSync(out, { recursive: true });
  const file = join(out, `${edition.date}.json`);
  writeFileSync(file, `${JSON.stringify(edition, null, 2)}\n`);
  if (!dry) prune(out);

  const { counts, usage, notes } = edition.meta;
  console.log(`\nEdition ${edition.date}${edition.degraded ? ' (degraded)' : ''} → ${file}`);
  console.log(
    `  feeds ${edition.meta.feeds.ok}/${deps.sources.length} · fetched ${counts.fetched} · fresh ${counts.fresh} · kept ${counts.kept} · ` +
      `stories ${counts.stories} · candidates ${counts.candidates} · picked ${counts.picked} · briefs ${counts.briefs}`,
  );
  console.log(`  ${usage.inputTokens} in / ${usage.outputTokens} out tokens · ≈ $${usage.costUsd.toFixed(4)} · editor: ${edition.meta.editor}`);
  for (const n of notes) console.log(`  note: ${n}`);
}

main().catch((err) => {
  console.error(`news wire failed: ${(err as Error).message}`);
  process.exit(1);
});
