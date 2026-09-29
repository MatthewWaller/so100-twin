import './style.css';
import {
  duration,
  framePosition,
  loadEpisode,
  loadIndex,
  sample,
  videoUrl,
  type Episode,
  type EpisodeIndexEntry,
  type JointName,
} from './episode';
import { JointPlots } from './plots';
import { Readout } from './readout';
import { TwinScene } from './scene';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const viewport = $<HTMLDivElement>('#viewport');
const picker = $<HTMLSelectElement>('#episode');
const playBtn = $<HTMLButtonElement>('#play');
const scrub = $<HTMLInputElement>('#scrub');
const timeEl = $<HTMLSpanElement>('#time');
const speedSel = $<HTMLSelectElement>('#speed');
const showState = $<HTMLInputElement>('#show-state');
const showAction = $<HTMLInputElement>('#show-action');
const video = $<HTMLVideoElement>('#video');
const videoCard = $<HTMLDivElement>('#video-card');
const meta = $<HTMLDivElement>('#meta');
const status = $<HTMLDivElement>('#status');

const params = new URLSearchParams(location.search);
const twin = new TwinScene(viewport);
const plots = new JointPlots($('#plots'));
const readout = new Readout($('#readout'), $('#readout-foot'));

let episodes: EpisodeIndexEntry[] = [];
let ep: Episode | undefined;
let t = 0;
let playing = false;
let lastTick = performance.now();

function setStatus(msg: string | null): void {
  status.textContent = msg ?? '';
  status.hidden = !msg;
}

function fmtTime(s: number): string {
  return `${s.toFixed(2).padStart(5, '0')}s`;
}

function setPlaying(p: boolean): void {
  playing = p;
  playBtn.dataset.state = p ? 'playing' : 'paused';
  playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play');
  if (video.src) {
    if (p) void video.play().catch(() => undefined);
    else video.pause();
  }
  lastTick = performance.now();
}

function seek(to: number): void {
  if (!ep) return;
  t = Math.min(Math.max(to, 0), duration(ep) - 1e-3);
  if (video.src) video.currentTime = t;
  applyFrame();
}

function applyFrame(): void {
  if (!ep) return;
  const pos = framePosition(ep, t);
  const pose = (series: Record<JointName, number[]>) =>
    Object.fromEntries(ep!.joints.map((j) => [j, sample(series[j], pos)])) as Record<JointName, number>;

  twin.setPose(twin.state, pose(ep.state.urdf));
  if (ep.action) twin.setPose(twin.ghost, pose(ep.action.urdf));
  if (twin.state) twin.state.visible = showState.checked;
  if (twin.ghost) twin.ghost.visible = !!ep.action && showAction.checked;
  twin.invalidate();

  plots.update(t, pos, !!ep.action && showAction.checked);
  readout.update(pos);
  scrub.value = String(t);
  timeEl.textContent = `${fmtTime(t)} / ${fmtTime(duration(ep))}  ·  frame ${Math.round(pos)}`;
}

async function selectEpisode(id: string): Promise<void> {
  const entry = episodes.find((e) => e.id === id) ?? episodes[0];
  if (!entry) return;
  setPlaying(false);
  setStatus('Loading episode…');
  ep = await loadEpisode(entry);
  picker.value = entry.id;

  const src = videoUrl(ep);
  videoCard.hidden = !src;
  if (src) {
    video.src = src;
    video.load();
  } else {
    video.removeAttribute('src');
  }
  showAction.disabled = !ep.action;
  $('#action-legend').classList.toggle('disabled', !ep.action);

  scrub.max = String(duration(ep));
  scrub.step = String(1 / ep.fps);
  meta.replaceChildren(
    chip('Task', ep.task ?? '—'),
    chip('Source', `${ep.source.repo_id} #${ep.source.episode_index}`),
    chip('Rate', `${ep.fps} fps · ${ep.frames} frames`),
  );
  plots.setEpisode(ep);
  readout.setEpisode(ep);
  $('#camera-name').textContent = ep.camera ?? '';
  const url = new URL(location.href);
  url.searchParams.set('ep', ep.id);
  history.replaceState(null, '', url);
  setStatus(null);
  seek(0);
}

function chip(k: string, v: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'chip';
  const key = document.createElement('b');
  key.textContent = k;
  el.append(key, document.createTextNode(v));
  return el;
}

function tick(now: number): void {
  requestAnimationFrame(tick);
  if (ep && playing) {
    const rate = Number(speedSel.value);
    const dur = duration(ep);
    // Video is the master clock while it plays at 1x-2x; otherwise use wall time.
    if (video.src && !video.paused && video.readyState >= 2 && Math.abs(video.currentTime - t) < 0.5) {
      t = video.currentTime;
    } else {
      t += ((now - lastTick) / 1000) * rate;
    }
    if (t >= dur - 1e-3) {
      t = 0;
      if (video.src) video.currentTime = 0;
    }
    applyFrame();
  }
  lastTick = now;
  twin.frame();
}

playBtn.addEventListener('click', () => setPlaying(!playing));
scrub.addEventListener('input', () => {
  seek(Number(scrub.value));
});
speedSel.addEventListener('change', () => {
  video.playbackRate = Number(speedSel.value);
});
picker.addEventListener('change', () => void selectEpisode(picker.value));
showState.addEventListener('change', applyFrame);
showAction.addEventListener('change', applyFrame);
plots.onSeek = seek;
video.addEventListener('ended', () => {
  if (playing) {
    video.currentTime = 0;
    void video.play().catch(() => undefined);
  }
});
window.addEventListener('keydown', (e) => {
  if (!ep || (e.target as HTMLElement).tagName === 'SELECT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    setPlaying(!playing);
  } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    e.preventDefault();
    setPlaying(false);
    seek(t + (e.code === 'ArrowRight' ? 1 : -1) / ep.fps * (e.shiftKey ? 10 : 1));
  }
});

async function boot(): Promise<void> {
  requestAnimationFrame(tick);
  try {
    setStatus('Loading SO-100 model…');
    const [index] = await Promise.all([loadIndex(), twin.loadRobot()]);
    episodes = index;
    picker.replaceChildren(
      ...episodes.map((e) => {
        const o = document.createElement('option');
        o.value = e.id;
        o.textContent = e.label;
        return o;
      }),
    );
    await selectEpisode(params.get('ep') ?? episodes[0]?.id ?? '');
    const t0 = params.get('t');
    if (t0) seek(Number(t0));
    if (params.get('action') === '0') showAction.checked = false;
    if (params.get('view')) twin.setView(params.get('view')!);
    applyFrame();
    if (!params.has('paused')) setPlaying(true);
    document.body.dataset.ready = 'true';
  } catch (err) {
    console.error(err);
    setStatus(err instanceof Error ? err.message : String(err));
  }
}

/** Hook used by tools/capture.mjs to render deterministic frames (screenshots / GIF). */
declare global {
  interface Window {
    __twin?: { seek(t: number): Promise<void>; duration(): number };
  }
}
window.__twin = {
  async seek(to: number) {
    setPlaying(false);
    seek(to);
    if (video.src) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        if (!video.seeking && video.readyState >= 2) return done();
        video.addEventListener('seeked', done, { once: true });
        video.addEventListener('loadeddata', done, { once: true });
        setTimeout(done, 3000);
      });
    }
    twin.render();
  },
  duration: () => (ep ? duration(ep) : 0),
};

void boot();
