/**
 * Canvas 2D fallback for the agents (`?renderer=canvas`, or no float render targets): the CPU
 * AgentSim at a coarser grid, drawn as an image scaled over the board with smoothing.
 */
import { AgentSim, type AgentParams } from './agents';
import type { AgentRenderer, BoardRect, Palette, RGB } from './render-gl';

export const css = ([r, g, b]: RGB, a = 1) => `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;

export class CanvasAgentRenderer implements AgentRenderer {
  readonly kind = 'canvas' as const;
  readonly gw: number;
  readonly gh: number;
  private ctx: CanvasRenderingContext2D;
  private sim: AgentSim;
  private image: HTMLCanvasElement;
  private imageCtx: CanvasRenderingContext2D;
  private pixels: ImageData;
  /** Packed RGBA per trail level (0…255 of v / (v + k)). */
  private lut = new Uint32Array(256);
  private dpr = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    gw: number,
    gh: number,
    count: number,
    params: AgentParams,
    private palette: Palette,
  ) {
    this.gw = gw;
    this.gh = gh;
    this.ctx = canvas.getContext('2d')!;
    this.sim = new AgentSim(gw, gh, count, params);
    this.image = document.createElement('canvas');
    this.image.width = gw;
    this.image.height = gh;
    this.imageCtx = this.image.getContext('2d')!;
    this.pixels = this.imageCtx.createImageData(gw, gh);
    const { mold, deep, hot, board } = palette;
    const smooth = (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    for (let i = 0; i < 256; i++) {
      // The same ramp as the WebGL display: agar → ochre film → chrome yellow → a pale core.
      const a = i / 255;
      const d = smooth(0, 0.5, a) * 0.85;
      const m = smooth(0.32, 0.86, a);
      const h = smooth(0.82, 1, a) * 0.5;
      const c = [0, 1, 2].map((k) => {
        let v = board[k] + (deep[k] - board[k]) * d;
        v += (mold[k] - v) * m;
        return Math.round(Math.min(1, v + (hot[k] - v) * h) * 255);
      });
      this.lut[i] = (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
    }
  }

  resize(width: number, height: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
  }

  setParams(p: AgentParams): void {
    this.sim.params = p;
  }

  setLight(lit: Uint8Array): void {
    this.sim.lit = lit;
  }

  setAttract(field: Float32Array): void {
    this.sim.attract = field;
  }

  respawn(lit: Uint8Array): void {
    this.sim.lit = lit;
    this.sim.spawn();
  }

  erase(segments: number[], radius: number): void {
    const { gw, gh } = this;
    const trail = this.sim.trail;
    for (let s = 0; s + 3 < segments.length; s += 4) {
      const [x0, y0, x1, y1] = segments.slice(s, s + 4);
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
      for (let k = 0; k <= n; k++) {
        const cx = x0 + ((x1 - x0) * k) / n, cy = y0 + ((y1 - y0) * k) / n;
        for (let j = Math.max(0, Math.floor(cy - radius)); j <= Math.min(gh - 1, Math.ceil(cy + radius)); j++) {
          for (let i = Math.max(0, Math.floor(cx - radius)); i <= Math.min(gw - 1, Math.ceil(cx + radius)); i++) trail[j * gw + i] = 0;
        }
      }
    }
  }

  step(n: number): void {
    for (let i = 0; i < n; i++) this.sim.step();
  }

  draw(rect: BoardRect, mold: boolean): void {
    const { ctx, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!mold) {
      ctx.fillStyle = css(this.palette.board);
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      this.rim(rect);
      return;
    }
    const px = new Uint32Array(this.pixels.data.buffer);
    const trail = this.sim.trail;
    for (let c = 0; c < trail.length; c++) {
      const v = trail[c];
      px[c] = this.lut[Math.min(255, Math.round((v / (v + 14)) * 255))];
    }
    this.imageCtx.putImageData(this.pixels, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.image, rect.x, rect.y, rect.w, rect.h);
    this.rim(rect);
  }

  /** The dish's darker rim, as in the WebGL display. */
  private rim(rect: BoardRect): void {
    const { ctx } = this;
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const r = Math.hypot(rect.w, rect.h) / 2;
    if (!this.rimFill || this.rimKey !== `${cx},${cy},${r}`) {
      const g = ctx.createRadialGradient(cx, cy, r * 0.45, cx, cy, r * 1.05);
      g.addColorStop(0, css([0, 0, 0], 0));
      g.addColorStop(1, css([0, 0, 0], 0.38));
      this.rimFill = g;
      this.rimKey = `${cx},${cy},${r}`;
    }
    ctx.fillStyle = this.rimFill;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  private rimFill: CanvasGradient | null = null;
  private rimKey = '';
}
