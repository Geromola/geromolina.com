import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async ({ site }) => {
  const base = site ?? new URL('https://geromolina.com');
  // Project pages (plants) and the interactive pages (games: Ballpark, Raup's Cube, Conway's Life).
  const pages = await getCollection('nodes', (n) => n.data.kind === 'plant' || n.data.kind === 'game');
  const paths = ['/', ...pages.map((n) => n.data.href)];
  const urls = [...new Set(paths)]
    .map((p) => `  <url><loc>${new URL(p, base).href}</loc></url>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
