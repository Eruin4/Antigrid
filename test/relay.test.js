import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRelay } from '../relay/server.js';
const execFileAsync = promisify(execFile);

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { await new Promise(resolve => server.close(resolve)); }
async function waitFor(check, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error('Condition did not become true');
}
async function setup(t, { idleMs = 500, allowPrivateUpstream = true, fixture } = {}) {
  const events = [];
  const upstream = http.createServer(fixture || ((req, res) => {
    if (req.url === '/master.m3u8') {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="a"\nvideo/index.m3u8\n');
    } else if (req.url === '/video/index.m3u8' || req.url === '/audio/index.m3u8') {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="../init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"\n#EXTINF:2,\n../segment.ts?secret=abc\n#EXT-X-ENDLIST\n');
    } else if (req.url === '/segment.ts?secret=abc') {
      res.setHeader('content-type', 'video/mp2t');
      res.end('segment bytes');
    } else if (req.url === '/init.mp4') res.end('init');
    else if (req.url === '/key.bin') res.end('key');
    else { res.writeHead(404); res.end(); }
  }));
  const upstreamBase = await listen(upstream);
  const relay = createRelay({ idleMs, cleanupMs: 20, allowPrivateUpstream,
    publicBaseUrl: 'http://127.0.0.1:0', log: (event, detail) => events.push({ event, detail }) });
  const relayBase = await listen(relay);
  t.after(async () => { await close(relay); await close(upstream); });
  const create = async (url = `${upstreamBase}/master.m3u8`, headers) => {
    const response = await fetch(`${relayBase}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ upstream_url: url, headers }) });
    return { response, body: await response.json() };
  };
  const status = async () => (await fetch(`${relayBase}/debug/status`)).json();
  return { upstreamBase, relayBase, upstream, relay, events, create, status };
}

test('master, nested media, URI attributes and relative resources are relayed', async t => {
  const env = await setup(t);
  const { response, body } = await env.create();
  assert.equal(response.status, 201);
  assert.equal((await env.status()).active_upstream_requests, 0);
  const master = await (await fetch(`${env.relayBase}/session/${body.session_id}/master.m3u8`)).text();
  assert.match(master, /#EXT-X-STREAM-INF:BANDWIDTH=5000000/);
  assert.doesNotMatch(master, /video\/index\.m3u8|audio\/index\.m3u8/);
  const urls = [...master.matchAll(/\/session\/[^\s"]+\/resource\/[^\s"]+/g)].map(x => x[0]);
  assert.equal(urls.length, 2);
  const variant = await (await fetch(`${env.relayBase}${urls[1]}`)).text();
  assert.doesNotMatch(variant, /secret=abc|\.\.\/|key\.bin|init\.mp4/);
  const segment = variant.split('\n').find(line => line.startsWith('/session/'));
  assert.equal(await (await fetch(`${env.relayBase}${segment}`)).text(), 'segment bytes');
  assert.equal((await env.status()).active_upstream_requests, 0);
});

test('session creation has no upstream traffic; direct media playlist and variables work', async t => {
  let requests = 0;
  const env = await setup(t, { fixture: (req, res) => {
    requests++;
    if (req.url === '/direct.m3u8?auth=abc') {
      res.end('#EXTM3U\n#EXT-X-DEFINE:QUERYPARAM="auth"\n#EXTINF:1,\nsegment.ts?auth={$auth}\n#EXT-X-ENDLIST\n');
    } else if (req.url === '/segment.ts?auth=abc') res.end('authorized segment');
    else { res.writeHead(404); res.end(); }
  } });
  const { body } = await env.create(`${env.upstreamBase}/direct.m3u8?auth=abc`);
  assert.equal(requests, 0);
  const playlistResponse = await fetch(`${env.relayBase}/session/${body.session_id}/master.m3u8`);
  assert.equal(playlistResponse.status, 200);
  const playlist = await playlistResponse.text();
  assert.equal(requests, 1);
  assert.doesNotMatch(playlist, /auth=abc|\{\$auth\}/);
  const segment = playlist.split('\n').find(line => line.startsWith('/session/'));
  assert.equal(await (await fetch(`${env.relayBase}${segment}`)).text(), 'authorized segment');
});

test('session URL cannot be used as an arbitrary proxy, and private targets are denied by default', async t => {
  const env = await setup(t);
  const { body } = await env.create();
  const bad = await fetch(`${env.relayBase}/session/${body.session_id}/proxy?url=http://127.0.0.1/`);
  assert.equal(bad.status, 404);
  const unknown = await fetch(`${env.relayBase}/session/${body.session_id}/resource/unknown`);
  assert.equal(unknown.status, 404);
  const denied = createRelay({ log: () => {} });
  const base = await listen(denied);
  t.after(() => close(denied));
  const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upstream_url: `${env.upstreamBase}/master.m3u8` }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'Upstream target resolves to a blocked address');
});

