import { readFile } from 'node:fs/promises';
import { createRelay } from '../relay/server.js';

const runtime = new URL('../.runtime/', import.meta.url);
const { apiToken } = JSON.parse(await readFile(new URL('control.json', runtime), 'utf8'));
const port = Number(process.env.ANTIGRID_LAN_HTTPS_PORT || 18082);
if (![18082, 18083].includes(port)) throw new Error('Unsupported LAN HTTPS relay port');
const server = createRelay({
  apiToken,
  allowedClients: ['192.168.0.2', '192.168.0.3'],
  publicBaseUrl: `https://192.168.0.3:${port}`,
  tls: {
    key: await readFile(new URL('tls/server.key', runtime)),
    cert: await readFile(new URL('tls/server.crt', runtime))
  },
  log: (event, detail) => {
    if (event !== 'upstream_started') console.log(JSON.stringify({ event, ...detail }));
  }
});
server.listen(port, '192.168.0.3', () => console.log(`Antigrid LAN HTTPS relay listening on 192.168.0.3:${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
