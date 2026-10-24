let video = document.querySelector('video');
const status = document.querySelector('#status');
const quality = document.querySelector('#quality');
let port, sequence = 0, hls, generation = 0, playing = false, renewing = false, retries = 0;
const pending = new Map();
function connect() {
  port = chrome.runtime.connect({ name: 'player' });
  port.onMessage.addListener(message => {
    const call = pending.get(message.requestId);
    if (!call) return;
    pending.delete(message.requestId); clearTimeout(call.timeout);
    message.ok ? call.resolve(message.result) : call.reject(new Error(message.error));
  });
  port.onDisconnect.addListener(() => {
    generation++;
    for (const call of pending.values()) { clearTimeout(call.timeout); call.reject(new Error('확장 연결이 종료되었습니다.')); }
    pending.clear(); port = null; teardown(); status.textContent = '확장 연결이 종료되었습니다. 재생을 눌러 다시 연결하세요.';
  });
}
function request(type) {
  if (!port) connect();
  return new Promise((resolve, reject) => {
    const requestId = ++sequence;
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('요청 시간이 초과되었습니다.')); }, 45000);
    pending.set(requestId, { resolve, reject, timeout });
    try { port.postMessage({ type, requestId }); }
    catch { clearTimeout(timeout); pending.delete(requestId); reject(new Error('확장 연결이 종료되었습니다.')); }
  });
}
function teardown() {
  playing = false;
  hls?.destroy(); hls = null;
  video.pause(); video.removeAttribute('src'); video.load();
  const fresh = video.cloneNode(false);
  video.replaceWith(fresh); video = fresh;
  bindVideo(fresh);
}
async function stop(label = '종료됨') {
  const current = ++generation;
  teardown();
  await request('stop').catch(() => {});
  if (current === generation) status.textContent = label;
}
async function start(isRenewal = false) {
  const current = ++generation;
  teardown();
  if (!isRenewal) retries = 0;
  status.textContent = isRenewal ? '재생 주소 갱신 중…' : '방송 연결 중…';
  try {
    const result = await request('start');
    if (current !== generation) return;
    if (!Hls.isSupported()) throw new Error('이 브라우저는 HLS 재생에 필요한 Media Source Extensions를 지원하지 않습니다.');
    const instance = hls = new Hls({ enableWorker: false, lowLatencyMode: false, backBufferLength: 15, maxBufferLength: 12 });
    instance.on(Hls.Events.MANIFEST_PARSED, async (_event, data) => {
      if (current !== generation) return;
      quality.replaceChildren(new Option('자동 화질', '-1'), ...data.levels.map((level, index) => new Option(`${level.height || '?'}p`, String(index))));
      playing = true; // A pause during buffering must stop requests before the first playing event.
      try {
        await video.play();
        if (current === generation) status.textContent = result.title;
      } catch {
        if (current === generation) await stop('재생이 허용되지 않았습니다. 재생 버튼을 눌러 다시 연결하세요.');
      }
    });
    instance.on(Hls.Events.ERROR, (_event, data) => {
      console.warn('Antigrid media error', data.type, data.details, data.response?.code || '', data.fatal);
      if (!data.fatal || current !== generation || renewing) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && retries < 2) {
        retries++; renewing = true;
        void start(true).finally(() => { renewing = false; });
      } else void stop('재생 오류가 발생했습니다. 재생을 눌러 다시 시도하세요.');
    });
    instance.loadSource(result.playbackUrl); instance.attachMedia(video);
  } catch (error) { if (current === generation) await stop(error.message); }
}
document.querySelector('#start').onclick = () => { void start(); };
document.querySelector('#stop').onclick = () => { void stop(); };
quality.onchange = () => { if (hls) hls.currentLevel = Number(quality.value); };
function bindVideo(element) {
  element.addEventListener('pause', () => { if (element === video && playing && video.paused && !video.ended) void stop('일시정지됨 · 재생을 누르면 라이브에 다시 연결합니다.'); });
  element.addEventListener('playing', () => { if (element === video) playing = true; });
  element.addEventListener('ended', () => { if (element === video) void stop('방송이 종료되었습니다.'); });
}
bindVideo(video);
window.addEventListener('pagehide', () => {
  generation++; teardown();
  try { port?.postMessage({ type: 'stop', requestId: ++sequence }); } catch { /* Idle expiry is the fallback after invalidation. */ }
  port?.disconnect();
});
setInterval(() => { if (port) void request('heartbeat').catch(() => {}); }, 5000);
connect();
