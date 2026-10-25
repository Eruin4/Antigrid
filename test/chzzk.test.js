import test from 'node:test';
import assert from 'node:assert/strict';
import { channelFromUrl, selectHls, resolveChannel } from '../extension/chzzk.js';

const id = 'a'.repeat(32);
const playback = JSON.stringify({ media: [{ mediaId: 'HLS', protocol: 'HLS', path: 'https://livecloud.pstatic.net/live/master.m3u8?token=private' }] });
test('channel validation does not accept lookalike hosts or arbitrary paths', () => {
  assert.equal(channelFromUrl(`https://chzzk.naver.com/live/${id}?x=1`), id);
  for (const url of [`https://chzzk.naver.com.evil.test/live/${id}`, `https://chzzk.naver.com/video/${id}`, `http://chzzk.naver.com/live/${id}`]) assert.equal(channelFromUrl(url), null);
});
test('HLS selection accepts the standard HLS rendition and refuses private/foreign URLs', () => {
  assert.equal(selectHls(playback), 'https://livecloud.pstatic.net/live/master.m3u8?token=private');
  for (const path of ['http://127.0.0.1/x', 'https://pstatic.net.evil.test/x', 'https://user:password@livecloud.pstatic.net/x']) {
    assert.throws(() => selectHls({ media: [{ mediaId: 'HLS', protocol: 'HLS', path }] }));
  }
});
test('public resolution omits cookies and refreshes rewind playback without leaking URL in errors', async () => {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push(url);
    assert.equal(options.credentials, 'omit');
    return { ok: true, json: async () => ({ code: 200, content: url.endsWith('live-detail')
      ? { status: 'OPEN', liveTitle: 'Example', livePlaybackJson: playback, timeMachineActive: true }
      : { playbackJson: playback } }) };
  };
  assert.equal((await resolveChannel(id, fetcher)).title, 'Example');
  assert.equal(requests.length, 2);
  await assert.rejects(resolveChannel(id, async () => ({ ok: true, json: async () => ({ code: 200, content: { status: 'CLOSE' } }) })), /오프라인/);
});
