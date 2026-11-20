import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const root = process.cwd();
const distDir = path.join(root, 'dist');

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(path.join(distDir, 'bin'), { recursive: true });
fs.mkdirSync(path.join(distDir, 'sdk'), { recursive: true });

const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  sourcemap: false,
};

// 1. Standalone executable CLI (`termlink`)
await esbuild.build({
  ...commonOptions,
  entryPoints: [path.join(root, 'apps/cli/src/index.ts')],
  outfile: path.join(distDir, 'bin/termlink.mjs'),
  banner: {
    js: '#!/usr/bin/env node',
  },
});
fs.chmodSync(path.join(distDir, 'bin/termlink.mjs'), 0o755);

// 2. Standalone Signaling Server executable (`termlink-server`)
await esbuild.build({
  ...commonOptions,
  entryPoints: [path.join(root, 'server.ts')],
  outfile: path.join(distDir, 'signaling-server.mjs'),
  banner: {
    js: '#!/usr/bin/env node',
  },
});
fs.chmodSync(path.join(distDir, 'signaling-server.mjs'), 0o755);

// 3. Public Developer SDK (`import { TermLink } from "termlink"`)
await esbuild.build({
  ...commonOptions,
  entryPoints: [path.join(root, 'packages/sdk/src/index.ts')],
  outfile: path.join(distDir, 'sdk/index.mjs'),
});

// 4. Emit TypeScript declarations for SDK
execSync('npx --no-install tsc -p tsconfig.build.json', { stdio: 'inherit' });

console.log('Built TermLink npm package cleanly:');
console.log('  - dist/bin/termlink.mjs       (CLI executable)');
console.log('  - dist/signaling-server.mjs   (Signaling server executable)');
console.log('  - dist/sdk/index.mjs          (Developer SDK ESM bundle)');
console.log('  - dist/sdk/*.d.ts             (TypeScript declarations)');
