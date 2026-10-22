import { createRelay } from './server.js';

const host = process.env.RELAY_HOST || '127.0.0.1';
const port = Number(process.env.RELAY_PORT || 8080);
const apiToken = process.env.RELAY_API_TOKEN || '';
const publicBaseUrl = process.env.RELAY_PUBLIC_BASE_URL || `http://${host}:${port}`;
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && (!apiToken || !process.env.RELAY_PUBLIC_BASE_URL)) {
  throw new Error('Non-local binding requires RELAY_API_TOKEN and RELAY_PUBLIC_BASE_URL');
}
const server = createRelay({
  publicBaseUrl,
  apiToken,
  corsOrigin: process.env.RELAY_CORS_ORIGIN || '',
  idleMs: Number(process.env.RELAY_IDLE_MS || 30_000),
  cleanupMs: Number(process.env.RELAY_CLEANUP_MS || 1_000),
  allowPrivateUpstream: process.env.RELAY_ALLOW_PRIVATE_UPSTREAM === '1'
});
server.listen(port, host, () => console.log(`Antigrid relay listening on ${host}:${port}`));
