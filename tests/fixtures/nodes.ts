import type { NodeSpec } from '../../src/grid/game/layout';

/** Map nodes as of the grid prototype (ids, kinds, landscape/portrait positions), in map order. */
export const NODES: NodeSpec[] = [
  { id: 'custom-llm', kind: 'plant', land: [0.56, 0.3], port: [0.28, 0.36] },
  { id: 'spotify-insight', kind: 'plant', land: [0.84, 0.22], port: [0.74, 0.47] },
  { id: 'networking-tracker', kind: 'substation', land: [0.74, 0.7], port: [0.7, 0.66] },
  { id: 'about', kind: 'section', land: [0.36, 0.62], port: [0.22, 0.58] },
  { id: 'off-the-grid', kind: 'section', land: [0.5, 0.84], port: [0.34, 0.76] },
  { id: 'contact', kind: 'section', land: [0.92, 0.86], port: [0.72, 0.84] },
];

export const LAYOUTS: [number, number][] = [
  [1440, 900],
  [800, 600],
  [390, 844],
];
