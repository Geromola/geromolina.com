/**
 * The news wire's feeds (SPEC "News wire"). `hint` is the section a feed usually serves (the
 * classifier still decides); `weight` (0.5–1.5) ranks a source when several cover one story.
 * Checked 2026-10-27: every URL answered 200 with a feed. DOM-free.
 */
import type { Source } from './types';

export const SOURCES: readonly Source[] = [
  // World, the US and Mexico.
  { id: 'bbc-world', name: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', hint: 'world', weight: 1.3, lang: 'en' },
  { id: 'bbc-us', name: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml', hint: 'world', weight: 1.2, lang: 'en' },
  { id: 'npr', name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml', hint: 'world', weight: 1.2, lang: 'en' },
  { id: 'guardian-world', name: 'The Guardian', url: 'https://www.theguardian.com/world/rss', hint: 'world', weight: 1.2, lang: 'en' },
  { id: 'guardian-us', name: 'The Guardian', url: 'https://www.theguardian.com/us-news/rss', hint: 'world', weight: 1.1, lang: 'en' },
  { id: 'aljazeera', name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', hint: 'world', weight: 1.1, lang: 'en' },
  { id: 'nyt-world', name: 'The New York Times', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', hint: 'world', weight: 1.3, lang: 'en' },
  { id: 'nyt-us', name: 'The New York Times', url: 'https://rss.nytimes.com/services/xml/rss/nyt/US.xml', hint: 'world', weight: 1.2, lang: 'en' },
  { id: 'politico', name: 'Politico', url: 'https://rss.politico.com/politics-news.xml', hint: 'world', weight: 1, lang: 'en' },
  { id: 'mexico-news-daily', name: 'Mexico News Daily', url: 'https://mexiconewsdaily.com/feed/', hint: 'world', weight: 1, lang: 'en' },
  { id: 'elpais-mexico', name: 'El País', url: 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/mexico/portada', hint: 'world', weight: 1.2, lang: 'es' },
  { id: 'el-universal', name: 'El Universal', url: 'https://www.eluniversal.com.mx/arc/outboundfeeds/rss/?outputType=xml', hint: 'world', weight: 0.9, lang: 'es' },
  { id: 'expansion', name: 'Expansión', url: 'https://expansion.mx/rss', hint: 'world', weight: 1, lang: 'es' },
  // Clean tech.
  { id: 'canary', name: 'Canary Media', url: 'https://www.canarymedia.com/rss', hint: 'cleantech', weight: 1.3, lang: 'en' },
  { id: 'latitude', name: 'Latitude Media', url: 'https://www.latitudemedia.com/feed', hint: 'cleantech', weight: 1.2, lang: 'en' },
  { id: 'utility-dive', name: 'Utility Dive', url: 'https://www.utilitydive.com/feeds/news/', hint: 'cleantech', weight: 1.2, lang: 'en' },
  { id: 'carbon-brief', name: 'Carbon Brief', url: 'https://www.carbonbrief.org/feed/', hint: 'cleantech', weight: 1.3, lang: 'en' },
  { id: 'inside-climate', name: 'Inside Climate News', url: 'https://insideclimatenews.org/feed/', hint: 'cleantech', weight: 1.1, lang: 'en' },
  { id: 'electrek', name: 'Electrek', url: 'https://electrek.co/feed/', hint: 'cleantech', weight: 0.8, lang: 'en' },
  { id: 'cleantechnica', name: 'CleanTechnica', url: 'https://cleantechnica.com/feed/', hint: 'cleantech', weight: 0.7, lang: 'en' },
  { id: 'pv-magazine', name: 'pv magazine', url: 'https://www.pv-magazine.com/feed/', hint: 'cleantech', weight: 1, lang: 'en' },
  { id: 'energy-storage', name: 'Energy-Storage.news', url: 'https://www.energy-storage.news/feed/', hint: 'cleantech', weight: 1.1, lang: 'en' },
  // AI.
  { id: 'mit-tr-ai', name: 'MIT Technology Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', hint: 'ai', weight: 1.3, lang: 'en' },
  { id: 'verge-ai', name: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', hint: 'ai', weight: 1, lang: 'en' },
  { id: 'ars-ai', name: 'Ars Technica', url: 'https://arstechnica.com/ai/feed/', hint: 'ai', weight: 1.1, lang: 'en' },
  { id: 'techcrunch-ai', name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', hint: 'ai', weight: 0.9, lang: 'en' },
  { id: 'simon-willison', name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', hint: 'ai', weight: 1.1, lang: 'en' },
  { id: 'import-ai', name: 'Import AI', url: 'https://importai.substack.com/feed', hint: 'ai', weight: 1.2, lang: 'en' },
  { id: 'openai', name: 'OpenAI', url: 'https://openai.com/news/rss.xml', hint: 'ai', weight: 1.2, lang: 'en' },
  { id: 'deepmind', name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', hint: 'ai', weight: 1.2, lang: 'en' },
  { id: 'hacker-news', name: 'Hacker News', url: 'https://hnrss.org/frontpage?points=150', hint: 'ai', weight: 0.6, lang: 'en', aggregator: true },
];

export const sourceById = (id: string): Source | undefined => SOURCES.find((s) => s.id === id);

/** The outlet a reader sees for an item: the source's name, or for an aggregator the linked site. */
export function outletName(sourceId: string, url: string, sources: ReadonlyMap<string, Source>): string {
  const source = sources.get(sourceId);
  if (!source) return sourceId;
  if (!source.aggregator) return source.name;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return source.name;
  }
}
