import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { CompilerSettingsSchema, type CompilerSettings } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { runProcess } from './process.js';

export const defaultSettings: CompilerSettings = { route: 'codex', model: '', endpoint: 'https://api.openai.com/v1', codex_path: '', output_format: 'json_schema', reasoning_effort: 'default', timeout_seconds: 300 };
export const localEndpoint = (endpoint: string) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname); } catch { return false; } };
const endpointKey = (endpoint: string) => new URL(endpoint).href.replace(/\/$/, '');
function validateSettings(settings: CompilerSettings) {
  if (!Value.Check(CompilerSettingsSchema, settings)) throw new CoreError('CONFIG_ERROR', 'Compiler settings fields are invalid', 400);
  if (settings.endpoint) {
    let uri: URL;
    try { uri = new URL(settings.endpoint); } catch { throw new CoreError('CONFIG_ERROR', 'API endpoint is invalid', 400); }
    if (uri.username || uri.password || uri.search || uri.hash || (uri.protocol !== 'https:' && !(uri.protocol === 'http:' && localEndpoint(settings.endpoint)))) throw new CoreError('CONFIG_ERROR', 'Use an HTTPS endpoint or explicit local HTTP endpoint without credentials', 400);
  }
  if (settings.codex_path && (!path.isAbsolute(settings.codex_path) || path.extname(settings.codex_path).toLowerCase() !== '.exe')) throw new CoreError('CONFIG_ERROR', 'Codex path must be an absolute executable path', 400);
}
interface Credential { version: 1; endpoint: string; protected_key: string }
const cryptoScript = `Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($inputText)
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
try {
  if ($args[0] -eq 'protect') { $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope) }
  else { $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope) }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch { exit 1 }`;

async function regularRead(filename: string, limit: number): Promise<Buffer | null> {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) throw new Error('unsafe');
    const bytes = await readFile(filename);
    if (bytes.length > limit) throw new Error('large');
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CoreError('CONFIG_ERROR', 'Execution settings or credential storage is unsafe or unavailable', 400);
  }
}
async function atomicWrite(filename: string, bytes: string) {
  await regularRead(filename, 32_768);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
  await rename(temporary, filename);
}
async function crypt(mode: 'protect' | 'unprotect', bytes: Buffer): Promise<Buffer> {
  if (process.platform !== 'win32') throw new CoreError('CONFIG_ERROR', 'API credential storage currently requires Windows DPAPI', 400);
  // EncodedCommand keeps the fixed program separate from untrusted key bytes.
  const script = cryptoScript.replace("$args[0] -eq 'protect'", mode === 'protect' ? '$true' : '$false');
  try {
    const output = await runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], bytes.toString('base64'), { signal: AbortSignal.timeout(15_000), maxBytes: 32_768 });
    return Buffer.from(output.trim(), 'base64');
  } catch { throw new CoreError('CONFIG_ERROR', 'Windows credential protection failed', 400); }
}
export class ExecutionSettings {
  private writing = false;
  constructor(private readonly directory: string) {}
  async read() {
    const bytes = await regularRead(path.join(this.directory, 'compiler-settings.json'), 16_384);
    let settings: unknown;
    try { settings = bytes ? JSON.parse(bytes.toString('utf8')) : defaultSettings; }
    catch { throw new CoreError('CONFIG_ERROR', 'Compiler settings JSON is invalid', 400); }
    if (!Value.Check(CompilerSettingsSchema, settings)) throw new CoreError('CONFIG_ERROR', 'Compiler settings fields are invalid', 400);
    validateSettings(settings);
    const credential = await this.credential();
    return { settings, api_key_configured: Boolean(settings.endpoint && credential && credential.endpoint === endpointKey(settings.endpoint)) };
  }
  private async credential(): Promise<Credential | null> {
    const bytes = await regularRead(path.join(this.directory, 'compiler-api-key.dpapi'), 32_768);
    if (!bytes) return null;
    try {
      const record = JSON.parse(bytes.toString('utf8'));
      if (record.version !== 1 || typeof record.endpoint !== 'string' || typeof record.protected_key !== 'string') throw new Error('invalid');
      return record;
    } catch { throw new CoreError('CONFIG_ERROR', 'Compiler credential record is invalid', 400); }
  }
  async save(settings: CompilerSettings, key?: string) {
    if (this.writing) throw new CoreError('JOB_BUSY', 'Settings are being saved', 409);
    this.writing = true;
    try {
      validateSettings(settings);
      if (key !== undefined && (!key.trim() || Buffer.byteLength(key) > 8192)) throw new CoreError('CONFIG_ERROR', 'API key must be nonempty and within its byte limit', 400);
      if (key !== undefined) {
        if (!settings.endpoint) throw new CoreError('CONFIG_ERROR', 'An API credential requires its endpoint', 400);
        await atomicWrite(path.join(this.directory, 'compiler-api-key.dpapi'), JSON.stringify({ version: 1, endpoint: endpointKey(settings.endpoint), protected_key: (await crypt('protect', Buffer.from(key))).toString('base64') }));
      }
      await atomicWrite(path.join(this.directory, 'compiler-settings.json'), JSON.stringify(settings));
      return this.read();
    } finally { this.writing = false; }
  }
  async apiKey(endpoint?: string): Promise<string> {
    const expected = endpoint ?? (await this.read()).settings.endpoint;
    const credential = await this.credential();
    if (!credential || credential.endpoint !== endpointKey(expected)) {
      if (localEndpoint(expected)) return '';
      throw new CoreError('CONFIG_ERROR', 'Configure an API key for this endpoint in Compiler settings', 400);
    }
    return (await crypt('unprotect', Buffer.from(credential.protected_key, 'base64'))).toString('utf8');
  }
}
