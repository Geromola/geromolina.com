/** What a map node is: a generating plant, the locked substation, or a page section. */
export type NodeKind = 'plant' | 'substation' | 'section';

/** One map node. Data lives in the `nodes` content collection (`src/content/nodes/*.md`). */
export interface MapNode {
  id: string;
  kind: NodeKind;
  status?: 'live' | 'code' | 'private';
  /** False keeps the node off the game map (default true). */
  inGame?: boolean;
  title: string;
  kicker: string; // small mono label above the title
  href: string;
  locked?: boolean;
  /** Normalised position on the map: landscape and portrait layouts. */
  land: [number, number];
  port: [number, number];
  order?: number;
  /** Plants only. */
  pitch?: string;
  liveUrl?: string;
  repo?: string;
  metrics?: { value: string; label: string }[];
  embed?: boolean;
}
