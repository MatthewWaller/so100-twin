#!/usr/bin/env node
// Capture README screenshots / GIF frames from a running build using headless Chrome + CDP.
// No npm deps: uses Node's built-in fetch and WebSocket.
//
//   npm run build && npx vite preview --port 4173 &
//   node tools/capture.mjs shot  "http://localhost:4173/?ep=<id>" 8.0 docs/screenshot.png [t2 out2 ...]
//   node tools/capture.mjs gif   "http://localhost:4173/?ep=<id>" docs/demo.gif [fps=10] [start] [end]
//
// WebGL runs on SwiftShader (software), so this works without a GPU.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const [mode, url, ...rest] = process.argv.slice(2);
if (!mode || !url) {
  console.error('usage: capture.mjs shot|gif <url> ...');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'so100-capture-'));
const chrome = spawn(
  CHROME,
  [
    '--headless',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1400,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome still starting */
    }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

const ws = new WebSocket(await connect());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const shoot = async (path) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(data, 'base64'));
};

try {
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const u = new URL(url);
  u.searchParams.set('paused', '1');
  await send('Page.navigate', { url: u.toString() });
  const t0 = Date.now();
  for (let i = 0; ; i++) {
    if (await evaluate(`document.body?.dataset.ready === 'true'`).catch(() => false)) break;
    if (i > 300) throw new Error('App never became ready (check the console)');
    await sleep(100);
  }
  if (process.env.DEBUG) console.log(`ready after ${Date.now() - t0} ms`);

  if (mode === 'shot') {
    // Pairs of <seconds> <out.png>, captured in one browser session.
    const pairs = rest.length ? rest : ['0', 'docs/screenshot.png'];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      await evaluate(`window.__twin.seek(${Number(pairs[i])})`);
      await sleep(400);
      await shoot(pairs[i + 1]);
      console.log(`wrote ${pairs[i + 1]}`);
    }
  } else if (mode === 'gif') {
    const [out = 'docs/demo.gif', fpsArg = '10', startArg, endArg] = rest;
    const fps = Number(fpsArg);
    const dur = await evaluate('window.__twin.duration()');
    const start = startArg ? Number(startArg) : 0;
    const end = endArg ? Number(endArg) : dur;
    const dir = mkdtempSync(join(tmpdir(), 'so100-frames-'));
    let n = 0;
    for (let t = start; t < end; t += 1 / fps) {
      await evaluate(`window.__twin.seek(${t.toFixed(4)})`);
      await sleep(30);
      await shoot(join(dir, `f${String(n++).padStart(4, '0')}.png`));
    }
    const width = process.env.GIF_WIDTH ?? '900';
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(dir, 'f%04d.png'),
      '-vf', `scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
      out,
    ]);
    rmSync(dir, { recursive: true, force: true });
    console.log(`wrote ${out} (${n} frames)`);
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
} finally {
  ws.close();
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await Promise.race([exited, sleep(3000)]);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Chrome may still hold files briefly; the OS temp dir cleans up eventually. */
  }
}
