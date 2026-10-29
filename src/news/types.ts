/**
 * Types for the news wire (SPEC "News wire"). DOM-free: the pipeline runs in Node (the GitHub
 * Action), the page reads the editions at build time, and Vitest covers both.
 */

export const SECTIONS = ['cleantech', 'ai', 'world'] as const;
export type Section = (typeof SECTIONS)[number];
export type Lang = 'en' | 'es';

export const SECTION_LABELS: Record<Section, string> = {
  cleantech: 'Clean tech',
  ai: 'AI',
  world: 'World',
};

export interface Source {
  id: string;
  name: string;
  url: string;
  /** The section this feed usually serves. The classifier still decides. */
  hint: Section;
  /** 0.5–1.5: ranks a source when several cover one story. */
  weight: number;
  lang: Lang;
  /** Links to other sites (Hacker News): credit each item to the linked site's domain. */
  aggregator?: boolean;
}

/** One entry as parsed from a feed. */
export interface FeedItem {
  sourceId: string;
  title: string;
  url: string;
  summary: string;
  publishedAt: string | null;
}

/** A fresh, deduplicated item: canonical URL, plain-text summary, an id from the URL. */
export interface Item {
  id: string;
  sourceId: string;
  title: string;
  url: string;
  summary: string;
  publishedAt: string;
}

/** What the classifier says about one item. */
export interface Classification {
  id: string;
  category: Section | 'none';
  /** 0–10: fit with the reader's interests. */
  relevance: number;
  /** 0–10: global significance, whoever reads it. */
  importance: number;
  /** One sentence, ≤ 30 words, in the classifier's own words ('' when rejected). */
  snippet: string;
  /** English title for a non-English source, else null. */
  titleEn: string | null;
  /** Short slug naming the story, shared by every outlet that covers it. */
  eventKey: string;
}

export interface ClassifiedItem extends Item, Omit<Classification, 'id' | 'category'> {
  category: Section;
}

/** A cluster of items about one story. `items[0]` is the representative. */
export interface Story {
  id: string;
  category: Section;
  items: ClassifiedItem[];
  relevance: number;
  importance: number;
  score: number;
}

export interface Pick {
  id: string;
  /** ≤ 12 words: why it matters to the reader ('' from the fallback). */
  why: string;
}

export interface Picks {
  mustKnow: Pick[];
  sections: Record<Section, Pick[]>;
}

export type BriefBasis = 'article' | 'summaries';

export interface Brief {
  id: string;
  /** 2–3 sentences, or null when none could be written. */
  brief: string | null;
  basis: BriefBasis;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** The three Claude-backed steps, behind interfaces so tests and `--dry-run` use fakes. */
export interface Classifier {
  readonly model: string;
  classify(items: readonly Item[], sources: ReadonlyMap<string, Source>): Promise<{ results: Classification[]; usage: Usage }>;
}

export interface EditorInput {
  candidates: readonly Story[];
  sources: ReadonlyMap<string, Source>;
  previousTitles: readonly string[];
  now: Date;
}

export interface Editor {
  readonly model: string;
  edit(input: EditorInput): Promise<{ picks: Picks; usage: Usage }>;
}

export interface BriefInput {
  story: Story;
  sourceName: string;
  /** The article's text, or the cluster's summaries when the page couldn't be read. */
  text: string;
  basis: BriefBasis;
  /** On the retry after a draft copied its source: the words it reused. */
  copied: string | null;
}

export interface Briefer {
  readonly model: string;
  brief(input: BriefInput): Promise<{ brief: string | null; usage: Usage }>;
}
