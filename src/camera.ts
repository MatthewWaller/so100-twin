// Camera pane that shows pre-extracted JPEG frames on a canvas, indexed by the
// playback clock. No <video> element, so there is no autoplay policy, seek
// latency or per-browser decoder behaviour to keep in sync with the arm.

const CONCURRENCY = 8;

export class CameraFrames {
  private ctx: CanvasRenderingContext2D;
  private images: HTMLImageElement[] = [];
  private token = 0;
  private drawn: HTMLImageElement | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Begin loading `count` frames from `${dir}/0000.jpg`…; cancels any previous episode. */
  load(dir: string, count: number): void {
    const token = ++this.token;
    this.images = new Array<HTMLImageElement>(count);
    this.drawn = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    let next = 0;
    const pump = () => {
      if (token !== this.token || next >= count) return;
      const i = next++;
      const img = new Image();
      this.images[i] = img;
      const done = () => pump();
      img.onload = done;
      img.onerror = done;
      img.src = `${dir}/${String(i).padStart(4, '0')}.jpg`;
    };
    for (let k = 0; k < CONCURRENCY; k++) pump();
  }

  /** Resolves once frame `index` has loaded (or failed), so captures never grab a stale frame. */
  whenLoaded(index: number): Promise<void> {
    const img = this.images[Math.min(Math.max(Math.round(index), 0), this.images.length - 1)];
    if (!img || img.complete) return Promise.resolve();
    return new Promise((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    });
  }

  clear(): void {
    this.token++;
    this.images = [];
    this.drawn = null;
  }

  /** Draw frame `index`, or the nearest earlier frame that has arrived. */
  show(index: number): void {
    let i = Math.min(Math.max(Math.round(index), 0), this.images.length - 1);
    let img: HTMLImageElement | undefined;
    for (; i >= 0; i--) {
      const c = this.images[i];
      if (c && c.complete && c.naturalWidth > 0) {
        img = c;
        break;
      }
    }
    if (!img || img === this.drawn) return;
    if (this.canvas.width !== img.naturalWidth || this.canvas.height !== img.naturalHeight) {
      this.canvas.width = img.naturalWidth;
      this.canvas.height = img.naturalHeight;
    }
    this.ctx.drawImage(img, 0, 0);
    this.drawn = img;
  }
}
