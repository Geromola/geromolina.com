/**
 * The edition file's schema (`src/content/news/YYYY-MM-DD.json`), shared by the pipeline (which
 * validates before writing) and the `news` content collection (which validates at build).
 */
import { z } from 'astro/zod';
import { SECTIONS } from './types';

const section = z.enum(SECTIONS);
const httpUrl = z.url({ protocol: /^https?$/ });

export const entrySchema = z.object({
  id: z.string(),
  section,
  /** English title (translated for Spanish-language sources). */
  title: z.string(),
  /** The outlet's own title, when it was translated. */
  originalTitle: z.string().optional(),
  lang: z.enum(['en', 'es']),
  source: z.string(),
  url: httpUrl,
  publishedAt: z.string(),
  snippet: z.string(),
  brief: z.string().nullable(),
  basis: z.enum(['article', 'summaries']),
  why: z.string(),
  eventKey: z.string(),
  alsoCovered: z.array(z.object({ source: z.string(), url: httpUrl })),
});

export const editionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: z.string(),
  /** True when the scores picked the edition (the editor failed) or most feeds failed. */
  degraded: z.boolean(),
  mustKnow: z.array(entrySchema),
  sections: z.object({ cleantech: z.array(entrySchema), ai: z.array(entrySchema), world: z.array(entrySchema) }),
  /** The run's audit trail. */
  meta: z.object({
    feeds: z.object({ ok: z.number(), failed: z.array(z.string()) }),
    counts: z.object({
      fetched: z.number(),
      fresh: z.number(),
      classified: z.number(),
      kept: z.number(),
      stories: z.number(),
      candidates: z.number(),
      picked: z.number(),
      briefs: z.number(),
    }),
    models: z.object({ classifier: z.string(), editor: z.string(), briefer: z.string() }),
    editor: z.enum(['claude', 'fallback']),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() }),
    notes: z.array(z.string()),
  }),
});

export type Entry = z.infer<typeof entrySchema>;
export type Edition = z.infer<typeof editionSchema>;
