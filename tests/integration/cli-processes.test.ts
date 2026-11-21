import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const cliBin = path.join(root, 'dist/bin/termlink.mjs');
const serverBin = path.join(root, 'dist/signaling-server.mjs');

test('Compiled npm CLI binary runs directly with plain node across separate OS processes', async () => {
  const testStorageDir = path.join(os.tmpdir(), `termlink-test-cli-${Date.now()}`);
  fs.mkdirSync(testStorageDir, { recursive: true });
  const testEnv = { ...process.env, TERMLINK_STORAGE_DIR: testStorageDir };

  // 1. Check `termlink version`
  const ver = await execFileAsync(process.execPath, [cliBin, 'version'], { env: testEnv });
  assert.match(ver.stdout, /termlink v1\.[0-9]+\.[0-9]+/);

  // 2. Check `termlink devices`
  const dev = await execFileAsync(process.execPath, [cliBin, 'devices'], { env: testEnv });
  assert.match(dev.stdout, /Fingerprint:\s+([0-9A-F]{2}:){15}[0-9A-F]{2}/);

  // 3. Boot compiled signaling server process on an ephemeral port
  const port = 18791;
  const serverProc = spawn(process.execPath, [serverBin], {
    env: { ...process.env, PORT: String(port), TERMLINK_STORAGE_DIR: testStorageDir },
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
    const diag = await execFileAsync(
      process.execPath,
      [cliBin, 'diagnostics', '--signaling', `ws://127.0.0.1:${port}/ws`, '--json'],
      { env: testEnv }
    );
    const report = JSON.parse(diag.stdout);
    assert.equal(report.signaling.connected, true);
    assert.equal(typeof report.directP2P.listenerAvailable, 'boolean');
    assert.ok(report.status === 'Ready' || report.status.includes('Degraded'));

    // 5. Run compiled CLI `create --non-interactive` in a separate process -> returns real 2-digit code
    const created = await execFileAsync(
      process.execPath,
      [cliBin, 'create', '--name', 'CLI-PROC-TEST', '--signaling', `ws://127.0.0.1:${port}/ws`, '--non-interactive'],
      { env: testEnv }
    );
    const parsed = JSON.parse(created.stdout.trim());
    assert.match(parsed.code, /^[0-9]{2}$/);
    assert.ok(parsed.roomId.startsWith('rm_'));
    assert.ok(parsed.joinUrl.endsWith(`/join/${parsed.code}`));

    // 6. Test custom 2-digit code hosting: `tl create 77`
    const customCodeCreated = await execFileAsync(
      process.execPath,
      [cliBin, 'create', '77', '--name', 'TEST-77', '--signaling', `ws://127.0.0.1:${port}/ws`, '--non-interactive'],
      { env: testEnv }
    );
    const parsedCustom = JSON.parse(customCodeCreated.stdout.trim());
    assert.equal(parsedCustom.code, '77');

    // 7. Test custom code hosting with flag: `tl create -c 88`
    const flagCustom = await execFileAsync(
      process.execPath,
      [cliBin, 'create', '-c', '88', '--name', 'TEST-88', '--signaling', `ws://127.0.0.1:${port}/ws`, '--non-interactive'],
      { env: testEnv }
    );
    const parsedFlag = JSON.parse(flagCustom.stdout.trim());
    assert.equal(parsedFlag.code, '88');

    // 8. Test device renaming: `tl name MyTestDevice`
    const renameOut = await execFileAsync(
      process.execPath,
      [cliBin, 'name', 'MyTestDevice'],
      { env: testEnv }
    );
    assert.match(renameOut.stdout, /Device name.*updated to:.*MyTestDevice/);

    const devAfterRename = await execFileAsync(process.execPath, [cliBin, 'devices'], { env: testEnv });
    assert.match(devAfterRename.stdout, /Local Device:\s+MyTestDevice/);
  } finally {
    serverProc.kill('SIGTERM');
    try {
      fs.rmSync(testStorageDir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // ignore
    }
  }
});
