import type { MapNode, NodeKind } from './nodes';

/** A node snapped to a lattice vertex. */
export interface PlacedNode {
  kind: NodeKind;
  col: number;
  row: number;
}

export interface Lattice {
  cols: number;
  rows: number;
  spacing: number; // css px between conductors
  ox: number; // css px of vertex (0, 0)
  oy: number;
}

export function computeLattice(width: number, height: number): Lattice {
  const spacing = Math.round(Math.min(96, Math.max(52, Math.min(width, height) / 8.5)));
  const cols = Math.floor(width / spacing) + 2;
  const rows = Math.floor(height / spacing) + 2;
  // Centre the lattice and let it bleed past the edges so lines run off-screen.
  const ox = Math.round((width - (cols - 1) * spacing) / 2);
  const oy = Math.round((height - (rows - 1) * spacing) / 2);
  return { cols, rows, spacing, ox, oy };
}

/** Snap each node to the nearest free lattice vertex inside the visible area. */
export function placeNodes(nodes: MapNode[], lat: Lattice, width: number, height: number, portrait: boolean): PlacedNode[] {
  const taken = new Set<string>();
  const minC = Math.ceil(-lat.ox / lat.spacing) + 1;
  const maxC = Math.floor((width - lat.ox) / lat.spacing) - 1;
  const minR = Math.ceil(-lat.oy / lat.spacing) + 1;
  const maxR = Math.floor((height - lat.oy) / lat.spacing) - 1;
  return nodes.map((node) => {
    const [nx, ny] = portrait ? node.port : node.land;
    let col = clamp(Math.round((nx * width - lat.ox) / lat.spacing), minC, maxC);
    let row = clamp(Math.round((ny * height - lat.oy) / lat.spacing), minR, maxR);
    while (taken.has(`${col},${row}`)) col = col + 1 > maxC ? minC : col + 1;
    taken.add(`${col},${row}`);
    return { kind: node.kind, col, row };
  });
}

export function toPx(lat: Lattice, col: number, row: number) {
  return { x: lat.ox + col * lat.spacing, y: lat.oy + row * lat.spacing };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
