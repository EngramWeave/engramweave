import net from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { API_VERSION, type Config } from '@engramweave/contracts';
import { CoreError } from './errors.js';
import { pathKey, validateConfig } from './config.js';

export interface Instance {
  id: string;
  token: string;
  close(): Promise<void>;
}
const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;

async function readRegularFile(filename: string): Promise<string | null> {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new CoreError('INSTANCE_UNCERTAIN', 'Runtime metadata is not a regular file', 409);
    return await readFile(filename, 'utf8');
  } catch (error) { if (errno(error) === 'ENOENT') return null; throw error; }
}

async function assertFormerInstanceExited(filename: string): Promise<void> {
  const raw = await readRegularFile(filename);
  if (raw === null) return;
  let prior: { pid: number };
  try {
    prior = JSON.parse(raw) as { pid: number };
    if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0) throw new Error('invalid');
  } catch { throw new CoreError('INSTANCE_UNCERTAIN', 'Cannot establish ownership of residual runtime metadata', 409); }
  try { process.kill(prior.pid, 0); }
  catch (error) {
    if (errno(error) === 'ESRCH') return;
    throw new CoreError('INSTANCE_UNCERTAIN', 'Cannot confirm the previous instance has exited', 409);
  }
  throw new CoreError('INSTANCE_UNCERTAIN', 'Recorded process is still alive; inspect ownership before cleanup', 409);
}

/** The OS owns this mutex: changing HTTP ports cannot bypass single-data-dir ownership. */
export async function acquireInstance(config: Config): Promise<Instance> {
  if (process.platform !== 'win32') throw new CoreError('CONFIG_ERROR', 'P1 runtime is validated only on Windows local NTFS', 400);
  await mkdir(config.data_dir, { recursive: true });
  const rechecked = await validateConfig(config);
  if (pathKey(config.data_dir) !== pathKey(rechecked.data_dir) || pathKey(rechecked.vault_path) !== pathKey(config.vault_path)) {
    throw new CoreError('CONFIG_ERROR', 'Directory identity changed during startup', 400);
  }
  const key = createHash('sha256').update(pathKey(rechecked.data_dir)).digest('hex');
  const mutex = net.createServer(socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      mutex.once('error', reject);
      mutex.listen(`\\\\.\\pipe\\EngramWeave-p1-${key}`, () => { mutex.removeListener('error', reject); resolve(); });
    });
  } catch { throw new CoreError('INSTANCE_BUSY', 'Another Core owns this application data directory', 409); }
  const closeMutex = () => new Promise<void>((resolve, reject) => mutex.close(error => error ? reject(error) : resolve()));
  const id = randomUUID();
  const lockPath = path.join(config.data_dir, 'instance.lock');
  let ownsDescriptor = false;
  try {
    await assertFormerInstanceExited(lockPath);
    // Reclamation is serialized by the process-bound mutex, never by a residual PID alone.
    const tokenPath = path.join(config.data_dir, 'token');
    let token = await readRegularFile(tokenPath);
    if (token === null) {
      token = randomBytes(32).toString('hex');
      await writeFile(tokenPath, token, { flag: 'wx', mode: 0o600 });
    }
    if (!/^[a-f0-9]{64}$/.test(token)) throw new CoreError('INSTANCE_UNCERTAIN', 'Local authentication token is invalid', 409);
    await writeFile(lockPath, JSON.stringify({ instance_id: id, pid: process.pid, api_version: API_VERSION,
      host: config.host, port: config.port, vault_path_key: pathKey(config.vault_path), data_dir_key: pathKey(config.data_dir) }), { mode: 0o600 });
    ownsDescriptor = true;
    let closed = false;
    return { id, token, async close() {
      if (closed) return;
      closed = true;
      try {
        const raw = await readRegularFile(lockPath);
        if (raw !== null && (JSON.parse(raw) as { instance_id?: string }).instance_id === id) await unlink(lockPath);
      } finally { await closeMutex(); }
    } };
  } catch (error) {
    if (ownsDescriptor) await unlink(lockPath);
    await closeMutex();
    throw error;
  }
}
