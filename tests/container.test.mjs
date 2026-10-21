import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

test('production Docker image renders video and preserves it across restarts', { timeout: 240000 }, async (t) => {
  const freeDemo = process.env.HIGHLIGHT_TEST_FREE_DEMO === 'true';
  const image = process.env.HIGHLIGHT_TEST_IMAGE || 'highlight:test';
  const name = `highlight-test-${randomUUID()}`;
  const volume = `${name}-storage`;
  const docker = (...args) => execFileSync('docker', args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  t.after(() => {
    try { docker('rm', '-f', name); } catch {}
    try { docker('volume', 'rm', volume); } catch {}
  });
  docker('run', '-d', ...(freeDemo ? ['--memory', '512m', '--memory-swap', '512m', '--cpus', '0.1'] : []), '--name', name, '-p', '127.0.0.1::3000',
    '--mount', `type=volume,source=${volume},target=/app/storage`,
    '-e', `FREE_DEMO_MODE=${freeDemo}`, '-e', 'GEMINI_API_KEY=', '-e', 'ALLOW_HEURISTIC_FALLBACK=true', image);
  const port = docker('port', name, '3000/tcp').toString().trim().split(':').at(-1);
  let base = `http://127.0.0.1:${port}`;
  const waitUntilReady = async () => {
    for (let i = 0; i < 900; i++) {
      if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) return;
      await delay(100);
    }
    assert.fail(docker('logs', name).toString());
  };
  await waitUntilReady();
  assert.equal(docker('exec', name, 'id', '-u').toString().trim(), '1000');
  assert.match(docker('exec', name, '/opt/yt-dlp/bin/yt-dlp', '--version').toString(), /\d{4}\.\d{2}\.\d{2}/);
  const html = await fetch(base).then((r) => r.text());
  const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
  assert.ok(asset);
  assert.equal((await fetch(`${base}${asset}`)).status, 200);
  const status = await fetch(`${base}/api/system/status`).then((r) => r.json());
  assert.equal(status.ffmpegAvailable, true);
  assert.equal(status.ffprobeAvailable, true);
  const headers = { 'X-Client-Id': 'hc-container-test-owner-1234' };
  assert.equal(status.freeDemoMode, freeDemo);
  if (freeDemo) {
    assert.equal(status.maxUploadMB, 50);
    assert.equal(status.maxDurationSeconds, 300);
    docker('exec', name, 'ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
      'color=size=16x16:rate=1:duration=301', '-c:v', 'libx264', '-preset', 'ultrafast',
      '/app/storage/too-long.mp4');
    const invalid = new FormData();
    invalid.append('file', new Blob([docker('exec', name, 'cat', '/app/storage/too-long.mp4')], { type: 'video/mp4' }), 'too-long.mp4');
    const rejected = await fetch(`${base}/api/highlights/upload`, { method: 'POST', headers, body: invalid });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /5 minutes/);
  }

  docker('exec', name, 'ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc2=size=320x180:rate=30:duration=20', '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=20', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-c:a', 'aac', '-shortest', '/app/storage/test-input.mp4');
  const media = docker('exec', name, 'cat', '/app/storage/test-input.mp4');
  const body = new FormData();
  body.append('file', new Blob([media], { type: 'video/mp4' }), 'container-test.mp4');
  body.append('keepPercentage', '40');
  const response = await fetch(`${base}/api/highlights/upload`, { method: 'POST', headers, body });
  assert.equal(response.status, 201, await response.clone().text());
  const { job, video } = await response.json();
  let result;
  for (let i = 0; i < 900; i++) {
    result = await fetch(`${base}/api/highlights/${job.id}`, { headers }).then((r) => r.json());
    if (['complete', 'failed'].includes(result.job.status)) break;
    await delay(150);
  }
  assert.equal(result.job.status, 'complete', JSON.stringify(result));
  const rendered = `/app/storage/renders/highlight-${video.youtube_video_id}-${job.id}.mp4`;
  const probe = JSON.parse(docker('exec', name, 'ffprobe', '-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,height', '-of', 'json', rendered).toString());
  assert.ok(Math.abs(Number(probe.format.duration) - 8) < 0.5);
  assert.ok(probe.streams.some((stream) => stream.codec_type === 'audio'));
  if (freeDemo) assert.ok(probe.streams.find((stream) => stream.codec_type === 'video').height <= 480);
  const download = await fetch(`${base}/api/highlights/${job.id}/download?download=1`, { headers });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), docker('exec', name, 'cat', rendered));
  docker('restart', name);
  const restartedPort = docker('port', name, '3000/tcp').toString().trim().split(':').at(-1);
  base = `http://127.0.0.1:${restartedPort}`;
  await waitUntilReady();
  const restored = await fetch(`${base}/api/highlights/${job.id}`, { headers }).then((r) => r.json());
  assert.equal(restored.job.download_ready, true);
  assert.equal((await fetch(`${base}/api/highlights/${job.id}/download`, { headers })).status, 200);
});
