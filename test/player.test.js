import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/player.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function playerHarness() {
  const messages = [];
  const instances = [];
  const listeners = {};
  const elements = { '#status': { textContent: '' }, '#quality': { replaceChildren() {} }, '#start': {}, '#stop': {} };
  class Video extends EventTarget {
    paused = true;
    ended = false;
    play() {
      this.paused = false;
      this.dispatchEvent(new Event('play'));
      return new Promise((resolve, reject) => { this.resolvePlay = resolve; this.rejectPlay = reject; });
    }
    pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
    removeAttribute() {}
    load() {}
    cloneNode() { return new Video(); }
    replaceWith(value) { elements.video = value; }
  }
  elements.video = new Video();
  class Hls {
    static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'network' };
    static isSupported = () => true;
    callbacks = {};
    constructor() { instances.push(this); }
    on(type, handler) { this.callbacks[type] = handler; }
    loadSource() {}
    attachMedia(video) { this.video = video; }
    destroy() { this.destroyed = true; }
    manifest() { return this.callbacks.manifest(null, { levels: [{ height: 1080 }] }); }
  }
  const port = {
    onMessage: { addListener(fn) { listeners.message = fn; } },
    onDisconnect: { addListener(fn) { listeners.disconnect = fn; } },
    postMessage(message) { messages.push(message); }, disconnect() { listeners.disconnect(); }
  };
  vm.runInNewContext(source, {
    document: { querySelector: key => elements[key] },
    chrome: { runtime: { connect: () => port } }, Hls,
    window: { addEventListener(type, handler) { listeners[type] = handler; } },
    Option: class {}, setInterval() {}, setTimeout() {}, clearTimeout() {}, console
  });
  const reply = (message, result) => listeners.message({ requestId: message.requestId, ok: true, result });
  const begin = async () => {
    elements['#start'].onclick();
    reply(messages.at(-1), { playbackUrl: 'http://127.0.0.1:18080/session/test/master.m3u8', title: 'Current broadcast' });
    await tick();
    return instances.at(-1);
  };
  return { elements, messages, instances, listeners, reply, begin };
}

test('pausing while the first frame is buffering destroys HLS and deletes the session', async () => {
  const h = playerHarness();
  const instance = await h.begin();
  void instance.manifest();
  instance.video.pause();
  await tick();
  assert.equal(instance.destroyed, true);
  assert.equal(h.messages.at(-1).type, 'stop');
});

test('an old play rejection cannot overwrite a newer playback status', async () => {
  const h = playerHarness();
  const old = await h.begin();
  const oldManifest = old.manifest();
  const current = await h.begin();
  const currentManifest = current.manifest();
  current.video.resolvePlay(); await currentManifest;
  assert.equal(h.elements['#status'].textContent, 'Current broadcast');
  old.video.rejectPlay(new Error('The previous media source was removed'));
  await oldManifest;
  assert.equal(h.elements['#status'].textContent, 'Current broadcast');
  assert.notEqual(current.destroyed, true);
});

test('a delayed stop response cannot overwrite a subsequent start', async () => {
  const h = playerHarness();
  await h.begin();
  h.elements['#stop'].onclick();
  const stop = h.messages.at(-1);
  const next = await h.begin();
  const manifest = next.manifest(); next.video.resolvePlay(); await manifest;
  h.reply(stop); await tick();
  assert.equal(h.elements['#status'].textContent, 'Current broadcast');
});
