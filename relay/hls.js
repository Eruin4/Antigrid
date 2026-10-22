const URI_ATTRIBUTE = /\bURI="([^"]*)"/g;

export function isManifest(url, contentType = '') {
  return new URL(url).pathname.toLowerCase().endsWith('.m3u8') ||
    /(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(contentType);
}

export function rewriteManifest(text, baseUrl, register, inherited = {}) {
  text = text.replace(/^\uFEFF/, '');
  if (!text.trimStart().startsWith('#EXTM3U')) {
    throw new Error('Upstream response is not an HLS manifest');
  }
  const variables = { ...inherited };
  const expand = value => value.replace(/\{\$([^}]+)\}/g, (_, name) => {
    if (!(name in variables)) throw new Error(`Undefined HLS variable: ${name}`);
    return variables[name];
  });
  const replaceUrl = (value, hint) => register(new URL(expand(value), baseUrl).href, { ...variables }, hint);
  let nextUriHint = 'media';
  return text.split(/(\r?\n)/).map(part => {
    if (part === '\n' || part === '\r\n' || !part.trim()) return part;
    if (part.startsWith('#')) {
      if (part.startsWith('#EXT-X-DEFINE:')) {
        const get = name => part.match(new RegExp(`(?:^|[:,])${name}="([^"]*)"`))?.[1];
        const name = get('NAME');
        const value = get('VALUE');
        const query = get('QUERYPARAM');
        const imported = get('IMPORT');
        if (name && value !== undefined) variables[name] = expand(value);
        else if (query) {
          const selected = new URL(baseUrl).searchParams.get(query);
          if (selected === null) throw new Error(`Missing HLS query parameter: ${query}`);
          variables[query] = selected;
        } else if (imported && !(imported in variables)) throw new Error(`Undefined imported HLS variable: ${imported}`);
      }
      const hint = /^#EXT-X-(?:MEDIA:|I-FRAME-STREAM-INF:|RENDITION-REPORT:)/.test(part) ? 'playlist' :
        /^#EXT-X-(?:KEY:|SESSION-KEY:)/.test(part) ? 'key' : 'media';
      const rewritten = part.replace(URI_ATTRIBUTE, (_, value) => `URI="${replaceUrl(value, hint)}"`);
      if (part.startsWith('#EXT-X-STREAM-INF:')) nextUriHint = 'playlist';
      return rewritten;
    }
    const leading = part.match(/^\s*/)[0];
    const trailing = part.match(/\s*$/)[0];
    const rewritten = `${leading}${replaceUrl(part.trim(), nextUriHint)}${trailing}`;
    nextUriHint = 'media';
    return rewritten;
  }).join('');
}
