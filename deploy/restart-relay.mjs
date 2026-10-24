import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { apiToken } = JSON.parse(await readFile(new URL('../.runtime/control.json', import.meta.url), 'utf8'));
const status = await fetch('http://127.0.0.1:18081/debug/status', { headers: { Authorization: `Bearer ${apiToken}` } });
if (!status.ok || (await status.json()).active_sessions !== 0) throw new Error('Stop playback before restarting the relay.');
const pid = Number(await readFile(new URL('../.runtime/relay.pid', import.meta.url), 'utf8'));
if (!Number.isInteger(pid) || pid < 2) throw new Error('Invalid relay PID');
const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
if (command[1] !== fileURLToPath(new URL('run-relay.mjs', import.meta.url))) throw new Error('PID does not belong to the Antigrid relay');
process.kill(pid, 'SIGTERM');
for (let i = 0; i < 40; i++) {
  try { process.kill(pid, 0); } catch { break; }
  await new Promise(resolve => setTimeout(resolve, 100));
}
await import('./prepare-relay.mjs');
