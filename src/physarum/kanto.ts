/**
 * A stylized Kanto for the Tokyo tab (SPEC "Physarum"), after Tero et al. (2010): cities around
 * Tokyo as food, and the sea, lakes and mountains as light the mold avoids. DOM-free.
 *
 * Positions are rounded real longitudes and latitudes, nudged where a city sits on the coast so
 * that it stays on land. The coastline is a sketch, and the rail graph is a sketch of the main
 * lines as straight links between the cities. The page says so: the comparison is illustrative.
 *
 * The map is projected (equirectangular, x scaled by cos 35.7°) and fitted to whichever board the
 * page has, landscape or portrait, so the same cities show with more or less sea around them.
 */
import { dist, type Network } from './metrics';
import { emptyScene, inPolygon, type Scene } from './scene';

type LonLat = readonly [number, number];
export type LabelSide = 'l' | 'r' | 't' | 'b';

export interface City {
  name: string;
  lon: number;
  lat: number;
  /** Tero et al. made Tokyo seven food sources. */
  weight?: number;
  /** Labelled on small boards too. */
  major?: boolean;
  /** Where its label sits: left, right (the default), top or bottom. */
  label?: LabelSide;
}

export const CITIES: readonly City[] = [
  { name: 'Tokyo', lon: 139.767, lat: 35.681, weight: 7, major: true },
  { name: 'Kawasaki', lon: 139.697, lat: 35.531 },
  { name: 'Yokohama', lon: 139.622, lat: 35.466, major: true, label: 'l' },
  { name: 'Yokosuka', lon: 139.655, lat: 35.28 },
  { name: 'Kamakura', lon: 139.55, lat: 35.319, label: 'b' },
  { name: 'Fujisawa', lon: 139.488, lat: 35.339, label: 't' },
  { name: 'Hiratsuka', lon: 139.35, lat: 35.328, label: 'l' },
  { name: 'Odawara', lon: 139.155, lat: 35.256, major: true, label: 'b' },
  { name: 'Atsugi', lon: 139.364, lat: 35.44, label: 'l' },
  { name: 'Machida', lon: 139.446, lat: 35.542 },
  { name: 'Sagamihara', lon: 139.345, lat: 35.595, label: 'l' },
  { name: 'Hachioji', lon: 139.339, lat: 35.656, major: true, label: 'l' },
  { name: 'Tachikawa', lon: 139.414, lat: 35.698 },
  { name: 'Ome', lon: 139.257, lat: 35.788, label: 'l' },
  { name: 'Tokorozawa', lon: 139.469, lat: 35.799 },
  { name: 'Hanno', lon: 139.327, lat: 35.851, label: 'l' },
  { name: 'Kawagoe', lon: 139.486, lat: 35.909, label: 't' },
  { name: 'Higashimatsuyama', lon: 139.4, lat: 36.042, label: 'l' },
  { name: 'Kumagaya', lon: 139.388, lat: 36.14 },
  { name: 'Omiya', lon: 139.624, lat: 35.906, major: true },
  { name: 'Kuki', lon: 139.665, lat: 36.065 },
  { name: 'Kasukabe', lon: 139.752, lat: 35.979 },
  { name: 'Koshigaya', lon: 139.79, lat: 35.891 },
  { name: 'Matsudo', lon: 139.9, lat: 35.784, label: 'l' },
  { name: 'Kashiwa', lon: 139.971, lat: 35.862 },
  { name: 'Funabashi', lon: 139.985, lat: 35.702 },
  { name: 'Chiba', lon: 140.123, lat: 35.613, major: true },
  { name: 'Ichihara', lon: 140.115, lat: 35.5 },
  { name: 'Kisarazu', lon: 139.93, lat: 35.385 },
  { name: 'Mobara', lon: 140.288, lat: 35.428 },
  { name: 'Togane', lon: 140.366, lat: 35.559 },
  { name: 'Sakura', lon: 140.224, lat: 35.723 },
  { name: 'Narita', lon: 140.318, lat: 35.776, major: true },
  { name: 'Tsukuba', lon: 140.112, lat: 36.083, major: true },
];

/**
 * The main lines, as links between neighbouring cities (several lines share some links). Some
 * parallel and secondary lines are left out, so the sketch is not denser than the real network.
 */
