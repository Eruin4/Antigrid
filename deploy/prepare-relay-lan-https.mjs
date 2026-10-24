import { readFile, writeFile, open } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const runtime = new URL('../.runtime/', import.meta.url);
const { apiToken } = JSON.parse(await readFile(new URL('control.json', runtime), 'utf8'));
const ca = await readFile(new URL('tls/server.crt', runtime));
const healthy = () => new Promise(resolve => {
  const request = https.get('https://192.168.0.3:18082/debug/status', {
    ca, headers: { Authorization: `Bearer ${apiToken}` }, timeout: 1000
  }, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => {
      try { resolve(response.statusCode === 200 && typeof JSON.parse(body).active_sessions === 'number'); }
      catch { resolve(false); }
    });
  });
  request.on('timeout', () => request.destroy());
  request.on('error', () => resolve(false));
});

if (await healthy()) console.log('Antigrid LAN HTTPS relay is already running.');
else {
  const run = promisify(execFile);
  const managed = process.platform === 'linux' && await run('systemctl', ['--user', 'is-enabled', 'antigrid-relay.service'])
    .then(result => result.stdout.trim() === 'enabled', () => false);
  if (managed) {
    await run('systemctl', ['--user', 'start', 'antigrid-relay.service']);
  } else {
    const log = await open(new URL('relay-lan-https.log', runtime), 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(new URL('run-relay-lan-https.mjs', import.meta.url))], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), detached: true, stdio: ['ignore', log.fd, log.fd]
    });
    child.unref(); await log.close();
    await writeFile(new URL('relay-lan-https.pid', runtime), String(child.pid), { mode: 0o600 });
  }
  let ready = false;
  for (let i = 0; i < 20; i++) { if (await healthy()) { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 250)); }
  if (!ready) throw new Error(managed
    ? 'LAN HTTPS relay failed to start. Check journalctl --user -u antigrid-relay.service on the server.'
    : 'LAN HTTPS relay failed to start. Check .runtime/relay-lan-https.log on the server.');
  console.log('Antigrid LAN HTTPS relay started.');
}