test('client disconnect cancels upstream transfer and counters return to zero', async t => {
  let upstreamClosed = false;
  const env = await setup(t, { fixture: (req, res) => {
    if (req.url === '/master.m3u8') { res.end('#EXTM3U\n#EXTINF:2,\nslow.ts\n'); return; }
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    const timer = setInterval(() => res.write(Buffer.alloc(8192)), 10);
    res.on('close', () => { clearInterval(timer); upstreamClosed = true; });
  } });
  const { body } = await env.create();
  const playlist = await (await fetch(`${env.relayBase}/session/${body.session_id}/master.m3u8`)).text();
  const segment = playlist.split('\n').find(line => line.startsWith('/session/'));
  const controller = new AbortController();
  const response = await fetch(`${env.relayBase}${segment}`, { signal: controller.signal });
  await response.body.getReader().read();
  assert.equal((await env.status()).active_upstream_requests, 1);
  controller.abort();
  await waitFor(async () => upstreamClosed && (await env.status()).active_upstream_requests === 0 &&
    (await env.status()).active_downstream_requests === 0);
  assert.ok(env.events.some(e => e.event === 'downstream_disconnected'));
});

test('DELETE cancels an active transfer; idle cleanup removes abandoned sessions', async t => {
  let upstreamClosed = false;
  const env = await setup(t, { idleMs: 120, fixture: (req, res) => {
    if (req.url === '/master.m3u8') { res.end('#EXTM3U\n#EXTINF:2,\nslow.ts\n'); return; }
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    const timer = setInterval(() => res.write(Buffer.alloc(8192)), 10);
    res.on('close', () => { clearInterval(timer); upstreamClosed = true; });
  } });
  const { body } = await env.create();
  const playlist = await (await fetch(`${env.relayBase}/session/${body.session_id}/master.m3u8`)).text();
  const segment = playlist.split('\n').find(line => line.startsWith('/session/'));
  const response = await fetch(`${env.relayBase}${segment}`);
  await response.body.getReader().read();
  assert.equal((await fetch(`${env.relayBase}/api/session/${body.session_id}`, { method: 'DELETE' })).status, 204);
  await waitFor(async () => upstreamClosed && (await env.status()).active_upstream_requests === 0 &&
    (await env.status()).active_downstream_requests === 0);
  assert.equal((await env.status()).active_sessions, 0);
  await env.create();
  await waitFor(async () => (await env.status()).active_sessions === 0);
  assert.ok(env.events.some(e => e.event === 'session_timeout'));
});

