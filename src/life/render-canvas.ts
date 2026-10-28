/**
 * Canvas 2D fallback (`?renderer=canvas`, or no WebGL2). Zoomed out, the board is an offscreen
 * image, one pixel per cell, scaled up without smoothing. Zoomed in, each visible cell is a
 * round dot, with the same colours as the WebGL renderer but no glow.
 */
import { LIVE, TRAIL, type LifeBoard, type Rect } from './engine';
import type { Frame, LifeRenderer, Palette, RGB } from './render-gl';
import { DOT_SCALE, visible } from './view';

export const css = ([r, g, b]: RGB, a = 1) => `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export class CanvasLifeRenderer implements LifeRenderer {
  readonly kind = 'canvas' as const;
  private ctx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private image: HTMLCanvasElement;
  private imageCtx: CanvasRenderingContext2D;
  private overlay: Uint8Array | null = null;
  /** Colour per shade value, as packed RGBA for the image and CSS for dots. */
  private rgba = new Uint32Array(256);
  private fills: string[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private board: LifeBoard,
    private palette: Palette,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.image = document.createElement('canvas');
    this.image.width = board.w;
    this.image.height = board.h;
    this.imageCtx = this.image.getContext('2d')!;
    for (let v = 0; v < 256; v++) {
      const [c, a] = this.colour(v);
      const p = mix(palette.bg, c, a);
      this.rgba[v] = (255 << 24) | (Math.round(p[2] * 255) << 16) | (Math.round(p[1] * 255) << 8) | Math.round(p[0] * 255);
      this.fills[v] = css(c, a);
    }
    this.imageCtx.fillStyle = css(palette.bg);
    this.imageCtx.fillRect(0, 0, board.w, board.h);
    board.clean();
  }

  private colour(v: number): [RGB, number] {
    const p = this.palette;
    if (v >= LIVE) return [mix(p.live, p.hot, Math.max(0, Math.min(1, 1 - (v - LIVE) / 3))), 1];
    if (v > 0) return [p.trail, (v / TRAIL) * 0.55];
    return [p.bg, 0];
  }

  resize(width: number, height: number, dpr: number) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
  }

  upload(board: LifeBoard) {
    const r = board.dirty();
    board.clean();
    if (!r) return;
    const w = r.x1 - r.x0,
      h = r.y1 - r.y0;
    const img = this.imageCtx.createImageData(w, h);
    const px = new Uint32Array(img.data.buffer);
    for (let y = 0; y < h; y++) {
      const row = (r.y0 + y) * board.w + r.x0;
      for (let x = 0; x < w; x++) px[y * w + x] = this.rgba[board.shade[row + x]];
    }
    this.imageCtx.putImageData(img, r.x0, r.y0);
  }

  uploadOverlay(overlay: Uint8Array, _rect: Rect) {
    this.overlay = overlay;
  }

  draw({ camera, cursor }: Frame) {
    const { ctx, dpr, board, palette } = this;
    const W = this.width,
      H = this.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css(mix(palette.bg, palette.grid, 0.04));
    ctx.fillRect(0, 0, W, H);
    const s = camera.scale;
    const ox = W / 2 - camera.cx * s,
      oy = H / 2 - camera.cy * s;
    const v = visible(camera, W, H, board.w, board.h);
    ctx.fillStyle = css(palette.bg);
    ctx.fillRect(ox, oy, board.w * s, board.h * s);
    if (s < DOT_SCALE) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.image, v.x0, v.y0, v.x1 - v.x0, v.y1 - v.y0, ox + v.x0 * s, oy + v.y0 * s, (v.x1 - v.x0) * s, (v.y1 - v.y0) * s);
    } else {
      if (s >= DOT_SCALE * 1.6) {
        ctx.strokeStyle = css(palette.grid, 0.06);
        ctx.lineWidth = 1 / dpr;
        ctx.beginPath();
        for (let x = v.x0; x <= v.x1; x++) {
          ctx.moveTo(ox + x * s, oy + v.y0 * s);
          ctx.lineTo(ox + x * s, oy + v.y1 * s);
        }
        for (let y = v.y0; y <= v.y1; y++) {
          ctx.moveTo(ox + v.x0 * s, oy + y * s);
          ctx.lineTo(ox + v.x1 * s, oy + y * s);
        }
        ctx.stroke();
      }
      for (let y = v.y0; y < v.y1; y++) {
        const row = y * board.w;
        for (let x = v.x0; x < v.x1; x++) {
          const sh = board.shade[row + x];
          if (!sh) continue;
          ctx.fillStyle = this.fills[sh];
          const r = sh >= LIVE ? 0.36 : 0.2 + (0.16 * sh) / TRAIL;
          ctx.beginPath();
          ctx.arc(ox + (x + 0.5) * s, oy + (y + 0.5) * s, r * s, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    const ov = this.overlay;
    if (ov) {
      for (let y = v.y0; y < v.y1; y++) {
        const row = y * board.w;
        for (let x = v.x0; x < v.x1; x++) {
          const o = ov[row + x];
          if (!o) continue;
          const cx = ox + (x + 0.5) * s,
            cy = oy + (y + 0.5) * s;
          if (o === 3) {
            ctx.fillStyle = css(palette.live, 0.45);
            ctx.fillRect(cx - s * 0.4, cy - s * 0.4, s * 0.8, s * 0.8);
          } else {
            ctx.strokeStyle = css(o === 1 ? palette.hot : palette.trail, 0.8);
            ctx.lineWidth = Math.max(1, s * 0.08);
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(1, s * 0.3), 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    }
    if (cursor) {
      ctx.strokeStyle = css(palette.live);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(ox + cursor[0] * s + 1, oy + cursor[1] * s + 1, s - 2, s - 2);
    }
  }
}
