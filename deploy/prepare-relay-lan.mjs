import { readFile, writeFile, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runtime = new URL('../.runtime/', import.meta.url);
const { apiToken } = JSON.parse(await readFile(new URL('control.json', runtime), 'utf8'));
const healthy = async () => {
  try {
    const response = await fetch('http://192.168.0.3:18082/debug/status', {
      headers: { Authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(1000)
    });
    return response.ok && typeof (await response.json()).active_sessions === 'number';
  } catch { return false; }
};
if (await healthy()) console.log('Antigrid LAN relay is already running.');
else {
  const log = await open(new URL('relay-lan.log', runtime), 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(new URL('run-relay-lan.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), detached: true, stdio: ['ignore', log.fd, log.fd]
  });
  child.unref(); await log.close();
  await writeFile(new URL('relay-lan.pid', runtime), String(child.pid), { mode: 0o600 });
  let ready = false;
  for (let i = 0; i < 20; i++) { if (await healthy()) { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 250)); }
  if (!ready) throw new Error('LAN relay failed to start. Check .runtime/relay-lan.log on the server.');
  console.log('Antigrid LAN relay started.');
}
