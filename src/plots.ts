import type { Episode, JointName } from './episode';
import { duration } from './episode';

const STATE_COLOR = '#f2b632';
const ACTION_COLOR = '#38bdf8';
const GRID = 'rgba(148, 163, 184, 0.10)';
const AXIS_TEXT = 'rgba(148, 163, 184, 0.75)';

const PRETTY: Record<JointName, string> = {
  shoulder_pan: 'Shoulder pan',
  shoulder_lift: 'Shoulder lift',
  elbow_flex: 'Elbow flex',
  wrist_flex: 'Wrist flex',
  wrist_roll: 'Wrist roll',
  gripper: 'Gripper',
};

/**
 * One small canvas chart per joint. Traces are rasterised once into an offscreen
 * canvas per resize; each animation frame only blits that and draws the playhead.
 */
export class JointPlots {
  private readonly root: HTMLElement;
  private cards: PlotCard[] = [];
  private ep?: Episode;
  private last?: [number, number, boolean];
  onSeek?: (t: number) => void;

  constructor(root: HTMLElement) {
    this.root = root;
    new ResizeObserver(() => {
      this.cards.forEach((c) => c.layout());
      if (this.last) this.update(...this.last);
    }).observe(root);
  }

  setEpisode(ep: Episode): void {
    this.ep = ep;
    this.root.replaceChildren();
    this.cards = ep.joints.map((j) => new PlotCard(this.root, ep, j, (t) => this.onSeek?.(t)));
  }

  update(t: number, pos: number, showAction: boolean): void {
    if (!this.ep) return;
    this.last = [t, pos, showAction];
    for (const c of this.cards) c.draw(t, pos, showAction);
  }
}

class PlotCard {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly valueEl: HTMLElement;
  private readonly ep: Episode;
  private readonly state: number[];
  private readonly action: number[] | null;
  private readonly lo: number;
  private readonly hi: number;
  private readonly dur: number;
  private cacheWithAction?: HTMLCanvasElement;
  private cacheStateOnly?: HTMLCanvasElement;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private readonly pad = { l: 34, r: 8, t: 6, b: 16 };

  constructor(parent: HTMLElement, ep: Episode, joint: JointName, seek: (t: number) => void) {
    this.ep = ep;
    this.state = ep.state.recorded[joint];
    this.action = ep.action ? ep.action.recorded[joint] : null;
    this.dur = duration(ep);

    let lo = Infinity;
    let hi = -Infinity;
    for (const s of [this.state, this.action ?? []]) {
      for (const v of s) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const padV = Math.max((hi - lo) * 0.12, 1);
    this.lo = lo - padV;
    this.hi = hi + padV;

    const card = document.createElement('div');
    card.className = 'plot-card';
    const head = document.createElement('div');
    head.className = 'plot-head';
    const title = document.createElement('span');
    title.className = 'plot-title';
    title.textContent = PRETTY[joint];
    const unit = document.createElement('span');
    unit.className = 'plot-unit';
    unit.textContent = ep.units[joint];
    this.valueEl = document.createElement('span');
    this.valueEl.className = 'plot-value';
    head.append(title, unit, this.valueEl);
    this.canvas = document.createElement('canvas');
    card.append(head, this.canvas);
    parent.append(card);
    this.ctx = this.canvas.getContext('2d')!;

    const seekFromEvent = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      const x = (e.clientX - r.left - this.pad.l) / (r.width - this.pad.l - this.pad.r);
      seek(Math.min(Math.max(x, 0), 1) * this.dur);
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.canvas.hasPointerCapture(e.pointerId)) seekFromEvent(e);
    });
    this.layout();
  }

  layout(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.cacheWithAction = this.rasterise(true);
    this.cacheStateOnly = this.rasterise(false);
  }

  private x(t: number): number {
    return this.pad.l + (t / this.dur) * (this.w - this.pad.l - this.pad.r);
  }

  private y(v: number): number {
    return this.pad.t + (1 - (v - this.lo) / (this.hi - this.lo)) * (this.h - this.pad.t - this.pad.b);
  }

  private rasterise(withAction: boolean): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d')!;
    g.scale(this.dpr, this.dpr);

    // Grid + y ticks
    g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    const ticks = niceTicks(this.lo, this.hi, 3);
    for (const v of ticks) {
      const y = Math.round(this.y(v)) + 0.5;
      g.strokeStyle = GRID;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(this.pad.l, y);
      g.lineTo(this.w - this.pad.r, y);
      g.stroke();
      g.fillStyle = AXIS_TEXT;
      g.fillText(fmt(v), this.pad.l - 5, y);
    }
    // x ticks (seconds)
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    const step = this.dur > 20 ? 5 : 2;
    for (let s = 0; s <= this.dur; s += step) {
      g.fillStyle = AXIS_TEXT;
      g.fillText(`${s}s`, this.x(s), this.h - 3);
    }

    const ts = this.ep.timestamps;
    const line = (series: number[], color: string, width: number, dash: number[]) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.setLineDash(dash);
      g.lineJoin = 'round';
      g.beginPath();
      for (let i = 0; i < series.length; i++) {
        const px = this.x(ts[i]);
        const py = this.y(series[i]);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
      g.setLineDash([]);
    };
    if (withAction && this.action) line(this.action, ACTION_COLOR, 1.25, [4, 3]);
    line(this.state, STATE_COLOR, 1.6, []);
    return c;
  }

  draw(t: number, pos: number, showAction: boolean): void {
    const g = this.ctx;
    const cache = showAction ? this.cacheWithAction : this.cacheStateOnly;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (cache) g.drawImage(cache, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const x = this.x(t);
    g.strokeStyle = 'rgba(241, 245, 249, 0.85)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, this.pad.t);
    g.lineTo(x, this.h - this.pad.b);
    g.stroke();

    const i = Math.round(pos);
    const s = this.state[i];
    g.fillStyle = STATE_COLOR;
    g.beginPath();
    g.arc(x, this.y(s), 3, 0, Math.PI * 2);
    g.fill();
    let text = fmt(s);
    if (showAction && this.action) {
      const a = this.action[i];
      g.fillStyle = ACTION_COLOR;
      g.beginPath();
      g.arc(x, this.y(a), 2.5, 0, Math.PI * 2);
      g.fill();
      text += `  cmd ${fmt(a)}`;
    }
    this.valueEl.textContent = text;
  }
}

function fmt(v: number): string {
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1);
}

function niceTicks(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
