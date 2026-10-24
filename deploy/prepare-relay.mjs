import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runtime = new URL('../.runtime/', import.meta.url);
await mkdir(runtime, { recursive: true, mode: 0o700 });
const configPath = new URL('control.json', runtime);
let config;
try { config = JSON.parse(await readFile(configPath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  config = { apiToken: randomBytes(32).toString('hex') };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
}
const healthy = async () => {
  try {
    const r = await fetch('http://127.0.0.1:18081/debug/status', { headers: { Authorization: `Bearer ${config.apiToken}` }, signal: AbortSignal.timeout(1000) });
    return r.ok && typeof (await r.json()).active_sessions === 'number';
  } catch { return false; }
};
if (await healthy()) { console.log('Antigrid relay is already running.'); }
else {
  const log = await open(new URL('relay.log', runtime), 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(new URL('run-relay.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), detached: true, stdio: ['ignore', log.fd, log.fd]
  });
  child.unref(); await log.close();
  await writeFile(new URL('relay.pid', runtime), String(child.pid), { mode: 0o600 });
  let ready = false;
  for (let i = 0; i < 20; i++) { if (await healthy()) { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 250)); }
  if (!ready) throw new Error('Relay failed to start. Check .runtime/relay.log on the server.');
  console.log('Antigrid relay started on server loopback port 18081.');
}
