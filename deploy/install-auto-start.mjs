import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';

if (process.platform !== 'linux' || homedir() !== '/home/eruin') {
  throw new Error('Run this installer on the eruin Linux relay server.');
}
const run = promisify(execFile);
const unit = 'antigrid-relay.service';
const systemctl = (...args) => run('systemctl', ['--user', ...args]);
const linger = await run('loginctl', ['show-user', 'eruin', '-p', 'Linger', '--value']);
if (linger.stdout.trim() !== 'yes') throw new Error('User lingering must be enabled for startup without login.');
const directory = path.join(homedir(), '.config/systemd/user');
await mkdir(directory, { recursive: true });
await copyFile(new URL(unit, import.meta.url), path.join(directory, unit));
await systemctl('daemon-reload');
await systemctl('enable', unit);

const active = await systemctl('is-active', unit).then(() => true, () => false);
if (!active) {
  const pidFile = new URL('../.runtime/relay-lan-https.pid', import.meta.url);
  const saved = await readFile(pidFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (saved.trim()) {
    if (!/^[1-9]\d*$/.test(saved.trim())) throw new Error('Invalid existing relay PID.');
    const pid = Number(saved.trim());
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (command) {
      const args = command.split('\0').filter(Boolean);
      if (!path.basename(args[0]).startsWith('node') || args[1] !== '/home/eruin/project/antigrid/deploy/run-relay-lan-https.mjs') {
        throw new Error('Saved PID does not belong to the expected Antigrid relay.');
      }
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 100; i++) {
        const alive = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(error => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        if (!alive) break;
        if (i === 99) throw new Error('Existing relay did not stop; service has not been started.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }
  await systemctl('start', unit);
}
await systemctl('is-active', unit);
console.log('Antigrid automatic startup enabled.');
