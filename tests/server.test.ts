import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
function resolveTestBin(envPath: string | undefined, pkgName: string, systemBin: string): string {
  if (envPath) return envPath;
  try {
    const loaded = require(pkgName);
    const candidate = typeof loaded === 'string' ? loaded : loaded?.path;
    if (candidate && fs.existsSync(candidate)) return candidate;
  } catch {
    // fallback to system binary
  }
  return fs.existsSync(`/usr/bin/${systemBin}`) ? `/usr/bin/${systemBin}` : systemBin;
}
const ffmpeg = resolveTestBin(process.env.FFMPEG_PATH, 'ffmpeg-static', 'ffmpeg');
const ffprobe = resolveTestBin(process.env.FFPROBE_PATH, 'ffprobe-static', 'ffprobe');
const owner = 'hc-test-owner-12345678';
const stranger = 'hc-test-stranger-12345678';

test('HTTP ownership, upload validation, and real FFmpeg compilation', { timeout: 120000 }, async (t) => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'highlight-test-'));
  const input = path.join(storage, 'input.mp4');
  const silent = path.join(storage, 'silent.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '300', '-c:a', 'aac', '-shortest', input]);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', input, '-c:v', 'copy', '-an', silent]);
  // Bind an ephemeral port first so test runs can coexist.
  const { createServer } = await import('node:net');
  const portReservation = createServer();
  await new Promise<void>((resolve) => portReservation.listen(0, '127.0.0.1', resolve));
  const port = (portReservation.address() as import('node:net').AddressInfo).port;
  await new Promise<void>((resolve) => portReservation.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(storage, 'db.json'), JSON.stringify({
    videos: { 'vid-fail': { id: 'vid-fail', youtube_video_id: 'dQw4w9WgXcQ', title: 'Unavailable source', channel: 'Test', duration: 20, thumbnail: '', description: '', original_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } },
    jobs: { 'job-fail': { id: 'job-fail', video_id: 'vid-fail', owner_client_id: owner, status: 'failed', source_media_status: 'missing_source', keep_percentage: 20, created_at: new Date().toISOString() } },
    segments: {},
  }));
  const serverEntry = process.env.HIGHLIGHT_TEST_SERVER || 'server.ts';
  const serverArgs = serverEntry.endsWith('.ts') ? ['--import', 'tsx', serverEntry] : [serverEntry];
  let child = spawn(process.execPath, serverArgs, {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), STORAGE_DIR: storage, MEDIA_STORAGE_DIR: storage, GEMINI_API_KEY: '', ALLOW_HEURISTIC_FALLBACK: 'true', FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe, YT_DLP_BIN: '/nonexistent-highlight-test-yt-dlp' },
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(storage, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 300; i++) {
    if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) { ready = true; break; }
    if (child.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(ready, logs);
  if (!serverEntry.endsWith('.ts')) {
    const page = await fetch(base).then((response) => response.text());
    assert.match(page, /Highlight/);
    const asset = /src="([^"]+\.js)"/.exec(page)?.[1];
    assert.ok(asset, 'Production HTML must reference the built JavaScript');
    assert.equal((await fetch(`${base}${asset}`)).status, 200);
  }
  const request = (url: string, options: RequestInit = {}, client = owner) => fetch(`${base}${url}`, { ...options, headers: { 'X-Client-Id': client, ...options.headers } });
  assert.equal((await fetch(`${base}/api/highlights`)).status, 401);
  assert.equal((await request('/api/unknown')).status, 404);
  assert.equal((await request('/api/videos/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' })).status, 400);

  assert.equal((await request('/api/highlights/job-fail/retry', { method: 'POST' })).status, 200);
  let failedJob: any;
  for (let i = 0; i < 300; i++) {
    failedJob = await (await request('/api/highlights/job-fail')).json();
    if (failedJob.job.status === 'failed') break;
    await delay(50);
  }
  assert.equal(failedJob.job.status, 'failed');
  assert.match(failedJob.job.error, /Unable to download/);
  assert.equal(failedJob.job.download_ready, false);
  assert.equal(fs.existsSync(path.join(storage, 'fixture-keynote-300s.mp4')), false);

  const upload = async (bytes: Uint8Array, name: string, percentage: number) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes).buffer], { type: 'video/mp4' }), name);
    form.append('keepPercentage', String(percentage));
    return request('/api/highlights/upload', { method: 'POST', body: form });
  };
  assert.equal((await upload(Buffer.from('not a video'), 'bad.mp4', 20)).status, 400);
  assert.equal(fs.readdirSync(path.join(storage, 'uploads')).length, 0, fs.readdirSync(path.join(storage, 'uploads')).join(', ') + logs);

  const waitForJob = async (id: string) => {
    let details: any;
    for (let i = 0; i < 200; i++) {
      details = await (await request(`/api/highlights/${id}`)).json();
      if (['complete', 'failed'].includes(details.job.status)) break;
      await delay(150);
    }
    assert.equal(details.job.status, 'complete', JSON.stringify(details) + logs);
    return details;
  };
  let persistedJobId: string | undefined;
  for (const percentage of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]) {
    const source = percentage === 50 ? silent : input;
    const response = await upload(fs.readFileSync(source), path.basename(source), percentage);
    assert.equal(response.status, 201, await response.clone().text());
    const { job } = await response.json();
    for (const [suffix, method] of [['', 'GET'], ['/segments', 'GET'], ['/download', 'GET'], ['', 'DELETE'], ['/retry', 'POST'], ['/render', 'POST'], ['/source', 'POST'], ['/keep-percentage', 'POST']]) {
      assert.equal((await request(`/api/highlights/${job.id}${suffix}`, { method }, stranger)).status, 404, `${method} ${suffix}`);
    }
    const details = await waitForJob(job.id);
    assert.equal(details.job.analysis_mode, 'heuristic');
    assert.ok(details.job.download_ready);
    assert.equal(details.job.source_media_path, undefined);
    assert.equal((await request('/api/highlights', {}, stranger).then((r) => r.json())).items.length, 0);
    const download = await request(`/api/highlights/${job.id}/download?download=1`);
    const output = path.join(storage, `output-${percentage}.mp4`);
    fs.writeFileSync(output, Buffer.from(await download.arrayBuffer()));
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', output], { encoding: 'utf8' }));
    const actual = Number(probe.format.duration);
    assert.ok(Math.abs(actual - 20 * percentage / 100) < 0.5, `Unexpected rendered duration: ${actual}`);
    assert.ok(probe.streams.some((stream: any) => stream.codec_type === 'audio'));
    const ranged = await fetch(`${base}/api/highlights/${job.id}/download?clientId=${owner}`, { headers: { Range: 'bytes=-10' } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 10);
    assert.equal((await request(`/api/highlights/${job.id}/download`, { headers: { Range: 'bytes=999999999-' } })).status, 416);
    if (percentage === 20) {
      const change = await request(`/api/highlights/${job.id}/keep-percentage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keepPercentage: 35 }),
      });
      assert.equal(change.status, 200);
      const changed = await waitForJob(job.id);
      assert.equal(changed.job.keep_percentage, 35);
      assert.ok(Math.abs(changed.job.actual_output_duration - 7) < 0.5);
      assert.equal((await request(`/api/highlights/${job.id}/retry`, { method: 'POST' })).status, 200);
      assert.equal((await waitForJob(job.id)).job.download_ready, true);
      assert.equal((await request(`/api/highlights/${job.id}/render`, { method: 'POST' })).status, 202);
      await waitForJob(job.id);
      const replacement = new FormData();
      replacement.append('file', new Blob([fs.readFileSync(silent)], { type: 'video/mp4' }), 'replacement.mp4');
      replacement.append('rightsConfirmed', 'true');
      assert.equal((await request(`/api/highlights/${job.id}/source`, { method: 'POST', body: replacement })).status, 200);
      assert.equal((await waitForJob(job.id)).job.download_ready, true);
    }
    if (percentage === 50) { persistedJobId = job.id; continue; }
    assert.equal((await request(`/api/highlights/${job.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await request(`/api/highlights/${job.id}`)).status, 404);
  }
  // Confirm a restart preserves finished reels and the default mode does not hide missing Gemini credentials.
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  child = spawn(process.execPath, serverArgs, {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), STORAGE_DIR: storage, MEDIA_STORAGE_DIR: storage,
      GEMINI_API_KEY: '', ALLOW_HEURISTIC_FALLBACK: 'false', FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe },
  });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  ready = false;
  for (let i = 0; i < 300; i++) {
    if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) { ready = true; break; }
    if (child.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(ready, logs);
  assert.equal((await (await request(`/api/highlights/${persistedJobId}`)).json()).job.download_ready, true);
  const noAiResponse = await upload(fs.readFileSync(input), 'requires-ai.mp4', 20);
  assert.equal(noAiResponse.status, 201);
  const noAiJob = (await noAiResponse.json()).job;
  let noAiDetails: any;
  for (let i = 0; i < 200; i++) {
    noAiDetails = await (await request(`/api/highlights/${noAiJob.id}`)).json();
    if (['failed', 'complete'].includes(noAiDetails.job.status)) break;
    await delay(100);
  }
  assert.equal(noAiDetails.job.status, 'failed');
  assert.match(noAiDetails.job.error, /GEMINI_API_KEY/);
  assert.equal(noAiDetails.job.download_ready, false);
});
