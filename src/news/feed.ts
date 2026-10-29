/**
 * RSS 2.0, RSS 1.0 (RDF) and Atom parsing into `FeedItem`s. Pure: XML text in, items out.
 */
import { XMLParser } from 'fast-xml-parser';
import type { FeedItem } from './types';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  // Keep the raw text: summaries are HTML and are cleaned later.
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  isArray: (name) => name === 'item' || name === 'entry' || name === 'link',
});

type Node = Record<string, unknown>;

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Text content of a node that may be a string, a number or `{ '#text': … }`. */
function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return text((v as Node)['#text']);
  return '';
}

function rssLink(item: Node): string {
  for (const l of asArray(item.link as unknown)) {
    const href = typeof l === 'object' && l ? text((l as Node)['@_href']) : text(l);
    if (href) return href;
  }
  // Some feeds only carry a permalink guid.
  const guid = item.guid as Node | string | undefined;
  const perma = typeof guid === 'object' && guid ? (guid as Node)['@_isPermaLink'] : undefined;
  const g = text(guid);
  return perma !== 'false' && /^https?:\/\//.test(g) ? g : '';
}

function atomLink(entry: Node): string {
  const links = asArray(entry.link as Node | Node[] | undefined);
  const alt = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
  return alt ? text(alt['@_href']) : '';
}

/** Parse a feed. Unknown or broken XML yields no items rather than throwing. */
export function parseFeed(xml: string, sourceId: string): FeedItem[] {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch {
    return [];
  }
  const out: FeedItem[] = [];
  const rss = doc.rss as Node | undefined;
  const rdf = doc['rdf:RDF'] as Node | undefined;
  const feed = doc.feed as Node | undefined;

  const rssItems = rss ? asArray((rss.channel as Node | undefined)?.item as Node[]) : rdf ? asArray(rdf.item as Node[]) : [];
  for (const item of rssItems) {
    out.push({
      sourceId,
      title: text(item.title),
      url: rssLink(item),
      summary: text(item.description) || text(item['content:encoded']),
      publishedAt: text(item.pubDate) || text(item['dc:date']) || null,
    });
  }
  if (feed) {
    for (const entry of asArray(feed.entry as Node[])) {
      out.push({
        sourceId,
        title: text(entry.title),
        url: atomLink(entry),
        summary: text(entry.summary) || text(entry.content),
        publishedAt: text(entry.published) || text(entry.updated) || null,
      });
    }
  }
  return out.filter((i) => i.title && i.url);
}
