import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const testsDir = path.join(root, 'tests');

function findTestFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

const testFiles = findTestFiles(testsDir);
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const proc = spawn(npxCmd, ['tsx', '--test', ...testFiles], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env,
});

proc.on('exit', (code) => {
  process.exit(code ?? 0);
});
