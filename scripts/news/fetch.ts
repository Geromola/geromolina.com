/**
 * Network side of the news wire: feeds, and article pages after a robots.txt check. Every fetch
 * has a timeout and identifies itself.
 */
import { robotsAllows } from '../../src/news/extract';

export const USER_AGENT = 'geromolina-newswire/1.0 (+https://geromolina.com/news)';
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 3_000_000;

async function get(url: string, accept: string): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function body(res: Response): Promise<string> {
  const text = await res.text();
  return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
}

export async function fetchFeed(url: string): Promise<string> {
  const res = await get(url, 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return body(res);
}

const robotsCache = new Map<string, Promise<string>>();

/** robots.txt for an origin, fetched once per run. Missing or unreadable means no rules. */
function robotsFor(origin: string): Promise<string> {
  let cached = robotsCache.get(origin);
  if (!cached) {
    cached = get(`${origin}/robots.txt`, 'text/plain')
      .then((res) => (res.ok ? body(res) : ''))
      .catch(() => '');
    robotsCache.set(origin, cached);
  }
  return cached;
}

/** The article's HTML, or null when robots.txt forbids it, the fetch fails, or it isn't HTML. */
export async function fetchArticle(url: string): Promise<string | null> {
  const u = new URL(url);
  if (!robotsAllows(await robotsFor(u.origin), u.pathname + u.search, USER_AGENT)) return null;
  try {
    const res = await get(url, 'text/html,application/xhtml+xml');
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return null;
    return body(res);
  } catch {
    return null;
  }
}
