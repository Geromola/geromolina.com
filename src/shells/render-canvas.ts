/**
 * Canvas 2D fallback, drawn the way Raup's 1962 computer plots were: the generating curve
 * repeated along the spiral. Each ring is filled with the background so nearer rings hide
 * farther ones (painter's order), and the growing edge is amber.
 */
import { COLS, ROWS, SEG_V, IDENTITY, MIRROR_Y, multiply, transform, type ShellMesh } from './mesh';
import type { Frame, Palette, RGB, ShellRenderer } from './render-gl';

export const css = ([r, g, b]: RGB, a = 1) => `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;

interface Ring {
  u: number;
  depth: number;
  pts: Float32Array; // x, y in css px
}

export class CanvasShellRenderer implements ShellRenderer {
  readonly kind = 'canvas' as const;
  private ctx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private mesh: ShellMesh | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private palette: Palette & { bg: RGB },
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(width: number, height: number, dpr: number) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
  }

  upload(mesh: ShellMesh) {
    this.mesh = mesh;
  }

  draw({ camera, grow, edge, paired }: Frame) {
    const { ctx, mesh, palette, width, height, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!mesh) return;

    // About 18 rings per turn (the WebGL growth-line spacing), 40 to 140 in all.
    const rings = Math.min(140, Math.max(40, mesh.whorls * 18));
    const step = Math.max(1, Math.floor((ROWS - 1) / rings));
    const last = Math.floor(grow * (ROWS - 1));
    const list: Ring[] = [];
    const vp = multiply(camera.proj, camera.view);
    for (const model of paired ? [IDENTITY, MIRROR_Y] : [IDENTITY]) {
      const mvp = multiply(vp, model);
      for (let i = last; i >= 0; i -= step) {
        const pts = new Float32Array(SEG_V * 2);
        let depth = 0;
        for (let j = 0; j < SEG_V; j++) {
          const k = (i * COLS + j) * 3;
          const [x, y, , w] = transform(mvp, mesh.positions[k], mesh.positions[k + 1], mesh.positions[k + 2]);
          pts[j * 2] = (x / w * 0.5 + 0.5) * width;
          pts[j * 2 + 1] = (0.5 - y / w * 0.5) * height;
          depth += w;
        }
        list.push({ u: i / (ROWS - 1), depth: depth / SEG_V, pts });
      }
    }
    list.sort((a, b) => b.depth - a.depth);

    const fill = css(palette.bg, 0.92);
    ctx.lineJoin = 'round';
    for (const ring of list) {
      const front = grow - ring.u < Math.max(edge, step / (ROWS - 1));
      ctx.beginPath();
      ctx.moveTo(ring.pts[0], ring.pts[1]);
      for (let j = 1; j < SEG_V; j++) ctx.lineTo(ring.pts[j * 2], ring.pts[j * 2 + 1]);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = front ? 1.6 : 1;
      ctx.strokeStyle = front ? css(palette.edge, 0.95) : css(palette.line, 0.25 + 0.6 * ring.u);
      ctx.stroke();
    }
  }
}
