import { realpathSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const mode = process.argv[2];
if (!['dev', 'build'].includes(mode) || process.argv.length !== 3)
  throw new Error('Usage: npm run desktop:dev or desktop:build');
if (process.version !== 'v24.19.0')
  throw new Error('Desktop host requires the validated Node v24.19.0 runtime');
const root = realpathSync(new URL('..', import.meta.url));
const node = realpathSync(process.execPath);
const entry = path.join(root, 'packages/core/dist/main.js');
if (!existsSync(entry))
  throw new Error('Run npm run build before starting Desktop');
const child = spawn(
  node,
  [
    path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
    mode,
    ...(mode === 'build' ? ['--debug', '--no-bundle'] : []),
  ],
  {
    cwd: path.join(root, 'apps/desktop'),
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      PATH: `${process.env.USERPROFILE}/.cargo/bin;${process.env.PATH}`,
      ENGRAMWEAVE_NODE: node,
      ENGRAMWEAVE_CORE_ENTRY: entry,
    },
  },
);
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
