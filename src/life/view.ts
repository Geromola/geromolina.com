/**
 * Camera maths for the board: which cell sits under a screen point, zooming around the
 * pointer, and fitting a pattern into the part of the screen the chrome leaves free.
 * `cx`, `cy` are the cell coordinates at the centre of the canvas; `scale` is CSS px per cell.
 */
import type { Rect } from './engine';

export interface Camera {
  cx: number;
  cy: number;
  scale: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const MIN_SCALE = 0.6;
export const MAX_SCALE = 48;
/** Below this many px per cell the grid lines and round dots are not drawn. */
export const DOT_SCALE = 5;

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function screenToCell(cam: Camera, w: number, h: number, sx: number, sy: number): [number, number] {
  return [cam.cx + (sx - w / 2) / cam.scale, cam.cy + (sy - h / 2) / cam.scale];
}

export function cellToScreen(cam: Camera, w: number, h: number, x: number, y: number): [number, number] {
  return [(x - cam.cx) * cam.scale + w / 2, (y - cam.cy) * cam.scale + h / 2];
}

/** The camera at `scale` that keeps the cell under (sx, sy) where it is. */
export function zoomAt(cam: Camera, w: number, h: number, sx: number, sy: number, scale: number): Camera {
  const s = clampScale(scale);
  const [x, y] = screenToCell(cam, w, h, sx, sy);
  return { scale: s, cx: x - (sx - w / 2) / s, cy: y - (sy - h / 2) / s };
}

/** Fits a rectangle of cells (plus `room` cells around it) into the free area of the screen. */
export function fit(r: Rect, room: number, w: number, h: number, inset: Insets, maxScale = 24): Camera {
  const fw = Math.max(40, w - inset.left - inset.right);
  const fh = Math.max(40, h - inset.top - inset.bottom);
  const cw = r.x1 - r.x0 + room * 2;
  const ch = r.y1 - r.y0 + room * 2;
  const scale = clampScale(Math.min(maxScale, fw / cw, fh / ch));
  // Centre of the free area, in screen px from the canvas centre.
  const ox = (inset.left - inset.right) / 2;
  const oy = (inset.top - inset.bottom) / 2;
  return { scale, cx: (r.x0 + r.x1) / 2 - ox / scale, cy: (r.y0 + r.y1) / 2 - oy / scale };
}

/** The visible cells (clamped to the board), for the Canvas renderer. */
export function visible(cam: Camera, w: number, h: number, boardW: number, boardH: number): Rect {
  const [x0, y0] = screenToCell(cam, w, h, 0, 0);
  const [x1, y1] = screenToCell(cam, w, h, w, h);
  return {
    x0: Math.max(0, Math.floor(x0)),
    y0: Math.max(0, Math.floor(y0)),
    x1: Math.min(boardW, Math.ceil(x1) + 1),
    y1: Math.min(boardH, Math.ceil(y1) + 1),
  };
}
