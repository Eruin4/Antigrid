import dns from 'node:dns/promises';
import net from 'node:net';

export function safeLogUrl(value) {
  try {
    const u = new URL(value);
    const extension = u.pathname.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
    return `${u.origin}/[path]${extension ? `.${extension}` : ''}${u.search ? '?[redacted]' : ''}`;
  } catch {
    return '[invalid URL]';
  }
}

export function validUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error('Invalid upstream URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || !u.hostname) {
    throw new Error('Only HTTP(S) URLs without embedded credentials are allowed');
  }
  return u;
}

function forbiddenAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const p = address.split('.').map(Number);
    const [a, b, c] = p;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:')) {
      const tail = lower.slice(7);
      if (net.isIP(tail) === 4) return forbiddenAddress(tail);
      const words = tail.split(':');
      if (words.length === 2) {
        const high = parseInt(words[0], 16), low = parseInt(words[1], 16);
        return forbiddenAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
      return true;
    }
    const first = parseInt(lower.split(':')[0] || '0', 16);
    return (first & 0xe000) !== 0x2000 || lower.startsWith('2001:db8:') ||
      lower.startsWith('2001:0:') || lower.startsWith('2002:');
  }
  return true;
}

export async function resolveTarget(url, allowPrivate = false) {
  const u = validUrl(url);
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  const records = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length || (!allowPrivate && records.some(r => forbiddenAddress(r.address)))) {
    throw new Error('Upstream target resolves to a blocked address');
  }
  return { url: u, address: records[0].address, family: records[0].family };
}

export function cleanHeaders(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('headers must be an object');
  const allowed = new Set(['referer', 'user-agent', 'origin', 'authorization']);
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key.toLowerCase()) || typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 4096) {
      throw new Error(`Unsupported upstream header: ${key}`);
    }
    out[key.toLowerCase()] = value;
  }
  return out;
}
