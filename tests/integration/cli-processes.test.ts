import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const cliBin = path.join(root, 'dist/bin/termlink.mjs');
const serverBin = path.join(root, 'dist/signaling-server.mjs');

test('Compiled npm CLI binary runs directly with plain node across separate OS processes', async () => {
  // 1. Check `termlink version`
  const ver = await execFileAsync(process.execPath, [cliBin, 'version']);
  assert.match(ver.stdout, /termlink v1\.[0-9]+\.[0-9]+/);

  // 2. Check `termlink devices`
  const dev = await execFileAsync(process.execPath, [cliBin, 'devices']);
  assert.match(dev.stdout, /Fingerprint:\s+([0-9A-F]{2}:){15}[0-9A-F]{2}/);

  // 3. Boot compiled signaling server process on an ephemeral port
  const port = 18791;
  const serverProc = spawn(process.execPath, [serverBin], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Signaling server process failed to start')), 5000);
      serverProc.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      serverProc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited early with code ${code}`));
      });
    });

    // 4. Run compiled CLI `diagnostics --json` against the live signaling server process
    const diag = await execFileAsync(process.execPath, [
      cliBin,
      'diagnostics',
      '--signaling',
      `ws://127.0.0.1:${port}/ws`,
      '--json',
    ]);
    const report = JSON.parse(diag.stdout);
    assert.equal(report.signaling.connected, true);
    assert.equal(report.directP2P.listenerAvailable, true);
    assert.equal(report.status, 'Ready');

    // 5. Run compiled CLI `create --non-interactive` in a separate process -> returns real 2-digit code
    const created = await execFileAsync(process.execPath, [
      cliBin,
      'create',
      '--name',
      'CLI-PROC-TEST',
      '--signaling',
      `ws://127.0.0.1:${port}/ws`,
      '--non-interactive',
    ]);
    const parsed = JSON.parse(created.stdout.trim());
    assert.match(parsed.code, /^[0-9]{2}$/);
    assert.ok(parsed.roomId.startsWith('rm_'));
    assert.ok(parsed.joinUrl.endsWith(`/join/${parsed.code}`));
  } finally {
    serverProc.kill('SIGTERM');
  }
});
