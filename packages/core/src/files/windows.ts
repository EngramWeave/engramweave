import { spawn } from 'node:child_process';
import path from 'node:path';
import { CoreError } from '../errors.js';

interface Attributes { path: string; reparse: boolean; hidden: boolean }
// Node's Stats does not expose every Windows reparse tag or the Hidden attribute.
// A fixed native query inspects metadata only; no caller text enters executable code.
const query = `$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = New-Object Text.UTF8Encoding($false); [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); $paths = [Console]::In.ReadToEnd() | ConvertFrom-Json; $result = @(foreach ($p in $paths) { $attributes = [IO.File]::GetAttributes($p); @{ path = $p; reparse = [bool]($attributes -band [IO.FileAttributes]::ReparsePoint); hidden = [bool]($attributes -band [IO.FileAttributes]::Hidden) } }); ConvertTo-Json -InputObject $result -Compress`;

export async function windowsAttributes(paths: string[]): Promise<Attributes[]> {
  if (!paths.length) return [];
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', query], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += String(chunk); });
    // Native errors can contain paths; expose only the controlled diagnostic.
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(new CoreError('IO_ERROR', 'Windows file attributes are unavailable')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new CoreError('IO_ERROR', 'Windows file attributes could not be inspected'));
      try {
        const values: unknown = JSON.parse(output);
        if (!Array.isArray(values) || values.length !== paths.length || values.some((item, index) =>
          typeof item !== 'object' || item === null || item.path !== paths[index] || typeof item.reparse !== 'boolean' || typeof item.hidden !== 'boolean')) throw new Error('invalid');
        resolve(values as Attributes[]);
      } catch { reject(new CoreError('IO_ERROR', 'Invalid Windows file attribute response')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(paths));
  });
}
