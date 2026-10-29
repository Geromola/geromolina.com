/**
 * Article text for the brief, and the robots.txt check before fetching it. Pure: HTML or
 * robots.txt text in, an answer out.
 */
import { cleanText } from './normalize';

export const ARTICLE_WORDS = 1500;
/** Fewer words than this is a paywall or a teaser: use the cluster's summaries instead. */
export const MIN_ARTICLE_WORDS = 120;
const MIN_PARAGRAPH_CHARS = 40;

/** The paragraphs of the page's `<article>` (or of the whole page), as plain text. */
export function articleText(html: string, maxWords = ARTICLE_WORDS): string {
  const stripped = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|figure|form)\b[\s\S]*?<\/\1>/gi, ' ');
  const article = stripped.match(/<article\b[\s\S]*<\/article>/i)?.[0] ?? stripped;
  const paragraphs = [...article.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => cleanText(m[1]))
    .filter((p) => p.length >= MIN_PARAGRAPH_CHARS);
  const out: string[] = [];
  let count = 0;
  for (const p of paragraphs) {
    const w = p.split(' ');
    if (count + w.length > maxWords) {
      out.push(w.slice(0, maxWords - count).join(' '));
      break;
    }
    out.push(p);
    count += w.length;
  }
  return out.join('\n\n');
}

export const wordCount = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

/**
 * Whether robots.txt lets `agent` fetch `path`: the group naming the agent, else `*`; the
 * longest matching Allow/Disallow rule wins, Allow on a tie. Supports `*` and `$` in rules.
 */
export function robotsAllows(robots: string, path: string, agent: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const name = agent.toLowerCase();
  const group = groups.find((g) => g.agents.some((a) => a !== '*' && name.includes(a))) ?? groups.find((g) => g.agents.includes('*'));
  if (!group) return true;
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of group.rules) {
    const re = new RegExp(
      `^${rule.pattern
        .replace(/[.+?^{}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\\\$$|\$$/, '$')}`,
    );
    if (!re.test(path)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
  }
  return best ? best.allow : true;
}
