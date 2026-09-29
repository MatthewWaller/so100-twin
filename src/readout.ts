import type { Episode, JointName } from './episode';

const SHORT: Record<JointName, string> = {
  shoulder_pan: 'Pan',
  shoulder_lift: 'Lift',
  elbow_flex: 'Elbow',
  wrist_flex: 'Wrist flex',
  wrist_roll: 'Wrist roll',
  gripper: 'Gripper',
};

interface Row {
  state: HTMLTableCellElement;
  cmd: HTMLTableCellElement;
  delta: HTMLTableCellElement;
  bar: HTMLElement;
}

/**
 * Per-joint table of observed state vs. commanded action at the playhead.
 * |Δ| is how far the follower lags / misses the command, in the dataset's units.
 */
export class Readout {
  private readonly body: HTMLElement;
  private readonly foot: HTMLElement;
  private rows = new Map<JointName, Row>();
  private ep?: Episode;
  private scale = 10;

  constructor(body: HTMLElement, foot: HTMLElement) {
    this.body = body;
    this.foot = foot;
  }

  setEpisode(ep: Episode): void {
    this.ep = ep;
    this.rows.clear();
    this.body.replaceChildren();
    const td = (cls = '') => {
      const c = document.createElement('td');
      c.className = cls;
      return c;
    };
    for (const j of ep.joints) {
      const tr = document.createElement('tr');
      const name = td();
      name.textContent = SHORT[j];
      const row: Row = { state: td('num state'), cmd: td('num cmd'), delta: td('num'), bar: document.createElement('i') };
      const barCell = td();
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.append(row.bar);
      barCell.append(bar);
      tr.append(name, row.state, row.cmd, row.delta, barCell);
      this.body.append(tr);
      this.rows.set(j, row);
    }

    if (!ep.action) {
      this.foot.textContent = 'No action stream in this episode.';
      return;
    }
    // Episode summary: mean absolute tracking error per joint.
    const means = ep.joints.map((j) => {
      const s = ep.state.recorded[j];
      const a = ep.action!.recorded[j];
      let sum = 0;
      for (let i = 0; i < s.length; i++) sum += Math.abs(a[i] - s[i]);
      return [j, sum / s.length] as const;
    });
    const worst = means.reduce((m, x) => (x[1] > m[1] ? x : m));
    const overall = means.reduce((acc, x) => acc + x[1], 0) / means.length;
    this.scale = Math.max(5, worst[1] * 4);
    this.foot.textContent = `Episode mean |Δ| ${overall.toFixed(2)} · largest on ${SHORT[worst[0]].toLowerCase()} (${worst[1].toFixed(2)})`;
  }

  update(pos: number): void {
    const ep = this.ep;
    if (!ep) return;
    const i = Math.round(pos);
    for (const [j, row] of this.rows) {
      const s = ep.state.recorded[j][i];
      row.state.textContent = s.toFixed(1);
      if (ep.action) {
        const a = ep.action.recorded[j][i];
        const d = Math.abs(a - s);
        row.cmd.textContent = a.toFixed(1);
        row.delta.textContent = d.toFixed(1);
        row.bar.style.width = `${Math.min(100, (d / this.scale) * 100)}%`;
      } else {
        row.cmd.textContent = '—';
        row.delta.textContent = '—';
        row.bar.style.width = '0';
      }
    }
  }
}
