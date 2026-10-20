import { computeLattice, placeNodes, type Lattice } from '../layout';
import type { MapNode } from '../nodes';
import type { Bounds } from './board';

/**
 * Adapter from the map layout (`../layout.ts`) to the game: snaps nodes to
 * vertices exactly as the renderer does, and keeps their ids.
 */

export type GameNodeKind = 'plant' | 'substation' | 'section';

export interface GameNode {
  id: string;
  kind: GameNodeKind;
  col: number;
  row: number;
}

/** The node fields the layout needs. */
export interface NodeSpec {
  id: string;
  kind: GameNodeKind;
  land: [number, number];
  port: [number, number];
}

export interface GameLayout {
  lattice: Lattice;
  nodes: GameNode[];
  /** Vertices inside the visible area (where transformers may go). */
  bounds: Bounds;
}

/** Vertices whose pixel position lies inside the width × height area. */
export function visibleBounds(lat: Lattice, width: number, height: number): Bounds {
  return {
    minC: Math.max(0, Math.ceil(-lat.ox / lat.spacing)),
    maxC: Math.min(lat.cols - 1, Math.floor((width - lat.ox) / lat.spacing)),
    minR: Math.max(0, Math.ceil(-lat.oy / lat.spacing)),
    maxR: Math.min(lat.rows - 1, Math.floor((height - lat.oy) / lat.spacing)),
  };
}

/** Lay out the map for a viewport. Portrait when taller than wide, as in `main.ts`. */
export function layoutGame(nodes: readonly NodeSpec[], width: number, height: number): GameLayout {
  const lattice = computeLattice(width, height);
  // placeNodes only reads kind, land and port.
  const placed = placeNodes(nodes as unknown as MapNode[], lattice, width, height, height > width);
  return {
    lattice,
    nodes: placed.map((p, i) => ({ id: nodes[i].id, kind: nodes[i].kind, col: p.col, row: p.row })),
    bounds: visibleBounds(lattice, width, height),
  };
}
