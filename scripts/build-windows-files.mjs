import { mkdir, lstat, rename, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Core native file helper requires Windows x64');
const root = fileURLToPath(new URL('../packages/core/', import.meta.url));
const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const output = path.join(root, 'dist/native');
await mkdir(output, { recursive: true });
await lstat(compiler);
const source = path.join(root, 'native/WindowsFiles.cs');
const executable = path.join(output, 'windows-files.exe');
const receipt = path.join(output, 'windows-files.build.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const signature = hash(Buffer.concat([await readFile(source), Buffer.from('x64;optimize;System.Web.Extensions;v1')]));
try {
  const cached = JSON.parse(await readFile(receipt, 'utf8'));
  if (cached.signature === signature && hash(await readFile(executable)) === cached.binary) process.exit(0);
} catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
const temporary = path.join(output, 'windows-files.build.exe');
const child = spawn(compiler, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', '/reference:System.Web.Extensions.dll', `/out:${temporary}`, source], { stdio: 'inherit', windowsHide: true });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
if (code !== 0) throw new Error(`Core file helper build failed (${code})`);
await rename(temporary, executable);
await writeFile(receipt, JSON.stringify({ signature, binary: hash(await readFile(executable)) }));
