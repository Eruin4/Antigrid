import { readFile } from 'node:fs/promises';
import { createRelay } from '../relay/server.js';

const { apiToken } = JSON.parse(await readFile(new URL('../.runtime/control.json', import.meta.url), 'utf8'));
const server = createRelay({
  apiToken,
  allowedClients: ['192.168.0.2', '192.168.0.3'],
  publicBaseUrl: 'http://192.168.0.3:18082',
  log: (event, detail) => {
    if (event !== 'upstream_started') console.log(JSON.stringify({ event, ...detail }));
  }
});
server.listen(18082, '192.168.0.3', () => console.log('Antigrid LAN relay listening on 192.168.0.3:18082'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