export const RAIL: readonly (readonly [string, string])[] = [
  // Tokaido, and the Yokosuka line through Kamakura.
  ['Tokyo', 'Kawasaki'], ['Kawasaki', 'Yokohama'], ['Yokohama', 'Fujisawa'], ['Fujisawa', 'Hiratsuka'], ['Hiratsuka', 'Odawara'],
  ['Yokohama', 'Kamakura'], ['Kamakura', 'Yokosuka'], ['Kamakura', 'Fujisawa'],
  // Odakyu, the Yokohama line and the Sagami line.
  ['Tokyo', 'Machida'], ['Machida', 'Atsugi'], ['Atsugi', 'Odawara'],
  ['Yokohama', 'Machida'], ['Machida', 'Sagamihara'], ['Sagamihara', 'Hachioji'],
  ['Sagamihara', 'Atsugi'], ['Atsugi', 'Hiratsuka'],
  // Chuo, Ome, Hachiko and Kawagoe lines.
  ['Tokyo', 'Tachikawa'], ['Tachikawa', 'Hachioji'], ['Tachikawa', 'Ome'],
  ['Hachioji', 'Hanno'], ['Hanno', 'Kawagoe'], ['Kawagoe', 'Omiya'],
  // Seibu and Tobu Tojo.
  ['Tokyo', 'Tokorozawa'], ['Tokorozawa', 'Hanno'],
  ['Tokyo', 'Kawagoe'], ['Kawagoe', 'Higashimatsuyama'], ['Higashimatsuyama', 'Kumagaya'],
  // Musashino, the outer ring.
  ['Tachikawa', 'Tokorozawa'], ['Tokorozawa', 'Omiya'], ['Omiya', 'Koshigaya'], ['Koshigaya', 'Matsudo'], ['Matsudo', 'Funabashi'],
  // North: Takasaki, Utsunomiya, Tobu Skytree and Urban Park lines.
  ['Tokyo', 'Omiya'], ['Omiya', 'Kumagaya'], ['Omiya', 'Kuki'],
  ['Tokyo', 'Koshigaya'], ['Koshigaya', 'Kasukabe'], ['Kasukabe', 'Kuki'],
  ['Kasukabe', 'Kashiwa'], ['Kashiwa', 'Funabashi'],
  // Joban, Tsukuba Express and the Narita line.
  ['Tokyo', 'Matsudo'], ['Matsudo', 'Kashiwa'], ['Kashiwa', 'Tsukuba'], ['Kashiwa', 'Narita'],
  // Sobu, Uchibo, Sotobo and Togane lines.
  ['Tokyo', 'Funabashi'], ['Funabashi', 'Chiba'], ['Chiba', 'Sakura'], ['Sakura', 'Narita'],
  ['Chiba', 'Ichihara'], ['Ichihara', 'Kisarazu'], ['Chiba', 'Mobara'], ['Mobara', 'Togane'], ['Togane', 'Sakura'],
];

/** The Pacific with Sagami Bay and Tokyo Bay, traced along the coast. */
const SEA: LonLat[] = [
  [138.95, 34.4], [139.0, 34.62], [139.1, 34.78], [139.13, 35.0], [139.1, 35.12], [139.15, 35.2], [139.17, 35.22],
  [139.3, 35.285], [139.4, 35.3], [139.48, 35.295], [139.55, 35.285], [139.6, 35.24], [139.62, 35.14],
  // Miura peninsula, then up the west shore of Tokyo Bay.
  [139.7, 35.18], [139.73, 35.24], [139.705, 35.3], [139.66, 35.4], [139.67, 35.44], [139.72, 35.48], [139.76, 35.52],
  [139.79, 35.58], [139.79, 35.635], [139.86, 35.645], [139.95, 35.665], [140.04, 35.625], [140.08, 35.565],
  // Down the east shore, out through the Uraga channel, round Boso.
  [140.03, 35.48], [139.95, 35.43], [139.88, 35.375], [139.83, 35.33], [139.82, 35.3], [139.84, 35.2], [139.82, 35.05],
  [139.84, 34.95], [139.88, 34.9], [140.0, 34.98], [140.12, 35.1], [140.3, 35.14], [140.41, 35.3], [140.55, 35.5],
  [140.72, 35.7], [140.87, 35.74], [140.8, 35.85], [140.7, 36.0], [140.6, 36.3], [140.62, 36.6], [140.72, 37.0],
  [141.6, 37.0], [141.6, 34.4],
];

/** Lake Kasumigaura. */
const LAKE: LonLat[] = [
  [140.18, 36.06], [140.25, 36.13], [140.36, 36.12], [140.42, 36.05], [140.48, 35.98], [140.43, 35.95], [140.33, 36.0], [140.24, 36.02],
];

