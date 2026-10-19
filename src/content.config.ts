import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const unit = z.number().min(0).max(1);
const point = z.tuple([unit, unit]);

const nodes = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/nodes' }),
  schema: z.object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    kind: z.enum(['plant', 'substation', 'section']),
    title: z.string(),
    kicker: z.string(),
    href: z.string(),
    locked: z.boolean().default(false),
    land: point,
    port: point,
    order: z.number(),
    // Plants only.
    pitch: z.string().optional(),
    liveUrl: z.url().optional(),
    repo: z.url().optional(),
    metrics: z
      .array(z.object({ value: z.string(), label: z.string() }))
      .length(3)
      .optional(),
    embed: z.boolean().optional(),
  }),
});

export const collections = { nodes };
