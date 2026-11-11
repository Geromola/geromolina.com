/**
 * The vector layer over the agents (SPEC "Physarum", Design language), shared by both
 * renderers. It draws:
 * - the lamp light;
 * - the Tokyo tab's map (shores and region names);
 * - the living tubes: the growing strands, then the flow model's tubes. Each is a soft ochre
 *   halo, a chrome-yellow body and a pale core, with shuttle streaming as a slow peristaltic
 *   wave of swelling and brightness;
 * - reference networks and the challenge's track in drafting ink;
 * - cut scars, oat flakes and their names;
 * - hand-drawn callouts;
 * - the pointer and keyboard cursors.
 * Canvas 2D.
 */
import { WAVE_GROUPS, flakePoints, flakeShape, placeCallout, waveGroup, waveSwell } from './figures';
import type { Growth, GrowthFrame } from './growth';
import type { Network } from './metrics';
import { DRAW_SHARE, type MeshMsg, type StateMsg } from './runner';
import type { BoardRect, RGB } from './render-gl';
import { css } from './render-canvas';
import type { Scene } from './scene';

export interface OverlayPalette {
  /** Chrome-yellow plasmodium, its ochre film and its pale core. */
  mold: RGB;
  deep: RGB;
  hot: RGB;
  /** Annotation ink (paper on the dark dish). */
  ink: RGB;
  /** Drafting ink for engineered networks. */
  draft: RGB;
  /** The agar. */
  board: RGB;
  oat: RGB;
  lamp: RGB;
}

/** A note on the board: what it points at, in board units, and its words. */
export interface CalloutNote {
  x: number;
  y: number;
  text: string;
}

export interface OverlayMap {
  /** Coast and lake shore, [x0, y0, x1, y1, …] per ring, in board units. */
  shores: number[][];
  regions: { text: string; x: number; y: number }[];
}

export interface FoodLabels {
  /** Labelled on small boards too. */
  major: boolean[];
  side: ('l' | 'r' | 't' | 'b')[];
  /** Label every food, not only the major ones. */
  all: boolean;
}

export type Tool = 'food' | 'light' | 'cut' | 'track' | 'erase';

export interface TrackFrame {
  /** Foods first, then the player's junctions. */
  net: Network;
  /** The link being drawn, and whether it can be built. */
  preview: { x0: number; y0: number; x1: number; y1: number; ok: boolean } | null;
}

export interface OverlayFrame {
  rect: BoardRect;
  scene: Scene;
  mesh: MeshMsg | null;
  state: StateMsg | null;
  /** 0 hides the tubes; 1 draws them fully; in between for the Both view. */
  tubes: number;
  /** Seconds, for the pulses; null draws them still. */
  time: number | null;
  /** Cut strokes so far, [x0, y0, x1, y1, …] in board units. */
  cuts: number[];
  /** The pointer over the board in board units, with the active tool. */
  hover: { x: number; y: number; tool: Tool; radius: number } | null;
  /** The keyboard cursor in board units. */
  cursor: { x: number; y: number } | null;
  /** A food being dragged. */
  active: number;
  contrast: boolean;
  map: OverlayMap | null;
  /** A reference network (rail, MST, Delaunay) drawn in cyan over the tubes. */
  compare: Network | null;
  labels: FoodLabels | null;
  track: TrackFrame | null;
  /** How to draw the mold's tubes; without it, the raw mesh by conductivity. */
  view: TubesView | null;
  /** Hand-drawn notes on the board, and how strongly they show (0 to 1). */
  callouts: CalloutNote[];
  calloutAlpha: number;
}

export interface TubesView {
  /** While the board grows: the strands at this moment. */
  grow: { g: Growth; frame: GrowthFrame } | null;
  /** Once the flow runs: thickness per tube (0 hides it), and smoothed positions per vertex. */
  weight: Float32Array | null;
  x: ArrayLike<number> | null;
  y: ArrayLike<number> | null;
}

