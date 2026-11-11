/**
 * The shared Physarum scene (SPEC "Physarum"): the board, the food sources and the light mask.
 * Both models read it: the flow model measures the network, the agents draw it. DOM-free.
 *
 * Coordinates are board units: x in [0, width], y in [0, height], y down.
 */

export interface Food {
  x: number;
  y: number;
  /** How often this food is picked as source or sink (Tero et al. made Tokyo seven sources). */
  weight?: number;
  label?: string;
}

/** Light the mold avoids, one byte per cell over the board (0 dark, anything else lit). */
export interface LightMask {
  w: number;
  h: number;
  data: Uint8Array;
}

export interface Scene {
  width: number;
  height: number;
  foods: Food[];
  light: LightMask;
  /** The food the mold is set down on, when it grows from one place (else from every food). */
  origin?: number;
}

export function emptyMask(w: number, h: number): LightMask {
  return { w, h, data: new Uint8Array(w * h) };
}

export function emptyScene(width = 1, height = 0.625, maskW = 256): Scene {
  const maskH = Math.round((maskW * height) / width);
  return { width, height, foods: [], light: emptyMask(maskW, maskH) };
}

/** Whether the board point (x, y) is lit. Off the board counts as lit (the mold stays on it). */
export function isLit(scene: Scene, x: number, y: number): boolean {
  const m = scene.light;
  const i = Math.floor((x / scene.width) * m.w);
  const j = Math.floor((y / scene.height) * m.h);
  if (i < 0 || j < 0 || i >= m.w || j >= m.h) return true;
  return m.data[j * m.w + i] !== 0;
}

/** Lights (value 1) or darkens (value 0) a disc of the mask, in board units. */
export function paintLight(scene: Scene, x: number, y: number, r: number, value: 0 | 1): void {
  const m = scene.light;
  const sx = m.w / scene.width;
  const sy = m.h / scene.height;
  const i0 = Math.max(0, Math.floor((x - r) * sx));
  const i1 = Math.min(m.w - 1, Math.ceil((x + r) * sx));
  const j0 = Math.max(0, Math.floor((y - r) * sy));
  const j1 = Math.min(m.h - 1, Math.ceil((y + r) * sy));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) / sx - x;
      const dy = (j + 0.5) / sy - y;
      if (dx * dx + dy * dy <= r * r) m.data[j * m.w + i] = value;
    }
  }
}

/** Lights every mask cell whose centre lies inside the polygon (board units, even-odd rule). */
export function lightPolygon(scene: Scene, poly: readonly (readonly [number, number])[]): void {
  const m = scene.light;
  for (let j = 0; j < m.h; j++) {
    const y = ((j + 0.5) / m.h) * scene.height;
    for (let i = 0; i < m.w; i++) {
      const x = ((i + 0.5) / m.w) * scene.width;
      if (inPolygon(poly, x, y)) m.data[j * m.w + i] = 1;
    }
  }
}

export type Pt = readonly [number, number];
/** x0, y0, x1, y1. */
export type Rect = readonly [number, number, number, number];

/**
 * A scene from a landscape layout (1 × 0.625 board units): foods, lit rectangles and lit
 * polygons, transposed onto the board when it is portrait (width < height).
 */
export function layout(width: number, height: number, maskW: number, foods: readonly Pt[], walls: readonly Rect[] = [], polys: readonly (readonly Pt[])[] = []): Scene {
  const s = emptyScene(width, height, maskW);
  const portrait = height > width;
  const at = ([x, y]: Pt): [number, number] => (portrait ? [y, x] : [x, y]);
  s.foods = foods.map((p): Food => {
    const [x, y] = at(p);
    return { x, y };
  });
  for (const [x0, y0, x1, y1] of walls) lightPolygon(s, [at([x0, y0]), at([x1, y0]), at([x1, y1]), at([x0, y1])]);
  for (const poly of polys) lightPolygon(s, poly.map(at));
  return s;
}

export function inPolygon(poly: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a];
    const [xb, yb] = poly[b];
    if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

/** A light mask as run lengths (base 36, dot-separated), starting with a dark run. */
export function encodeMask(m: LightMask): string {
  const runs: number[] = [];
  let cur = 0;
  let n = 0;
  for (let c = 0; c < m.data.length; c++) {
    const v = m.data[c] ? 1 : 0;
    if (v === cur) n++;
    else {
      runs.push(n);
      cur = v;
      n = 1;
    }
  }
  runs.push(n);
  return runs.map((r) => r.toString(36)).join('.');
}

/** Fills `m` from encodeMask's runs; returns false (and leaves m dark) if they don't fit it. */
export function decodeMask(text: string, m: LightMask): boolean {
  m.data.fill(0);
  let c = 0;
  let v = 0;
  for (const part of text.split('.')) {
    const n = parseInt(part, 36);
    if (!Number.isFinite(n) || n < 0 || c + n > m.data.length) {
      m.data.fill(0);
      return false;
    }
    if (v) m.data.fill(1, c, c + n);
    c += n;
    v ^= 1;
  }
  if (c !== m.data.length) {
    m.data.fill(0);
    return false;
  }
  return true;
}

export const MAX_FOODS = 40;

/** Sandbox state for the URL hash: `n=x,y;x,y&l=<mask>&i=<I₀>&o=p` (o=p for a portrait board). */
export function sceneToHash(scene: Scene, i0: number): string {
  const p = new URLSearchParams();
  if (scene.foods.length) p.set('n', scene.foods.map((f) => `${f.x.toFixed(3)},${f.y.toFixed(3)}`).join(';'));
  if (scene.light.data.some((v) => v)) p.set('l', encodeMask(scene.light));
  p.set('i', String(Math.round(i0 * 100) / 100));
  if (scene.height > scene.width) p.set('o', 'p');
  return p.toString().replace(/%2C/g, ',').replace(/%3B/g, ';');
}

/** The scene and I₀ from a hash written by sceneToHash, or null when it holds no scene. */
export function sceneFromHash(hash: string, maskW = 256): { scene: Scene; i0: number | null } | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  if (!p.has('n') && !p.has('l')) return null;
  const portrait = p.get('o') === 'p';
  const scene = portrait ? emptyScene(0.625, 1, Math.round(maskW * 0.625)) : emptyScene(1, 0.625, maskW);
  for (const pair of (p.get('n') ?? '').split(';').slice(0, MAX_FOODS)) {
    const [x, y] = pair.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= scene.width && y <= scene.height) scene.foods.push({ x, y });
  }
  const l = p.get('l');
  if (l) decodeMask(l, scene.light);
  const i = Number(p.get('i'));
  return { scene, i0: Number.isFinite(i) && i > 0 ? i : null };
}
