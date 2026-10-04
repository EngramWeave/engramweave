import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isolatedRuntime } from '../helpers/runtime.js';

it('ignores unknown private-pipe messages and stops cleanly when the native host pipe closes', async () => {
  const isolated = await isolatedRuntime();
  const filename = path.join(isolated.root, 'config.json');
  await writeFile(filename, JSON.stringify(isolated.config));
  const child = spawn(
    process.execPath,
    [path.resolve('packages/core/dist/main.js'), '--config', filename],
    {
      env: { ...process.env, ENGRAMWEAVE_HOST_STDIN: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const exited = once(child, 'exit');
  let output = '';
  let errors = '';
  const started = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('core_started')) resolve();
    });
    child.stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', () => {
      if (!output.includes('core_started'))
        reject(new Error('Native hosted Core did not start'));
    });
  });
  try {
    await started;
    const token = await readFile(
      path.join(isolated.config.data_dir, 'token'),
      'utf8',
    );
    child.stdin.write('{"type":"arbitrary_command","command":"stop"}\n');
    const health = await fetch(
      `http://127.0.0.1:${isolated.config.port}/v1/health`,
    );
    expect(health.status).toBe(200);
    child.stdin.end();
    expect(await exited).toEqual([0, null]);
    expect(errors).toBe('');
    expect(
      output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).event),
    ).toEqual(['core_started', 'core_stopped']);
    expect(output).not.toContain(token);
    expect(await readdir(isolated.config.data_dir)).toEqual([
      'core.sqlite',
      'token',
    ]);
    expect(await readdir(isolated.config.vault_path)).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
    await isolated.cleanup();
  }
});
