/**
 * Bundles src/main.js for the Capacitor web assets as browser ESM.
 *
 * Output: www/assets/app.js (the www/assets/ directory is gitignored).
 * Minification is on by default; disable with `--no-minify` or `MINIFY=false`.
 * Exits non-zero on any build error.
 *
 * NOTE: the binary is spawned with stdio 'inherit' on purpose. The sandboxed
 * DSH environment denies child_process.spawn/exec that captures piped stdio
 * (EPERM), while 'inherit'/'ignore' spawns are allowed — the esbuild JS API
 * uses piped stdio internally, so it cannot run here.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const rootDir = path.dirname(fileURLToPath(import.meta.url));

const minify = !process.argv.includes('--no-minify') && process.env.MINIFY !== 'false';

function resolveEsbuildBinary() {
  const { platform } = process;
  const names = [`@esbuild/${process.platform}-${process.arch}`];
  if (platform === 'win32') names.unshift('esbuild-win32-x64');
  for (const name of names) {
    try {
      const pkgJson = require.resolve(`${name}/package.json`, { paths: [rootDir] });
      const bin = path.join(path.dirname(pkgJson), platform === 'win32' ? 'esbuild.exe' : 'esbuild');
      if (existsSync(bin)) return bin;
    } catch {
      // try next candidate
    }
  }
  throw new Error('[esbuild] could not locate the native esbuild binary');
}

const args = [
  path.join(rootDir, 'src', 'main.js'),
  '--bundle',
  '--format=esm',
  '--platform=browser',
  '--target=es2020',
  '--outfile=' + path.join(rootDir, 'www', 'assets', 'app.js'),
  '--legal-comments=none',
  '--log-level=info',
];
if (minify) args.push('--minify');

const result = spawnSync(resolveEsbuildBinary(), args, {
  cwd: rootDir,
  stdio: 'inherit',
});
const status = result.status;
if (status !== 0) {
  console.error(`[esbuild] web bundle failed (exit ${status})`);
  process.exit(status === null ? 1 : status);
}