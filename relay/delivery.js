// Only HLS delivery directives may be forwarded from an untrusted playback URL.
export function deliveryUrl(upstreamUrl, requestUrl, playlist) {
  const query = new URL(requestUrl, 'http://localhost').searchParams;
  const target = new URL(upstreamUrl);
  if (!playlist) return target.href;
  for (const name of ['_HLS_msn', '_HLS_part', '_HLS_skip']) {
    const values = query.getAll(name);
    if (!values.length) continue;
    if (values.length !== 1 || !(name === '_HLS_skip' ? /^(YES|v2)$/ : /^\d{1,12}$/).test(values[0])) throw new Error('Invalid HLS delivery directive');
    target.searchParams.set(name, values[0]);
  }
  return target.href;
}
