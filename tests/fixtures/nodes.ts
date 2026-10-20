import type { NodeSpec } from '../../src/grid/game/layout';

/** Map nodes (ids, kinds, landscape/portrait positions), in map order. Mirrors `src/content/nodes/*.md`. */
export const NODES: NodeSpec[] = [
  { id: 'custom-llm', kind: 'plant', land: [0.56, 0.3], port: [0.36, 0.33] },
  { id: 'spotify-insight', kind: 'plant', land: [0.84, 0.22], port: [0.74, 0.47] },
  { id: 'networking-tracker', kind: 'substation', land: [0.74, 0.7], port: [0.7, 0.58] },
  { id: 'about', kind: 'section', land: [0.36, 0.62], port: [0.14, 0.66] },
  { id: 'off-the-grid', kind: 'section', land: [0.5, 0.84], port: [0.34, 0.76] },
  { id: 'contact', kind: 'section', land: [0.92, 0.86], port: [0.72, 0.84] },
];

export const LAYOUTS: [number, number][] = [
  [1440, 900],
  [800, 600],
  [390, 844],
];

/**
 * Sampled viewports (map size: the map is 100svh with a 560px floor), both
 * orientations: a width × height grid plus a few near-square portrait windows,
 * the hardest case for the portrait positions.
 */
export const SAMPLED_LAYOUTS: [number, number][] = [
  ...[320, 360, 390, 430, 600, 768, 900, 1024, 1280, 1440, 1680, 1920].flatMap((w) =>
    [560, 700, 844, 1024, 1200].map((h): [number, number] => [w, h]),
  ),
  [600, 640],
  [700, 760],
  [820, 900],
];
