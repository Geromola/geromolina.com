/**
 * The 3D cube (Canvas 2D): Raup's three axes as a box you turn by dragging, the regions where
 * real shells live as translucent boxes, the sheet where whorls stop touching, the catalog's
 * real shells as dots you can pick, and the current shell as a glowing point dropped to the
 * floor. Geometry comes from the DOM-free `morphospace.ts`; the camera from `mesh.ts`.
 */
import { CATALOG, type CatalogEntry } from './catalog';
import { IDENTITY, multiply, orbitCamera, transform, type Mat4 } from './mesh';
import { LOG_W_MAX, REGIONS, T_MAX, type ShellParams } from './model';
import { CUBE_EDGES, boxFaces, cubePoint, mapPoint, regionBox, touchSheet, type CubePoint } from './morphospace';
import { css } from './render-canvas';
import type { RGB } from './render-gl';

const CENTRE: CubePoint = [0.5, 0.5, 0.5];
// A little under the corner radius (√3/2): the cube fills the canvas, and a corner may graze the
// edge as it turns.
const RADIUS = 0.8;
const IDLE_YAW = 0.08; // rad/s
const DRAG_SLOP = 4; // px before a press counts as a drag
const PICK_RADIUS = 14; // px
const SUPERSCRIPT = '⁰¹²³⁴⁵⁶';
const SHEET = touchSheet();

export interface CubePalette {
  line: RGB;
  edge: RGB;
  base: RGB;
  muted: RGB;
  regions: Record<string, RGB>;
}

interface Projected {
  x: number;
  y: number;
  /** Distance from the eye: bigger is farther. */
  w: number;
}

