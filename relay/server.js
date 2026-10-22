import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { isManifest, rewriteManifest } from './hls.js';
import { cleanHeaders, resolveTarget, safeLogUrl, validUrl } from './security.js';
import { deliveryUrl } from './delivery.js';

const randomId = () => crypto.randomBytes(24).toString('base64url');
const now = () => Date.now();
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

export function createRelay(options = {}) {
  const config = {
    idleMs: options.idleMs ?? 30_000,
    cleanupMs: options.cleanupMs ?? 1_000,
    maxManifestBytes: options.maxManifestBytes ?? 2 * 1024 * 1024,
    maxResourceBytes: options.maxResourceBytes ?? 256 * 1024 * 1024,
    maxResources: options.maxResources ?? 10_000,
    resourceTtlMs: options.resourceTtlMs ?? 120_000,
    allowPrivateUpstream: options.allowPrivateUpstream ?? false,
    apiToken: options.apiToken ?? '',
    corsOrigin: options.corsOrigin ?? '',
    allowedClients: options.allowedClients ?? null,
    publicBaseUrl: options.publicBaseUrl ?? 'http://127.0.0.1:8080',
    log: options.log ?? ((event, detail = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...detail })))
  };
  if (config.idleMs < 100 || config.cleanupMs < 10) throw new Error('Invalid cleanup interval');
  const sessions = new Map();
  const metrics = { activeDownstreamRequests: 0, activeUpstreamRequests: 0, bytesReceived: 0, bytesSent: 0 };

  function destroySession(session, reason) {
    if (!sessions.delete(session.id)) return;
    for (const controller of session.controllers) controller.abort(new Error(reason));
    session.httpAgent.destroy();
    session.httpsAgent.destroy();
    session.playlistHttpAgent.destroy();
    session.playlistHttpsAgent.destroy();
    session.resources.clear();
    session.reverse.clear();
    config.log(reason, { session_id: session.id });
  }

  function register(session, url, variables = {}, hint = 'media') {
    validUrl(url);
    const extension = new URL(url).pathname.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase();
    const recognized = new Set(['m3u8', 'ts', 'm4s', 'mp4', 'aac', 'mp3', 'vtt', 'webvtt', 'key', 'bin', 'ac3', 'ec3', 'cmfv', 'cmfa']);
    const suffix = recognized.has(extension) ? extension : hint === 'playlist' ? 'm3u8' : hint === 'key' ? 'key' : 'ts';
    const key = JSON.stringify([url, variables, suffix, hint]);
    let token = session.reverse.get(key);
    if (token) session.resources.get(token).lastSeen = now();
    else {
      if (session.resources.size >= config.maxResources) {
        const cutoff = now() - config.resourceTtlMs;
        for (const [oldToken, resource] of session.resources) {
          if (resource.lastSeen >= cutoff) continue;
          session.resources.delete(oldToken);
          session.reverse.delete(resource.key);
        }
      }
      if (session.resources.size >= config.maxResources) throw new Error('Session resource limit reached');
      token = randomId();
      session.resources.set(token, { url, variables, hint, key, lastSeen: now() });
      session.reverse.set(key, token);
    }
    return `/session/${session.id}/resource/${token}/resource.${suffix}`;
  }

  async function upstreamRequest(session, initialUrl, downstreamRange, signal, playlist) {
    let url = initialUrl;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const target = await resolveTarget(url, config.allowPrivateUpstream);
      const headers = { ...session.headers, 'accept-encoding': 'identity' };
      if (new URL(initialUrl).origin !== target.url.origin) delete headers.authorization;
      if (downstreamRange) headers.range = downstreamRange;
      metrics.activeUpstreamRequests++;
      config.log('upstream_started', { session_id: session.id, url: safeLogUrl(url) });
      let response;
      try {
        response = await new Promise((resolve, reject) => {
          const client = target.url.protocol === 'https:' ? https : http;
          const request = client.request(target.url, {
            method: 'GET', headers, signal,
            agent: target.url.protocol === 'https:'
              ? (playlist ? session.playlistHttpsAgent : session.httpsAgent)
              : (playlist ? session.playlistHttpAgent : session.httpAgent),
            lookup: (_host, opts, callback) => opts.all
              ? callback(null, [{ address: target.address, family: target.family }])
              : callback(null, target.address, target.family),
            timeout: 15_000
          }, resolve);
          request.on('error', reject);
          request.on('timeout', () => request.destroy(new Error('Upstream timeout')));
          request.end();
        });
        response.once('close', () => { metrics.activeUpstreamRequests--; });
      } catch (error) {
        metrics.activeUpstreamRequests--;
        if (signal.aborted) config.log('upstream_cancelled', { session_id: session.id });
        else config.log('upstream_error', { session_id: session.id, message: error.message, url: safeLogUrl(url) });
        throw error;
      }
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        const next = new URL(response.headers.location, url).href;
        response.destroy();
        url = next;
        continue;
      }
      return { response, finalUrl: url };
    }
    throw new Error('Too many upstream redirects');
  }

  async function relayResource(req, res, session, resource) {
    const { url, variables, hint } = resource;
    const startedAt = now();
    let headersMs = null, firstByteMs = null, transferred = 0;
    session.lastActivity = now();
    metrics.activeDownstreamRequests++;
    session.activeRequests++;
    const controller = new AbortController();
    session.controllers.add(controller);
    controller.signal.addEventListener('abort', () => res.destroy(), { once: true });
    let completed = false;
    const disconnected = () => {
      if (!completed && !controller.signal.aborted) {
        config.log('downstream_disconnected', { session_id: session.id });
        controller.abort(new Error('Downstream disconnected'));
      }
    };
    res.on('close', disconnected);
    let upstream;
    try {
      const range = typeof req.headers.range === 'string' && /^bytes=\d+-\d*$/.test(req.headers.range) ? req.headers.range : undefined;
      const requestUrl = deliveryUrl(url, req.url, hint === 'playlist' || isManifest(url));
      const result = await upstreamRequest(session, requestUrl, range, controller.signal, hint === 'playlist' || isManifest(url));
      headersMs = now() - startedAt;
      upstream = result.response;
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        config.log('upstream_http_error', { session_id: session.id, status: upstream.statusCode,
          resource: hint, url: safeLogUrl(result.finalUrl) });
        upstream.resume();
        json(res, 502, { error: `Upstream returned HTTP ${upstream.statusCode}` });
        return;
      }
      const manifest = hint === 'playlist' || isManifest(result.finalUrl, upstream.headers['content-type'] || '');
      const limit = manifest ? config.maxManifestBytes : config.maxResourceBytes;
      const length = Number(upstream.headers['content-length']);
      if (Number.isFinite(length) && length > limit) {
        upstream.destroy();
        json(res, 502, { error: 'Upstream resource exceeds size limit' });
        return;
      }
      if (manifest) {
        const chunks = [];
        let size = 0;
        for await (const chunk of upstream) {
          size += chunk.length;
          metrics.bytesReceived += chunk.length;
          session.lastActivity = now();
          if (size > limit) throw new Error('Manifest exceeds size limit');
          chunks.push(chunk);
        }
        let rewritten;
        try {
          rewritten = rewriteManifest(Buffer.concat(chunks).toString('utf8'), result.finalUrl,
            (value, inherited, hint) => register(session, value, inherited, hint), variables);
        } catch (error) {
          config.log('manifest_rewrite_error', { session_id: session.id, message: error.message, url: safeLogUrl(result.finalUrl) });
          throw error;
        }
        const body = Buffer.from(rewritten);
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': body.length, 'cache-control': 'no-store' });
        metrics.bytesSent += body.length;
        res.end(body);
      } else {
        const responseHeaders = { 'content-type': upstream.headers['content-type'] || 'application/octet-stream', 'cache-control': 'no-store' };
        for (const name of ['content-length', 'content-range', 'accept-ranges']) {
          if (upstream.headers[name]) responseHeaders[name] = upstream.headers[name];
        }
        res.writeHead(upstream.statusCode, responseHeaders);
        // Send headers immediately, including while an LL-HLS part is still being produced.
        res.flushHeaders();
        let size = 0;
        for await (const chunk of upstream) {
          if (firstByteMs === null) firstByteMs = now() - startedAt;
          transferred += chunk.length;
          size += chunk.length;
          metrics.bytesReceived += chunk.length;
          session.lastActivity = now();
          if (size > limit) throw new Error('Resource exceeds size limit');
          metrics.bytesSent += chunk.length;
          if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
        }
        res.end();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        config.log('relay_error', { session_id: session.id, message: error.message, url: safeLogUrl(url) });
        if (!res.headersSent) json(res, 502, { error: error.message });
        else res.destroy();
      }
    } finally {
      if (hint !== 'playlist' && !isManifest(url) && now() - startedAt >= 1000) {
        config.log('slow_media', { session_id: session.id, headers_ms: headersMs,
          first_byte_ms: firstByteMs, elapsed_ms: now() - startedAt, bytes: transferred,
          cancelled: controller.signal.aborted, complete: upstream?.complete === true });
      }
      completed = true;
      res.off('close', disconnected);
      if (upstream && !upstream.destroyed) upstream.destroy();
      session.controllers.delete(controller);
      session.activeRequests--;
      metrics.activeDownstreamRequests--;
    }
  }

  const handleRequest = async (req, res) => {
    try {
      if (config.allowedClients && !config.allowedClients.includes(req.socket.remoteAddress?.replace(/^::ffff:/, ''))) {
        json(res, 403, { error: 'Client is not allowed' }); return;
      }
      if (config.corsOrigin && req.headers.origin === config.corsOrigin) {
        res.setHeader('access-control-allow-origin', config.corsOrigin);
        res.setHeader('vary', 'Origin');
        res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, Range');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const path = new URL(req.url, 'http://localhost').pathname;
      const control = path.startsWith('/api/') || path === '/debug/status';
      if (control && config.apiToken && req.headers.authorization !== `Bearer ${config.apiToken}`) {
        json(res, 401, { error: 'Unauthorized' }); return;
      }
      if (req.method === 'POST' && path === '/api/session') {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16_384) { json(res, 413, { error: 'Request too large' }); return; }
          chunks.push(chunk);
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { json(res, 400, { error: 'Invalid JSON' }); return; }
        const upstreamUrl = validUrl(input.upstream_url).href;
        await resolveTarget(upstreamUrl, config.allowPrivateUpstream);
        const headers = cleanHeaders(input.headers);
        const id = randomId();
        const session = { id, upstreamUrl, headers, created: now(), lastActivity: now(), activeRequests: 0,
          controllers: new Set(), resources: new Map(), reverse: new Map(),
          httpAgent: new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 }),
          httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 }),
          // Blocking playlist reloads must not queue media downloads behind them.
          playlistHttpAgent: new http.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 }),
          playlistHttpsAgent: new https.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 }) };
        sessions.set(id, session);
        config.log('session_created', { session_id: id, url: safeLogUrl(upstreamUrl) });
        json(res, 201, { session_id: id, playback_url: `${config.publicBaseUrl}/session/${id}/master.m3u8` });
        return;
      }
      const apiMatch = path.match(/^\/api\/session\/([A-Za-z0-9_-]+)$/);
      if (req.method === 'DELETE' && apiMatch) {
        const session = sessions.get(apiMatch[1]);
        if (!session) { json(res, 404, { error: 'Session not found' }); return; }
        destroySession(session, 'session_destroyed');
        res.writeHead(204); res.end(); return;
      }
      if (req.method === 'GET' && path === '/debug/status') {
        json(res, 200, {
          active_sessions: sessions.size,
          active_downstream_requests: metrics.activeDownstreamRequests,
          active_upstream_requests: metrics.activeUpstreamRequests,
          bytes_received: metrics.bytesReceived,
          bytes_sent: metrics.bytesSent,
          sessions: [...sessions.values()].map(s => ({ id: s.id, age_seconds: Math.floor((now() - s.created) / 1000),
            idle_seconds: Math.floor((now() - s.lastActivity) / 1000), active_requests: s.activeRequests }))
        }); return;
      }
      const mediaMatch = path.match(/^\/session\/([A-Za-z0-9_-]+)\/(master\.m3u8|resource\/([A-Za-z0-9_-]+)(?:\/resource\.[A-Za-z0-9]+)?)$/);
      if (req.method === 'GET' && mediaMatch) {
        const session = sessions.get(mediaMatch[1]);
        if (!session) { json(res, 404, { error: 'Session not found' }); return; }
        const resource = mediaMatch[3] ? session.resources.get(mediaMatch[3]) : { url: session.upstreamUrl, variables: {}, hint: 'playlist' };
        if (!resource) { json(res, 404, { error: 'Resource not found' }); return; }
        if (mediaMatch[3]) resource.lastSeen = now();
        await relayResource(req, res, session, resource);
        return;
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      config.log('request_error', { message: error.message });
      if (!res.headersSent) json(res, 400, { error: error.message });
      else res.destroy();
    }
  };
  const server = options.tls ? https.createServer(options.tls, handleRequest) : http.createServer(handleRequest);
  const timer = setInterval(() => {
    const time = now();
    for (const session of sessions.values()) {
      if (time - session.lastActivity >= config.idleMs) destroySession(session, 'session_timeout');
    }
  }, config.cleanupMs);
  timer.unref();
  server.on('close', () => {
    clearInterval(timer);
    for (const session of sessions.values()) destroySession(session, 'server_stopped');
  });
  return server;
}
