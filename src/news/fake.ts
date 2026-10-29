/**
 * Stand-ins for the three Claude steps, for Vitest and `npm run news -- --dry-run`. Deterministic
 * keyword rules, so the whole funnel runs offline and free. Pure.
 */
import { titleTokens } from './cluster';
import { fallbackPicks } from './select';
import type { Briefer, Classification, Classifier, Editor, Section, Usage } from './types';

const FREE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

const SECTION_WORDS: Record<Section, string[]> = {
  cleantech: ['battery', 'batteries', 'solar', 'wind', 'grid', 'storage', 'hydrogen', 'nuclear', 'geothermal', 'utility', 'emissions', 'climate', 'lithium', 'ev', 'electric', 'power', 'energy'],
  ai: ['ai', 'model', 'models', 'openai', 'anthropic', 'deepmind', 'llm', 'chatbot', 'chip', 'chips', 'gpu', 'agents', 'nvidia'],
  world: [],
};
const IMPORTANT = ['war', 'election', 'president', 'ceasefire', 'earthquake', 'fed', 'tariff', 'tariffs', 'summit', 'sheinbaum', 'congress', 'court'];
const SKIP = ['celebrity', 'football', 'recipe', 'horoscope'];

export class FakeClassifier implements Classifier {
  readonly model = 'fake-classifier';
  async classify(items: Parameters<Classifier['classify']>[0], sources: Parameters<Classifier['classify']>[1]) {
    const results: Classification[] = items.map((item) => {
      const source = sources.get(item.sourceId);
      const words = new Set(`${item.title} ${item.summary}`.toLowerCase().split(/[^\p{L}\p{N}]+/u));
      const hits = (list: string[]) => list.filter((w) => words.has(w)).length;
      const ai = hits(SECTION_WORDS.ai);
      const clean = hits(SECTION_WORDS.cleantech);
      const category: Classification['category'] = hits(SKIP)
        ? 'none'
        : ai > clean
          ? 'ai'
          : clean > ai
            ? 'cleantech'
            : (source?.hint ?? 'world');
      const summaryWords = item.summary.split(/\s+/).filter(Boolean);
      return {
        id: item.id,
        category,
        relevance: Math.min(10, 3 + 2 * (ai + clean)),
        importance: Math.min(10, 4 + 2 * hits(IMPORTANT)),
        // Seven words: under the copy check's eight-word run.
        snippet: summaryWords.length ? `Dry run: ${summaryWords.slice(0, 7).join(' ')}…` : '',
        titleEn: source?.lang === 'es' ? `[EN] ${item.title}` : null,
        eventKey: [...titleTokens(item.title)].slice(0, 4).join('-'),
      };
    });
    return { results, usage: FREE };
  }
}

export class FakeEditor implements Editor {
  readonly model = 'fake-editor';
  async edit({ candidates }: Parameters<Editor['edit']>[0]) {
    const picks = fallbackPicks(candidates);
    const why = (p: { id: string }) => ({ id: p.id, why: 'Picked by the dry-run editor.' });
    return {
      picks: {
        mustKnow: picks.mustKnow.map(why),
        sections: { cleantech: picks.sections.cleantech.map(why), ai: picks.sections.ai.map(why), world: picks.sections.world.map(why) },
      },
      usage: FREE,
    };
  }
}

export class FakeBriefer implements Briefer {
  readonly model = 'fake-briefer';
  async brief({ story, sourceName, basis }: Parameters<Briefer['brief']>[0]) {
    const n = story.items.length;
    return {
      brief:
        `This is a dry-run brief for a story from ${sourceName}, written without Claude. ` +
        `${n === 1 ? 'One outlet covers it' : `${n} outlets cover it`}, and the brief would come from the ${basis === 'article' ? 'article text' : 'feed summaries'}. ` +
        'A real run writes three or four sentences: what happened, the key number, and what comes next.',
      usage: FREE,
    };
  }
}