export class CubeView {
  private ctx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private yaw = -0.95;
  private pitch = 0.42;
  private spin = IDLE_YAW;
  private press: { x: number; y: number; yaw: number; pitch: number; dragged: boolean } | null = null;
  private hover: CatalogEntry | null = null;
  private dots: { entry: CatalogEntry; x: number; y: number }[] = [];
  private mvp: Mat4 = IDENTITY;
  /** True while the pointer is over the cube: the idle turn waits, so dots hold still to be picked. */
  private over = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private palette: CubePalette,
    private font: string,
    private opts: { onPick: (entry: CatalogEntry) => void; onChange: () => void; reduced: () => boolean },
  ) {
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      this.press = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch, dragged: false };
      this.spin = 0;
    });
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      if (this.press) {
        const dx = e.clientX - this.press.x;
        const dy = e.clientY - this.press.y;
        if (!this.press.dragged && Math.hypot(dx, dy) > DRAG_SLOP) this.press.dragged = true;
        if (this.press.dragged) {
          this.yaw = this.press.yaw - dx * 0.009;
          this.pitch = Math.max(-0.2, Math.min(1.35, this.press.pitch + dy * 0.007));
        }
      } else {
        this.over = true;
        this.setHover(this.pick(e.clientX - r.left, e.clientY - r.top));
      }
      this.opts.onChange();
    });
    const release = (e: PointerEvent, cancelled: boolean) => {
      if (!this.press) return;
      const { dragged } = this.press;
      this.press = null;
      if (!dragged && !cancelled) {
        const r = canvas.getBoundingClientRect();
        const hit = this.pick(e.clientX - r.left, e.clientY - r.top);
        if (hit) this.opts.onPick(hit);
      }
      this.opts.onChange();
    };
    canvas.addEventListener('pointerup', (e) => release(e, false));
    canvas.addEventListener('pointercancel', (e) => release(e, true));
    canvas.addEventListener('pointerleave', () => {
      this.over = false;
      this.setHover(null);
      this.opts.onChange();
    });
  }

  private setHover(entry: CatalogEntry | null) {
    this.hover = entry;
    this.canvas.style.cursor = entry ? 'pointer' : this.press?.dragged ? 'grabbing' : 'grab';
  }

  /** The real shell nearest a canvas point, within a finger's reach. */
  private pick(x: number, y: number): CatalogEntry | null {
    let best: CatalogEntry | null = null;
    let bestD = PICK_RADIUS;
    for (const d of this.dots) {
      const dist = Math.hypot(d.x - x, d.y - y);
      if (dist < bestD) {
        bestD = dist;
        best = d.entry;
      }
    }
    return best;
  }

  resize(width: number, height: number, dpr: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Advance the idle turn; true while the cube is moving. */
  step(dt: number): boolean {
    if (this.opts.reduced() || this.press || this.over) return false;
    this.spin += (IDLE_YAW - this.spin) * (1 - Math.exp(-dt / 1.5));
    this.yaw += this.spin * dt;
    return true;
  }

  private project(p: CubePoint): Projected {
    const [x, y, , w] = transform(this.mvp, p[0], p[1], p[2]);
    return { x: (x / w * 0.5 + 0.5) * this.width, y: (0.5 - y / w * 0.5) * this.height, w };
  }

  draw(shell: ShellParams, revealed: boolean) {
    const { ctx, palette, width, height } = this;
    const dpr = this.canvas.width / width;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const cam = orbitCamera(CENTRE, RADIUS, this.yaw, this.pitch, width / height);
    this.mvp = multiply(cam.proj, cam.view);
    ctx.font = `10px ${this.font}`;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    const line = (pts: CubePoint[], stroke: string, width = 1) => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const q = this.project(p);
        if (i) ctx.lineTo(q.x, q.y);
        else ctx.moveTo(q.x, q.y);
      });
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    const label = (p: CubePoint, text: string, fill: string, align: CanvasTextAlign = 'center') => {
      const q = this.project(p);
      ctx.fillStyle = fill;
      ctx.textAlign = align;
      ctx.fillText(text, q.x, q.y);
    };

    // Floor grid (T = 0): W decades and D quarters.
    for (let e = 0; e <= LOG_W_MAX; e++) {
      const [x] = mapPoint({ W: Math.max(1.01, 10 ** e), D: 0 });
      line([[x, 0, 0], [x, 1, 0]], css(palette.base, 0.06));
    }
    for (const d of [0.25, 0.5, 0.75]) line([[0, d / 0.95, 0], [1, d / 0.95, 0]], css(palette.base, 0.06));

    // Cube edges; the three axes out of the origin corner are brighter.
    for (const [a, b] of CUBE_EDGES) {
      const axis = a.filter((v, k) => v === 0 && b[k] === 0).length === 2 && a.every((v) => v === 0);
      line([a, b], axis ? css(palette.line, 0.55) : css(palette.base, 0.14), axis ? 1.25 : 1);
    }

    // Axis ticks and names.
    const tick = css(palette.muted, 1);
    // Every other decade, so the labels don't crowd at small sizes.
    for (let e = 0; e <= LOG_W_MAX; e += 2) {
      const [x] = mapPoint({ W: Math.max(1.01, 10 ** e), D: 0 });
      label([x, -0.07, 0], e === 0 ? '1' : e === 1 ? '10' : `10${SUPERSCRIPT[e]}`, tick);
    }
    for (const d of [0, 0.5]) label([-0.06, d / 0.95, 0], String(d), tick);
    for (let t = 1; t <= T_MAX; t++) label([-0.05, -0.05, t / T_MAX], String(t), tick);
    const name = css(palette.line, 0.95);
    label([1.1, -0.06, 0], 'W', name);
    label([-0.08, 1.06, 0], 'D', name);
    label([-0.07, -0.07, 1.08], 'T', name);

    // The sheet where whorls stop touching.
    for (const l of SHEET) line(l, css(palette.edge, 0.35), 1);

    // Regions as translucent boxes, far faces first.
    if (revealed) {
      const faces: { pts: Projected[]; col: RGB; depth: number }[] = [];
      for (const r of REGIONS) {
        for (const f of boxFaces(regionBox(r))) {
          const pts = f.map((p) => this.project(p));
          faces.push({ pts, col: palette.regions[r.id], depth: pts.reduce((s, p) => s + p.w, 0) / 4 });
        }
      }
      faces.sort((a, b) => b.depth - a.depth);
      for (const f of faces) {
        ctx.beginPath();
        f.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.closePath();
        ctx.fillStyle = css(f.col, 0.07);
        ctx.fill();
        ctx.strokeStyle = css(f.col, 0.35);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      // Region names are in the legend under the canvas: in here they would pile up at low W.
    }

    // Real shells: dots you can pick (after the reveal).
    this.dots = [];
    if (revealed) {
      const dots = CATALOG.map((entry) => ({ entry, q: this.project(cubePoint(entry)) })).sort((a, b) => b.q.w - a.q.w);
      for (const { entry, q } of dots) {
        const col = palette.regions[entry.group];
        const on = this.hover === entry;
        ctx.fillStyle = css(col, on ? 1 : 0.85);
        ctx.beginPath();
        ctx.arc(q.x, q.y, on ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
        this.dots.push({ entry, x: q.x, y: q.y });
      }
      if (this.hover) {
        const q = this.project(cubePoint(this.hover));
        ctx.font = `600 12px system-ui, sans-serif`;
        ctx.fillStyle = css(palette.base, 0.95);
        ctx.textAlign = q.x > width - 140 ? 'right' : 'left';
        ctx.fillText(this.hover.name, q.x + (q.x > width - 140 ? -10 : 10), q.y - 10);
        ctx.font = `10px ${this.font}`;
      }
    }

    // The current shell, with drop lines to the floor and the two back walls.
    const c = cubePoint(shell);
    const dash = css(palette.line, 0.45);
    ctx.setLineDash([3, 4]);
    line([c, [c[0], c[1], 0]], dash);
    line([[c[0], c[1], 0], [c[0], 0, 0]], dash);
    line([[c[0], c[1], 0], [0, c[1], 0]], dash);
    ctx.setLineDash([]);
    const q = this.project(c);
    ctx.fillStyle = css(palette.line, 0.18);
    ctx.beginPath();
    ctx.arc(q.x, q.y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = css(palette.line, 1);
    ctx.beginPath();
    ctx.arc(q.x, q.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}
