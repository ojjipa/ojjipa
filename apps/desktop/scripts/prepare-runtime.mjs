import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
if (process.argv.includes('--development')) {
  // Tauri validates resource paths in dev too; debug builds use source Python.
  mkdirSync(path.join(root, 'apps/desktop/src-tauri/resources/runtime'), { recursive: true });
  process.exit(0);
}
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This runtime packager currently supports Windows x64 only.');
}
const python = path.join(root, '.venv-hermes', 'Scripts', 'python.exe');
const result = spawnSync(python, [path.join(root, 'apps/desktop/scripts/prepare_runtime.py')], {
  stdio: 'inherit', cwd: root,
});
if (result.error) throw new Error(`Prepare the build machine's .venv-hermes first: ${result.error.message}`);
process.exit(result.status ?? 1);