/** Hakone, Tanzawa, Okutama and Chichibu to the west, then the Gunma ranges. */
const MOUNTAINS: LonLat[] = [
  [138.4, 34.4], [139.15, 34.4], [139.15, 35.17], [139.11, 35.22], [139.13, 35.3], [139.2, 35.38], [139.27, 35.47],
  [139.26, 35.56], [139.28, 35.64], [139.22, 35.76], [139.24, 35.84], [139.28, 35.9], [139.27, 36.0], [139.17, 36.1],
  [139.05, 36.25], [139.0, 36.35], [139.1, 36.5], [139.3, 36.65], [139.3, 37.0], [138.4, 37.0],
];

/** Mount Tsukuba. */
const TSUKUBA_SAN: LonLat[] = [
  [140.07, 36.21], [140.1, 36.18], [140.15, 36.19], [140.17, 36.23], [140.13, 36.27], [140.08, 36.25],
];

/** Lit areas: the sea, the lake and the mountains. */
export const LIT: readonly (readonly LonLat[])[] = [SEA, LAKE, MOUNTAINS, TSUKUBA_SAN];
/** Drawn as outlines: the coast and the lake shore. */
const SHORES: readonly (readonly LonLat[])[] = [SEA, LAKE];

const REGIONS: { text: string; at: LonLat }[] = [
  { text: 'Tokyo Bay', at: [139.89, 35.5] },
  { text: 'Sagami Bay', at: [139.4, 35.235] },
  { text: 'Pacific', at: [140.55, 35.3] },
  { text: 'Mountains', at: [139.02, 35.7] },
];

const KX = Math.cos((35.7 * Math.PI) / 180);
/** Room round the outermost cities, in degrees of latitude. */
const MARGIN = 0.07;

export interface KantoMap {
  scene: Scene;
  /** The stylized rail network between the foods (node i is food i). */
  rail: Network;
  /** Coast and lake shore in board units, [x0, y0, x1, y1, …] per ring. */
  shores: number[][];
  /** Sea and mountain names in board units. */
  regions: { text: string; x: number; y: number }[];
  /** Projects a longitude and latitude onto the board. */
  project(lon: number, lat: number): [number, number];
}

/** The Kanto scene fitted to a width × height board, with the light mask maskW cells across. */
export function kanto(width = 1, height = 0.625, maskW = 256): KantoMap {
  const us = CITIES.map((c) => c.lon * KX);
  const vs = CITIES.map((c) => -c.lat);
  const u0 = Math.min(...us) - MARGIN, u1 = Math.max(...us) + MARGIN;
  const v0 = Math.min(...vs) - MARGIN, v1 = Math.max(...vs) + MARGIN;
  const s = Math.min(width / (u1 - u0), height / (v1 - v0));
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  const project = (lon: number, lat: number): [number, number] => [(lon * KX - uc) * s + width / 2, (-lat - vc) * s + height / 2];
  const unproject = (x: number, y: number): [number, number] => [((x - width / 2) / s + uc) / KX, -((y - height / 2) / s + vc)];

  const scene = emptyScene(width, height, maskW);
  const m = scene.light;
  for (let j = 0; j < m.h; j++) {
    for (let i = 0; i < m.w; i++) {
      const [lon, lat] = unproject(((i + 0.5) / m.w) * width, ((j + 0.5) / m.h) * height);
      if (LIT.some((p) => inPolygon(p, lon, lat))) m.data[j * m.w + i] = 1;
    }
  }
  scene.foods = CITIES.map((c) => {
    const [x, y] = project(c.lon, c.lat);
    return { x, y, label: c.name, ...(c.weight ? { weight: c.weight } : {}) };
  });

  const index = new Map(CITIES.map((c, i) => [c.name, i]));
  // As in the experiment, the mold is set down on Tokyo and spreads from there.
  scene.origin = index.get('Tokyo');
  const rail: Network = {
    nodes: scene.foods.map((f, i) => ({ x: f.x, y: f.y, food: i })),
    links: RAIL.map(([a, b]) => {
      const ia = index.get(a)!, ib = index.get(b)!;
      const fa = scene.foods[ia], fb = scene.foods[ib];
      return { a: ia, b: ib, length: dist(fa.x, fa.y, fb.x, fb.y) };
    }),
  };
  const shores = SHORES.map((ring) => ring.flatMap(([lon, lat]) => project(lon, lat)));
  const regions = REGIONS.map((r) => {
    const [x, y] = project(r.at[0], r.at[1]);
    return { text: r.text, x, y };
  }).filter((r) => r.x > 0.04 && r.y > 0.02 && r.x < width - 0.04 && r.y < height - 0.02);
  return { scene, rail, shores, regions, project };
}

export const isMajor = (name: string | undefined) => CITIES.some((c) => c.name === name && c.major);
export const labelSide = (name: string | undefined): LabelSide => CITIES.find((c) => c.name === name)?.label ?? 'r';