test('killing a playback process cancels its upstream transfer', async t => {
  let upstreamClosed = false;
  let writes = 0;
  const env = await setup(t, { idleMs: 150, fixture: (req, res) => {
    if (req.url === '/master.m3u8') { res.end('#EXTM3U\n#EXTINF:2,\nslow.ts\n'); return; }
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    const timer = setInterval(() => { writes++; res.write(Buffer.alloc(8192)); }, 10);
    res.on('close', () => { clearInterval(timer); upstreamClosed = true; });
  } });
  const { body } = await env.create();
  const playlist = await (await fetch(`${env.relayBase}/session/${body.session_id}/master.m3u8`)).text();
  const segment = playlist.split('\n').find(line => line.startsWith('/session/'));
  const child = spawn(process.execPath, ['-e', 'fetch(process.argv[1]).then(async r => { for await (const _ of r.body) {} })', `${env.relayBase}${segment}`],
    { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await waitFor(async () => (await env.status()).active_upstream_requests === 1);
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  await waitFor(async () => upstreamClosed && (await env.status()).active_upstream_requests === 0 &&
    (await env.status()).active_downstream_requests === 0);
  const stoppedWrites = writes;
  await delay(60);
  assert.equal(writes, stoppedWrites);
  await waitFor(async () => (await env.status()).active_sessions === 0);
});

test('resource limits and upstream header policy apply', async t => {
  const env = await setup(t, { fixture: (req, res) => {
    if (req.url === '/master.m3u8') { res.end('#EXTM3U\n#EXTINF:1,\nsegment.ts\n'); return; }
    if (req.headers.range === 'bytes=2-4') { res.writeHead(206, { 'content-range': 'bytes 2-4/6' }); res.end('cde'); return; }
    res.end('abcdef');
  } });
  const invalid = await env.create(undefined, { Cookie: 'secret' });
  assert.equal(invalid.response.status, 400);
  const { body } = await env.create();
  const playlist = await (await fetch(`${env.relayBase}/session/${body.session_id}/master.m3u8`)).text();
  const segment = playlist.split('\n').find(line => line.startsWith('/session/'));
  const range = await fetch(`${env.relayBase}${segment}`, { headers: { Range: 'bytes=2-4' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 2-4/6');
  assert.equal(await range.text(), 'cde');
});

test('extensionless nested playlists remain manifests across redirects', async t => {
  const env = await setup(t, { fixture: (req, res) => {
    if (req.url === '/master.m3u8') {
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvariant\n');
    } else if (req.url === '/variant') {
      res.writeHead(302, { location: '/redirected' }); res.end();
    } else if (req.url === '/redirected') {
      res.setHeader('content-type', 'application/octet-stream');
      res.end('#EXTM3U\n#EXTINF:2,\nsegment.ts?auth=secret\n');
    } else if (req.url === '/segment.ts?auth=secret') res.end('segment');
    else { res.writeHead(404); res.end(); }
  } });
  const { body } = await env.create();
  const master = await (await fetch(`${env.relayBase}/session/${body.session_id}/master.m3u8`)).text();
  const variantUrl = master.split('\n').find(line => line.startsWith('/session/'));
  const variant = await (await fetch(`${env.relayBase}${variantUrl}`)).text();
  assert.doesNotMatch(variant, /auth=secret/);
  const segmentUrl = variant.split('\n').find(line => line.startsWith('/session/'));
  assert.equal(await (await fetch(`${env.relayBase}${segmentUrl}`)).text(), 'segment');
});

test('private and IPv4-mapped targets are blocked', async () => {
  const { resolveTarget } = await import('../relay/security.js');
  for (const url of ['http://127.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/', 'http://192.0.0.8/']) {
    await assert.rejects(resolveTarget(url), /blocked address/);
  }
});

test('authorization query values and upstream paths are absent from logs', async t => {
  const env = await setup(t);
  const secret = 'sensitive-playback-token';
  const { body } = await env.create(`${env.upstreamBase}/missing.m3u8?hdnts=${secret}`);
  await fetch(`${env.relayBase}/session/${body.session_id}/master.m3u8`);
  assert.doesNotMatch(JSON.stringify(env.events), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(env.events), /missing\.m3u8/);
  assert.match(JSON.stringify(env.events), /\?\[redacted\]/);
});

test('ffprobe and ffmpeg consume a real relayed HLS stream', async t => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0 || spawnSync('ffprobe', ['-version']).status !== 0) {
    t.skip('ffmpeg and ffprobe are unavailable'); return;
  }
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'antigrid-hls-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const segmentPath = path.join(folder, 'segment.ts');
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=5',
    '-t', '2', '-c:v', 'mpeg2video', '-f', 'mpegts', '-y', segmentPath], { timeout: 15_000 });
  assert.equal(generated.status, 0, generated.stderr.toString());
  const env = await setup(t, { fixture: async (req, res) => {
    if (req.url === '/master.m3u8') { res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvideo/index.m3u8\n'); return; }
    if (req.url === '/video/index.m3u8') { res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n../segment.ts\n#EXT-X-ENDLIST\n'); return; }
    if (req.url === '/segment.ts') { res.setHeader('content-type', 'video/mp2t'); res.end(await fs.readFile(segmentPath)); return; }
    res.writeHead(404); res.end();
  } });
  const { body } = await env.create();
  const url = `${env.relayBase}/session/${body.session_id}/master.m3u8`;
  const probe = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'default=nw=1', url], { timeout: 15_000 });
  assert.match(probe.stdout, /codec_name=mpeg2video/);
  await execFileAsync('ffmpeg', ['-v', 'error', '-i', url, '-t', '1', '-f', 'null', '-'], { timeout: 15_000 });
  await waitFor(async () => (await env.status()).active_upstream_requests === 0);
});
