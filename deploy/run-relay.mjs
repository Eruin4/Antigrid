import { readFile } from 'node:fs/promises';
import { createRelay } from '../relay/server.js';
const { apiToken } = JSON.parse(await readFile(new URL('../.runtime/control.json', import.meta.url), 'utf8'));
const server = createRelay({ apiToken, publicBaseUrl: 'http://127.0.0.1:18080', log: (event, detail) => {
  if (!['upstream_started'].includes(event)) console.log(JSON.stringify({ event, ...detail }));
} });
server.listen(18081, '127.0.0.1', () => console.log('Antigrid private relay listening on 127.0.0.1:18081'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
