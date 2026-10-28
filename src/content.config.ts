import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { CATEGORY_IDS } from './grid/categories';

const unit = z.number().min(0).max(1);
const point = z.tuple([unit, unit]);

const nodes = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/nodes' }),
  schema: z
    .object({
      id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      // `game`: an interactive page (Ballpark, Raup's Cube, Conway's Life), a ▶ PLAY node in the menu.
      kind: z.enum(['plant', 'substation', 'section', 'game']),
      status: z.enum(['live', 'code', 'private']),
      inGame: z.boolean().default(true),
      title: z.string(),
      kicker: z.string(),
      href: z.string(),
      locked: z.boolean().default(false),
      land: point,
      port: point,
      // Order inside the node's category (projects and games) or among the sections.
      order: z.number(),
      // Projects and games only (SPEC "Projects menu by category"); sections have none.
      category: z.enum(CATEGORY_IDS).optional(),
      // Small chips on the menu plate, e.g. `Multi-agent`, `WebGL`, `Berkeley` (an origin is only a tag).
      tags: z.array(z.string()).default([]),
      // Plants only.
      pitch: z.string().optional(),
      liveUrl: z.url().optional(),
      repo: z.url().optional(),
      metrics: z
        .array(z.object({ value: z.string(), label: z.string() }))
        .length(3)
        .optional(),
      embed: z.boolean().optional(),
    })
    .superRefine((n, ctx) => {
      if (n.kind === 'section' ? n.category !== undefined : n.category === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['category'],
          message: n.kind === 'section' ? 'sections have no category' : `a ${n.kind} needs a category`,
        });
      }
    }),
});

export const collections = { nodes };
