import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async ({ site }) => {
  const base = site ?? new URL('https://geromolina.com');
  const plants = await getCollection('nodes', (n) => n.data.kind === 'plant');
  // Ballpark is a game page, not in the collection (src/components/NodeMenu.astro).
  const paths = ['/', ...plants.map((n) => n.data.href), '/ballpark'];
  const urls = [...new Set(paths)]
    .map((p) => `  <url><loc>${new URL(p, base).href}</loc></url>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
