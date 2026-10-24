import { readFile } from 'node:fs/promises';

const runtime = new URL('../.runtime/', import.meta.url);
const pid = Number(await readFile(new URL('relay-lan.pid', runtime), 'utf8'));
if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid HTTP relay PID');
const command = await readFile(`/proc/${pid}/cmdline`, 'utf8');
if (!command.includes('/run-relay-lan.mjs')) throw new Error('PID does not belong to the Antigrid LAN HTTP relay');
process.kill(pid, 'SIGTERM');
console.log('Stopped Antigrid LAN HTTP relay.');
