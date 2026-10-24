export function channelFromUrl(value) {
  try {
    const u = new URL(value);
    return u.origin === 'https://chzzk.naver.com' ? u.pathname.match(/^\/live\/([a-f0-9]{32})\/?$/)?.[1] || null : null;
  } catch { return null; }
}

export function selectHls(value) {
  let playback;
  try { playback = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new Error('재생 정보 형식이 올바르지 않습니다.'); }
  const media = playback?.media?.find(m => m.protocol === 'HLS' && m.mediaId === 'HLS');
  if (!media) throw new Error('이 방송에는 사용 가능한 HLS 재생 정보가 없습니다.');
  let url;
  try { url = new URL(media.path); } catch { throw new Error('잘못된 재생 주소입니다.'); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      !['pstatic.net', 'akamaized.net', 'navercdn.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error('지원하지 않는 CHZZK 미디어 서버입니다.');
  }
  return url.href;
}

export async function resolveChannel(channel, fetcher = fetch) {
  if (!/^[a-f0-9]{32}$/.test(channel)) throw new Error('잘못된 채널 ID입니다.');
  const read = async path => {
    const response = await fetcher(`https://api.chzzk.naver.com/service/${path}`, {
      credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`CHZZK 응답 오류 (${response.status})`);
    const data = await response.json();
    if (data.code !== 200 || !data.content) throw new Error('공개 방송 정보를 가져올 수 없습니다.');
    return data.content;
  };
  const detail = await read(`v2/channels/${channel}/live-detail`);
  if (detail.status !== 'OPEN') throw new Error('방송이 종료되었거나 오프라인입니다.');
  if (!detail.livePlaybackJson) throw new Error('로그인 또는 연령 확인이 필요한 방송은 현재 지원하지 않습니다.');
  let playback = detail.livePlaybackJson;
  if (detail.timeMachineActive) {
    try { playback = (await read(`v1/channels/${channel}/live-playback-json`)).playbackJson || playback; }
    catch { /* The public live-detail HLS remains usable if rewind is unavailable. */ }
  }
  return { upstreamUrl: selectHls(playback), title: detail.liveTitle || 'CHZZK 라이브' };
}
