// Types + helpers for the compact episode JSON written by tools/convert_lerobot.py.

export const JOINTS = [
  'shoulder_pan',
  'shoulder_lift',
  'elbow_flex',
  'wrist_flex',
  'wrist_roll',
  'gripper',
] as const;
export type JointName = (typeof JOINTS)[number];

export type JointSeries = Record<JointName, number[]>;

export interface Stream {
  /** Values exactly as stored in the LeRobot dataset (normalized or degrees). */
  recorded: JointSeries;
  /** Same samples mapped to URDF joint angles in radians (see README "Joint mapping"). */
  urdf: JointSeries;
}

export interface Episode {
  id: string;
  label: string;
  source: {
    repo_id: string;
    episode_index: number;
    robot_type: string;
    codebase_version: string;
    calibration: string;
  };
  task: string | null;
  fps: number;
  frames: number;
  timestamps: number[];
  convention: 'normalized' | 'legacy_degrees';
  units: Record<JointName, string>;
  joints: JointName[];
  state: Stream;
  action: Stream | null;
  video: string | null;
  camera: string | null;
}

export interface EpisodeIndexEntry {
  id: string;
  label: string;
  file: string;
  task: string | null;
  frames: number;
  fps: number;
  video: boolean;
}

const BASE = `${import.meta.env.BASE_URL}episodes/`;

export async function loadIndex(): Promise<EpisodeIndexEntry[]> {
  const res = await fetch(`${BASE}index.json`);
  if (!res.ok) throw new Error(`Could not load episode index (${res.status})`);
  return ((await res.json()) as { episodes: EpisodeIndexEntry[] }).episodes;
}

export async function loadEpisode(entry: EpisodeIndexEntry): Promise<Episode> {
  const res = await fetch(`${BASE}${entry.file}`);
  if (!res.ok) throw new Error(`Could not load ${entry.file} (${res.status})`);
  return (await res.json()) as Episode;
}

export function videoUrl(ep: Episode): string | null {
  return ep.video ? `${BASE}${ep.video}` : null;
}

export function duration(ep: Episode): number {
  const ts = ep.timestamps;
  return ts[ts.length - 1] + 1 / ep.fps;
}

/** Fractional frame position for time t (seconds): integer part = frame, fraction = lerp weight. */
export function framePosition(ep: Episode, t: number): number {
  const ts = ep.timestamps;
  if (t <= ts[0]) return 0;
  const last = ts.length - 1;
  if (t >= ts[last]) return last;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = ts[hi] - ts[lo];
  return lo + (span > 0 ? (t - ts[lo]) / span : 0);
}

export function sample(series: number[], pos: number): number {
  const i = Math.floor(pos);
  const f = pos - i;
  const a = series[i];
  const b = series[Math.min(i + 1, series.length - 1)];
  return a + (b - a) * f;
}