const BUCKETS = 6;

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private mask: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D;
  private maskStamp = '';
  private serif: string;
  private flakes: ReturnType<typeof flakeShape>[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private palette: OverlayPalette,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.mask = document.createElement('canvas');
    this.maskCtx = this.mask.getContext('2d')!;
    this.serif = getComputedStyle(document.documentElement).getPropertyValue('--serif').trim() || 'Georgia, serif';
  }

  /**
   * Strokes living tubes: `paths[group][bucket]` holds the tubes of one streaming phase group
   * and one thickness bucket. Each bucket is a soft ochre halo, then its body (ochre when thin,
   * chrome yellow when thick), then a pale core on the thickest. `time` drives the streaming
   * wave; null holds it still.
   */
  private strokeTubes(paths: Path2D[][], unit: number, alpha: number, contrast: boolean, time: number | null): void {
    const { ctx, palette } = this;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let g = 0; g < paths.length; g++) {
      const swell = time === null ? 0.5 : waveSwell(g, time);
      for (let b = 0; b < BUCKETS; b++) {
        const w = (b + 1) / BUCKETS;
        const p = paths[g][b];
        if (contrast) {
          ctx.strokeStyle = css(palette.mold, (0.55 + 0.45 * w) * alpha);
          ctx.lineWidth = Math.max(0.8, (0.6 + 4 * w) * unit);
          ctx.stroke(p);
          continue;
        }
        const grow = 1 + 0.14 * (swell - 0.5) * w;
        ctx.strokeStyle = css(palette.deep, (0.05 + 0.1 * w) * alpha);
        ctx.lineWidth = Math.max(2, (2.4 + 9 * w) * unit * grow);
        ctx.stroke(p);
        ctx.strokeStyle = css(mix(palette.deep, palette.mold, Math.min(1, w * 1.3)), (0.3 + 0.5 * w) * (0.85 + 0.3 * swell * w) * alpha);
        ctx.lineWidth = Math.max(0.6, (0.5 + 3.8 * w) * unit * grow);
        ctx.stroke(p);
        if (w > 0.45) {
          ctx.strokeStyle = css(palette.hot, (w - 0.35) * (0.35 + 0.45 * swell) * alpha);
          ctx.lineWidth = Math.max(0.5, (0.2 + 1.1 * w) * unit);
          ctx.stroke(p);
        }
      }
    }
  }

  resize(width: number, height: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
  }

  /** Redraws the light mask's image (call after the mask changes). */
  lightChanged(scene: Scene): void {
    const m = scene.light;
    if (this.mask.width !== m.w || this.mask.height !== m.h) {
      this.mask.width = m.w;
      this.mask.height = m.h;
    }
    const img = this.maskCtx.createImageData(m.w, m.h);
    const [r, g, b] = this.palette.lamp.map((v) => Math.round(v * 255));
    for (let c = 0; c < m.data.length; c++) {
      if (!m.data[c]) continue;
      img.data.set([r, g, b, 255], c * 4);
    }
    this.maskCtx.putImageData(img, 0, 0);
    this.maskStamp = String(Math.random());
  }

  draw(f: OverlayFrame): void {
    const { ctx, dpr } = this;
    const { rect, scene } = f;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = rect.w / scene.width;
    const X = (x: number) => rect.x + x * s;
    const Y = (y: number) => rect.y + y * s;
    const unit = rect.w / 900;

    // Light: a warm lamp haze over the lit cells.
    if (this.maskStamp) {
      ctx.save();
      ctx.globalAlpha = f.contrast ? 0.32 : 0.16;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.mask, rect.x, rect.y, rect.w, rect.h);
      ctx.restore();
    }

    // The map: shores, then the names of the sea and the mountains.
    if (f.map) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();
      ctx.strokeStyle = css(this.palette.ink, f.contrast ? 0.6 : 0.24);
      ctx.lineWidth = Math.max(0.75, unit);
      ctx.lineJoin = 'round';
      for (const ring of f.map.shores) {
        ctx.beginPath();
        for (let i = 0; i < ring.length; i += 2) {
          if (i) ctx.lineTo(X(ring[i]), Y(ring[i + 1]));
          else ctx.moveTo(X(ring[i]), Y(ring[i + 1]));
        }
        ctx.closePath();
        ctx.stroke();
      }
      // Region names as on an old survey map: spaced serif italics.
      ctx.font = `italic 400 ${Math.max(10, 12 * unit)}px ${this.serif}`;
      ctx.letterSpacing = '0.08em';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = css(this.palette.ink, f.contrast ? 0.7 : 0.36);
      for (const r of f.map.regions) ctx.fillText(r.text.charAt(0) + r.text.slice(1).toLowerCase(), X(r.x), Y(r.y));
      ctx.restore();
    }

    // Growing strands: each grown stretch of tube, bucketed by thickness, with a bright tip.
    const { mesh, state } = f;
    const tv = f.view;
    const tubePaths = () => Array.from({ length: WAVE_GROUPS }, () => Array.from({ length: BUCKETS }, () => new Path2D()));
    if (mesh && tv?.grow && f.tubes > 0) {
      const { g, frame } = tv.grow;
      const paths = tubePaths();
      const tips = new Path2D();
      const halos = new Path2D();
      const tipR = Math.max(0.8, 1.2 * unit);
      const stretch = (from: number, to: number, share: number, w: number) => {
        const x1 = g.sx[from] + (g.sx[to] - g.sx[from]) * share;
        const y1 = g.sy[from] + (g.sy[to] - g.sy[from]) * share;
        const p = paths[waveGroup(g.sx[from], g.sy[from], scene.width)][Math.min(BUCKETS - 1, Math.floor(w * BUCKETS))];
        p.moveTo(X(g.sx[from]), Y(g.sy[from]));
        p.lineTo(X(x1), Y(y1));
        if (share < 1) {
          // A growing tip: a soft, glowing bud.
          tips.moveTo(X(x1) + tipR, Y(y1));
          tips.arc(X(x1), Y(y1), tipR, 0, Math.PI * 2);
          halos.moveTo(X(x1) + tipR * 3, Y(y1));
          halos.arc(X(x1), Y(y1), tipR * 3, 0, Math.PI * 2);
        }
      };
      for (let e = 0; e < mesh.ea.length; e++) {
        const w = frame.weight[e];
        if (frame.fromA[e] > 0) stretch(mesh.ea[e], mesh.eb[e], frame.fromA[e], w);
        if (frame.fromB[e] > 0) stretch(mesh.eb[e], mesh.ea[e], frame.fromB[e], w);
      }
      this.strokeTubes(paths, unit, f.tubes, f.contrast, f.time);
      if (!f.contrast) {
        ctx.fillStyle = css(this.palette.mold, 0.1 * f.tubes);
        ctx.fill(halos);
      }
      ctx.fillStyle = css(this.palette.hot, (f.contrast ? 0.9 : 0.6) * f.tubes);
      ctx.fill(tips);
    }

    // Tubes, bucketed by width so the whole mesh is a handful of strokes. The film the growth
    // did not lay shows only once the flow thickens it, so the lattice never does.
    if (mesh && state && !tv?.grow && f.tubes > 0 && state.D.length === mesh.ea.length) {
      const paths = tubePaths();
      const min = DRAW_SHARE * state.full;
      const vx = tv?.x ?? mesh.vx;
      const vy = tv?.y ?? mesh.vy;
      for (let e = 0; e < mesh.ea.length; e++) {
        const d = state.D[e];
        if (d <= min) continue;
        const w = tv?.weight ? tv.weight[e] : Math.min(1, Math.sqrt(d / state.full));
        if (w <= 0) continue;
        const b = Math.min(BUCKETS - 1, Math.floor(w * BUCKETS));
        const a = mesh.ea[e];
        const p = paths[waveGroup(vx[a], vy[a], scene.width)][b];
        p.moveTo(X(vx[a]), Y(vy[a]));
        p.lineTo(X(vx[mesh.eb[e]]), Y(vy[mesh.eb[e]]));
      }
      // Shuttle streaming is the wave of swelling that runs through the strokes.
      this.strokeTubes(paths, unit, f.tubes, f.contrast, f.time);
    }

    // A reference network to compare with, in thin drafting ink.
    if (f.compare) {
      ctx.save();
      ctx.strokeStyle = css(this.palette.draft, f.contrast ? 1 : 0.72);
      ctx.lineWidth = Math.max(0.9, 1.2 * unit);
      ctx.lineCap = 'round';
      ctx.beginPath();
      const { nodes } = f.compare;
      for (const l of f.compare.links) {
        ctx.moveTo(X(nodes[l.a].x), Y(nodes[l.a].y));
        ctx.lineTo(X(nodes[l.b].x), Y(nodes[l.b].y));
      }
      ctx.stroke();
      ctx.restore();
    }

    // The player's track, in drafting ink: links, junction rings, and the link being drawn.
    if (f.track) {
      const { net, preview } = f.track;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = css(this.palette.draft, f.contrast ? 1 : 0.92);
      ctx.lineWidth = Math.max(1.5, 2.4 * unit);
      ctx.beginPath();
      for (const l of net.links) {
        ctx.moveTo(X(net.nodes[l.a].x), Y(net.nodes[l.a].y));
        ctx.lineTo(X(net.nodes[l.b].x), Y(net.nodes[l.b].y));
      }
      ctx.stroke();
      if (preview) {
        ctx.setLineDash([5 * unit, 5 * unit]);
        ctx.strokeStyle = preview.ok ? css(this.palette.draft, 0.8) : css(this.palette.ink, 0.4);
        ctx.lineWidth = Math.max(1, 1.8 * unit);
        ctx.beginPath();
        ctx.moveTo(X(preview.x0), Y(preview.y0));
        ctx.lineTo(X(preview.x1), Y(preview.y1));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const jr = Math.max(3, 4.2 * unit);
      for (const n of net.nodes) {
        if (n.food >= 0) continue;
        ctx.beginPath();
        ctx.arc(X(n.x), Y(n.y), jr, 0, Math.PI * 2);
        ctx.fillStyle = css(this.palette.board);
        ctx.fill();
        ctx.lineWidth = Math.max(1.25, 1.8 * unit);
        ctx.strokeStyle = css(this.palette.draft);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Cut scars.
    if (f.cuts.length) {
      ctx.save();
      ctx.strokeStyle = css(this.palette.ink, 0.45);
      ctx.lineWidth = Math.max(1, 1.25 * unit);
      ctx.setLineDash([3 * unit, 4 * unit]);
      ctx.beginPath();
      for (let i = 0; i + 3 < f.cuts.length; i += 4) {
        ctx.moveTo(X(f.cuts[i]), Y(f.cuts[i + 1]));
        ctx.lineTo(X(f.cuts[i + 2]), Y(f.cuts[i + 3]));
      }
      ctx.stroke();
      ctx.restore();
    }

    // Food: oat flakes, each its own irregular shape, with the mold's warm bloom around it.
    const r = Math.max(4, 6.5 * unit);
    scene.foods.forEach((food, i) => {
      const x = X(food.x), y = Y(food.y);
      const rf = (food.weight ?? 1) > 1 ? r * 1.45 : r;
      ctx.beginPath();
      ctx.arc(x, y, rf * 2.4, 0, Math.PI * 2);
      ctx.fillStyle = css(this.palette.mold, i === f.active ? 0.26 : 0.12);
      ctx.fill();
      const shape = (this.flakes[i] ??= flakeShape(i + 1));
      const pts = flakePoints(x, y, rf * 1.15, shape);
      const n = pts.length / 2;
      ctx.beginPath();
      // A smooth closed curve through the midpoints, with the points as controls.
      ctx.moveTo((pts[0] + pts[2]) / 2, (pts[1] + pts[3]) / 2);
      for (let k = 1; k <= n; k++) {
        const c = (k % n) * 2, d = ((k + 1) % n) * 2;
        ctx.quadraticCurveTo(pts[c], pts[c + 1], (pts[c] + pts[d]) / 2, (pts[c + 1] + pts[d + 1]) / 2);
      }
      ctx.closePath();
      ctx.fillStyle = css(this.palette.oat, f.contrast ? 1 : 0.95);
      ctx.fill();
      ctx.lineWidth = Math.max(1, 1.2 * unit);
      ctx.strokeStyle = css(this.palette.deep, f.contrast ? 1 : 0.85);
      ctx.stroke();
    });

    // Food names, with a halo so they read over the tubes.
    if (f.labels) {
      const { major, side, all } = f.labels;
      ctx.save();
      ctx.font = `italic 500 ${Math.max(11, 12 * unit)}px ${this.serif}`;
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = css(this.palette.board, 0.85);
      scene.foods.forEach((food, i) => {
        if (!food.label || !(all || major[i])) return;
        const sd = side[i];
        const gap = ((food.weight ?? 1) > 1 ? 1.45 : 1) * r + 4;
        const x = X(food.x) + (sd === 'l' ? -gap : sd === 'r' ? gap : 0);
        const y = Y(food.y) + (sd === 't' ? -gap : sd === 'b' ? gap : 0);
        ctx.textAlign = sd === 'l' ? 'right' : sd === 'r' ? 'left' : 'center';
        ctx.textBaseline = sd === 't' ? 'bottom' : sd === 'b' ? 'top' : 'middle';
        ctx.fillStyle = css(this.palette.ink, major[i] ? 0.92 : 0.66);
        ctx.strokeText(food.label, x, y);
        ctx.fillText(food.label, x, y);
      });
      ctx.restore();
    }

    // Callouts: a hand-drawn leader and an italic note, like a naturalist's annotation.
    if (f.callouts.length && f.calloutAlpha > 0.01) {
      ctx.save();
      ctx.globalAlpha = f.calloutAlpha;
      ctx.font = `italic 400 ${Math.max(12, 13 * unit)}px ${this.serif}`;
      ctx.textBaseline = 'middle';
      ctx.lineCap = 'round';
      const reach = Math.max(46, 70 * unit);
      f.callouts.forEach((c, i) => {
        const k = placeCallout(X(c.x), Y(c.y), rect.x, rect.y, rect.w, rect.h, reach, i + 3);
        ctx.strokeStyle = css(this.palette.ink, 0.55);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let j = 0; j < k.leader.length; j += 2) {
          if (j) ctx.lineTo(k.leader[j], k.leader[j + 1]);
          else ctx.moveTo(k.leader[j], k.leader[j + 1]);
        }
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(k.leader[k.leader.length - 2], k.leader[k.leader.length - 1], 1.6, 0, Math.PI * 2);
        ctx.fillStyle = css(this.palette.ink, 0.7);
        ctx.fill();
        // Keep the words on the board.
        const tw = ctx.measureText(c.text).width;
        const pad = 6;
        let lx = k.lx;
        if (k.align === 'left') lx = Math.min(lx, rect.x + rect.w - pad - tw);
        else lx = Math.max(lx, rect.x + pad + tw);
        ctx.textAlign = k.align;
        ctx.lineJoin = 'round';
        ctx.lineWidth = 4;
        ctx.strokeStyle = css(this.palette.board, 0.8);
        ctx.strokeText(c.text, lx, k.ly);
        ctx.fillStyle = css(this.palette.ink, 0.88);
        ctx.fillText(c.text, lx, k.ly);
      });
      ctx.restore();
    }

    // Pointer: the brush for light, a crosshair for cuts.
    const h = f.hover;
    if (h && h.tool === 'light') {
      ctx.beginPath();
      ctx.arc(X(h.x), Y(h.y), h.radius * s, 0, Math.PI * 2);
      ctx.strokeStyle = css(this.palette.ink, 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (f.cursor) {
      const x = X(f.cursor.x), y = Y(f.cursor.y);
      ctx.strokeStyle = css(this.palette.ink, 0.9);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
      ctx.moveTo(x - r * 3.4, y);
      ctx.lineTo(x - r * 1.6, y);
      ctx.moveTo(x + r * 1.6, y);
      ctx.lineTo(x + r * 3.4, y);
      ctx.stroke();
    }
  }
}
