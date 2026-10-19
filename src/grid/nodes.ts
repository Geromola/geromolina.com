import type { NodeKind } from './sim';

export interface MapNode {
  id: string;
  kind: NodeKind;
  title: string;
  kicker: string; // small mono label above the title
  href: string;
  locked?: boolean;
  /** Normalised position on the map: landscape and portrait layouts. */
  land: [number, number];
  port: [number, number];
}

// Prototype data — moves to a content collection in the next build step.
export const MAP_NODES: MapNode[] = [
  {
    id: 'custom-llm',
    kind: 'plant',
    title: 'Custom LLM',
    kicker: 'Plant · live',
    href: '/projects/custom-llm',
    land: [0.56, 0.3],
    port: [0.28, 0.36],
  },
  {
    id: 'spotify-insight',
    kind: 'plant',
    title: 'Spotify Insight',
    kicker: 'Plant · live',
    href: '/projects/spotify-insight',
    land: [0.84, 0.22],
    port: [0.74, 0.47],
  },
  {
    id: 'networking-tracker',
    kind: 'substation',
    title: 'Networking Tracker',
    kicker: 'Substation · mine',
    href: 'https://networking-tracker-navy.vercel.app/',
    locked: true,
    land: [0.74, 0.7],
    port: [0.7, 0.66],
  },
  { id: 'about', kind: 'section', title: 'About', kicker: 'Node', href: '#about', land: [0.36, 0.62], port: [0.22, 0.58] },
  { id: 'off-the-grid', kind: 'section', title: 'Off the grid', kicker: 'Node', href: '#off-the-grid', land: [0.5, 0.84], port: [0.34, 0.76] },
  { id: 'contact', kind: 'section', title: 'Contact', kicker: 'Node', href: '#contact', land: [0.92, 0.86], port: [0.72, 0.84] },
];
