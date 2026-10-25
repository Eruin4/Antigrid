import { resolveChannel } from '../extension/chzzk.js';
import { createRelay } from '../relay/server.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const channel = process.argv[2];
let resolved;
if (channel === '--stdin') {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  resolved = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} else resolved = await resolveChannel(channel);
const relay = createRelay({ log: () => {} });
await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${relay.address().port}`;
try {
  const session = await (await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upstream_url: resolved.upstreamUrl }) })).json();
  const playback = `${base}/session/${session.session_id}/master.m3u8`;
  const probe = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', playback], { timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  const streams = JSON.parse(probe.stdout).streams;
  assert.ok(streams.some(s => s.codec_type === 'audio'));
  assert.ok(streams.some(s => s.codec_type === 'video'));
  console.log('Streams', JSON.stringify(streams));
  await exec('ffmpeg', ['-v', 'error', '-i', playback, '-t', '10', '-f', 'null', '-'], { timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  await fetch(`${base}/api/session/${session.session_id}`, { method: 'DELETE' });
  const status = await (await fetch(`${base}/debug/status`)).json();
  assert.equal(status.active_sessions, 0);
  assert.equal(status.active_upstream_requests, 0);
  console.log('10 seconds of live audio/video decoded; zero sessions and upstream requests after stop.');
} catch (error) {
  // Tool stderr can contain playback capability URLs. Report only a safe diagnostic.
  console.error('Live verification failed:', error.code || error.name);
  process.exitCode = 1;
} finally { await new Promise(resolve => relay.close(resolve)); }
