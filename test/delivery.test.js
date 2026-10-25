import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryUrl } from '../relay/delivery.js';
import http from 'node:http';
import { createRelay } from '../relay/server.js';
test('LL-HLS reload directives are forwarded without allowing arbitrary query substitution', () => {
  const source = 'https://cdn.example.test/index?signature=original';
  const result = new URL(deliveryUrl(source, '/master.m3u8?_HLS_msn=12&_HLS_part=3&_HLS_skip=v2&signature=attacker&url=http://localhost', true));
  assert.equal(result.searchParams.get('signature'), 'original');
  assert.equal(result.searchParams.get('_HLS_msn'), '12');
  assert.equal(result.searchParams.get('_HLS_part'), '3');
  assert.equal(result.searchParams.get('_HLS_skip'), 'v2');
  assert.equal(result.searchParams.has('url'), false);
  assert.equal(deliveryUrl(source, '/segment.ts?_HLS_msn=12', false), source);
  for (const query of ['_HLS_msn=-1', '_HLS_part=1&_HLS_part=2', '_HLS_skip=NO']) assert.throws(() => deliveryUrl(source, '/?' + query, true));
});
test('hostname upstreams work with Node automatic address-family selection', async () => {
  const upstream = http.createServer((_req, res) => { res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n'); });
  await new Promise(resolve => upstream.listen(0, resolve));
  const relay = createRelay({ allowPrivateUpstream: true, log: () => {} });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.address().port}`;
  try {
    const created = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upstream_url: `http://localhost:${upstream.address().port}/index.m3u8` }) });
    assert.equal(created.status, 201);
    const { session_id } = await created.json();
    const response = await fetch(`${base}/session/${session_id}/master.m3u8`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /\/resource\//);
  } finally {
    await new Promise(resolve => relay.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  }
});
