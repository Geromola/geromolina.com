/**
 * Normalize and dedupe feed items: canonical URLs, plain-text summaries, the freshness window,
 * a cap per source, and what earlier editions already ran. Pure.
 */
import type { FeedItem, Item } from './types';

export const WINDOW_HOURS = 30;
export const PER_SOURCE = 25;
/** Hard cap on items sent to the classifier (SPEC "Guardrails"). */
export const MAX_ITEMS = 400;
export const SUMMARY_CHARS = 600;

const TRACKING = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$|cmpid$|smid$|taid$|ocid$|at_medium$|at_campaign$|partner$)/i;

/** Lowercase host without `www.`/`amp.`, no fragment, no tracking parameters, no AMP suffix. */
export function canonicalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.protocol = 'https:';
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^(www|amp)\./, '');
  for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key) || key === 'outputType') u.searchParams.delete(key);
  u.searchParams.sort();
  u.pathname = u.pathname.replace(/\/amp\/?$/, '/').replace(/\.amp(\.html)?$/, '$1') || '/';
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/$/, '');
  return u.toString();
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML → plain text: no tags, entities decoded, whitespace collapsed, cut at a word boundary. */
export function cleanText(html: string, max = Infinity): string {
  const t = decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

/** FNV-1a, 32-bit, as 8 hex chars: a stable id from the canonical URL. */
export function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface Seen {
  urls: ReadonlySet<string>;
  eventKeys: ReadonlySet<string>;
}

export const NOTHING_SEEN: Seen = { urls: new Set(), eventKeys: new Set() };

/**
 * Feed items → fresh, unique `Item`s: inside the window (an item with no date counts as fresh,
 * dated `now`), at most `perSource` per source (the newest), one per canonical URL (the newest
 * copy wins), none an earlier edition ran; newest first, capped at `MAX_ITEMS`.
 */
export function normalizeItems(
  items: readonly FeedItem[],
  now: Date,
  seen: Seen = NOTHING_SEEN,
  { windowHours = WINDOW_HOURS, perSource = PER_SOURCE } = {},
): Item[] {
  const from = now.getTime() - windowHours * 3600_000;
  // A little slack for clocks ahead of ours; anything further in the future is a bad date.
  const to = now.getTime() + 3600_000;
  const byUrl = new Map<string, Item>();
  const perSourceCount = new Map<string, number>();
  const dated = items.map((i) => {
    const t = i.publishedAt ? Date.parse(i.publishedAt) : NaN;
    return { i, t: Number.isFinite(t) ? t : now.getTime() };
  });
  // Newest first inside each source, so the per-source cap keeps the latest.
  dated.sort((a, b) => b.t - a.t);
  for (const { i, t } of dated) {
    if (t < from || t > to) continue;
    const url = canonicalUrl(i.url);
    if (!url || byUrl.has(url) || seen.urls.has(url)) continue;
    const n = perSourceCount.get(i.sourceId) ?? 0;
    if (n >= perSource) continue;
    const title = cleanText(i.title, 300);
    if (!title) continue;
    perSourceCount.set(i.sourceId, n + 1);
    byUrl.set(url, {
      id: hashId(url),
      sourceId: i.sourceId,
      title,
      url,
      summary: cleanText(i.summary, SUMMARY_CHARS),
      publishedAt: new Date(t).toISOString(),
    });
  }
  return [...byUrl.values()].slice(0, MAX_ITEMS);
}
