/**
 * Build and read editions: picks + stories + briefs → the validated edition JSON, what earlier
 * editions already ran, and the small formatting helpers the page uses. Pure.
 */
import { displayTitle } from './cluster';
import type { Seen } from './normalize';
import { editionSchema, type Edition, type Entry } from './schema';
import { outletName } from './sources';
import { SECTIONS, type Brief, type Pick, type Picks, type Source, type Story } from './types';

export const TIME_ZONE = 'America/Los_Angeles';
export const STALE_HOURS = 36;
/** Editions whose URLs and story keys aren't repeated. */
export const SEEN_EDITIONS = 3;
/** Editions kept in `src/content/news/` (the archive shows the newest `ARCHIVE_PAGES`). */
export const KEEP_EDITIONS = 30;
export const ARCHIVE_PAGES = 14;

/** `YYYY-MM-DD` in Pacific time. */
export function editionDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function toEntry(story: Story, pick: Pick, brief: Brief | undefined, sources: ReadonlyMap<string, Source>): Entry {
  const [rep, ...others] = story.items;
  const source = sources.get(rep.sourceId);
  const outlet = outletName(rep.sourceId, rep.url, sources);
  const translated = Boolean(rep.titleEn) && rep.titleEn !== rep.title;
  return {
    id: story.id,
    section: story.category,
    title: displayTitle(rep),
    ...(translated ? { originalTitle: rep.title } : {}),
    lang: source?.lang ?? 'en',
    source: outlet,
    url: rep.url,
    publishedAt: rep.publishedAt,
    snippet: rep.snippet,
    brief: brief?.brief ?? null,
    basis: brief?.basis ?? 'summaries',
    why: pick.why,
    eventKey: rep.eventKey,
    alsoCovered: others
      .map((o) => ({ source: outletName(o.sourceId, o.url, sources), url: o.url }))
      // Two feeds of one outlet (BBC World and BBC US) are one source to the reader.
      .filter((o, k, all) => o.source !== outlet && all.findIndex((x) => x.source === o.source) === k),
  };
}

export interface BuildInput {
  date: string;
  now: Date;
  picks: Picks;
  stories: readonly Story[];
  briefs: readonly Brief[];
  sources: ReadonlyMap<string, Source>;
  degraded: boolean;
  meta: Edition['meta'];
}

/** The edition, validated against the schema (throws if it doesn't hold). */
export function buildEdition({ date, now, picks, stories, briefs, sources, degraded, meta }: BuildInput): Edition {
  const storyById = new Map(stories.map((s) => [s.id, s]));
  const briefById = new Map(briefs.map((b) => [b.id, b]));
  const entries = (list: Pick[]) =>
    list.flatMap((p) => {
      const story = storyById.get(p.id);
      return story ? [toEntry(story, p, briefById.get(p.id), sources)] : [];
    });
  const edition: Edition = {
    date,
    generatedAt: now.toISOString(),
    degraded,
    mustKnow: entries(picks.mustKnow),
    sections: { cleantech: entries(picks.sections.cleantech), ai: entries(picks.sections.ai), world: entries(picks.sections.world) },
    meta,
  };
  return editionSchema.parse(edition);
}

export const allEntries = (e: Edition): Entry[] => [...e.mustKnow, ...SECTIONS.flatMap((s) => e.sections[s])];

/** URLs (every outlet's) and story keys run by the given editions. */
export function seenIn(editions: readonly Edition[]): Seen {
  const urls = new Set<string>();
  const eventKeys = new Set<string>();
  for (const entry of editions.flatMap(allEntries)) {
    urls.add(entry.url);
    for (const o of entry.alsoCovered) urls.add(o.url);
    if (entry.eventKey) eventKeys.add(entry.eventKey);
  }
  return { urls, eventKeys };
}

/** Newest first. */
export const sortEditions = <T extends { date: string }>(editions: readonly T[]): T[] =>
  [...editions].sort((a, b) => b.date.localeCompare(a.date));

const LIVE_PREFIX = /^(?:live(?: updates?| blog)?|en vivo|en directo|minuto a minuto)\s*[:|–—-]\s*/i;
const LIVE_INFIX = /,?\s+live\s*:\s+/i;
const MEDIA_SUFFIX = /\s+[–—|-]\s+(?:video(?: explainer)?|podcast|watch|in pictures|live)$/i;

/**
 * The headline without live-blog and media labels ("Live Updates: …", "…, live: …",
 * "… – video explainer"); `live` says whether it was a live blog, shown as a chip instead.
 */
export function headline(title: string): { text: string; live: boolean } {
  let text = title.trim();
  let live = false;
  if (LIVE_PREFIX.test(text)) {
    text = text.replace(LIVE_PREFIX, '');
    live = true;
  }
  if (LIVE_INFIX.test(text)) {
    text = text.replace(LIVE_INFIX, ': ');
    live = true;
  }
  const media = text.match(MEDIA_SUFFIX);
  if (media) {
    text = text.replace(MEDIA_SUFFIX, '');
    if (/live/i.test(media[0])) live = true;
  }
  return { text: text || title, live };
}

/** "3h", "45m", "2d": how long before the edition was built the story was published. */
export function ageLabel(publishedAt: string, at: string | Date): string {
  const minutes = Math.max(0, Math.round((new Date(at).getTime() - Date.parse(publishedAt)) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export const isStale = (generatedAt: string, now: Date): boolean =>
  now.getTime() - Date.parse(generatedAt) > STALE_HOURS * 3600_000;

/** "Tuesday, October 27". */
export function longDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

/** "06:04 PT". */
export function clockPT(iso: string): string {
  const t = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE, hour12: false }).format(new Date(iso));
  return `${t} PT`;
}
