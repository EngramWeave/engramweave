import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { loadConfig, validateConfig } from './config.js';
import { CoreError, errorCode } from './errors.js';
import { createHttp, type HttpRuntime } from './http.js';
import { acquireInstance, type Instance } from './instance.js';
import type { Config } from '@engramweave/contracts';
import { openDatabase } from './storage/database.js';
import { ScanJobs } from './jobs/scans.js';
import { CompilerJobs } from './jobs/compiler.js';
import { SourceBatches } from './jobs/source-batches.js';
import type { CoreServices } from './http/context.js';
import { recoverDatabase } from './storage/recover.js';
import { retainWindowsAttributes } from './files/windows.js';
import { SemanticRecall } from './recall/index.js';

export async function startCore(input: Config) {
  const releaseAttributes = retainWindowsAttributes();
  try { return await initializeCore(input, releaseAttributes); }
  catch (error) { await releaseAttributes(); throw error; }
}
async function initializeCore(input: Config, releaseAttributes: () => Promise<void>) {
  const config = await validateConfig(input);
  const runtime: HttpRuntime = { token: null, status: 'starting' };
  let services: CoreServices | undefined;
  let database: CoreServices['db'] | undefined;
  const server = createHttp(config, runtime, () => {
    if (!services) throw new CoreError('CORE_UNAVAILABLE', 'Core database is not initialized', 503);
    return services;
  });
  let instance: Instance | undefined;
  try {
    // A port-conflicting process must never touch ownership metadata or the database.
    try { await server.listen({ host: config.host, port: config.port }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new CoreError('PORT_CONFLICT', 'Configured loopback port is already in use', 409);
      throw error;
    }
    instance = await acquireInstance(config);
    runtime.token = instance.token;
    database = await openDatabase(config);
    let compiler: CompilerJobs;
    let batches: SourceBatches;
    let recall: SemanticRecall | undefined;
    const jobs = new ScanJobs(database, config.vault_path, () => Boolean(compiler?.busy() || batches?.busy()), async () => { await recall?.afterRefresh(); });
    compiler = new CompilerJobs(database, config, () => jobs.active() !== null);
    await compiler.initialize();
    batches = new SourceBatches(config, database, compiler, () => jobs.active() !== null);
    recall = new SemanticRecall(config, database);
    services = { db: database, jobs, compiler, batches, recall, instance_id: instance.id };
    await batches.initialize();
    runtime.status = 'ready';
    let closed = false;
    return { config, instance_id: instance.id, server, async close() {
      if (closed) return;
      closed = true;
      runtime.status = 'degraded';
      try { await server.close(); const batchClose = services?.batches?.close(); await services?.compiler?.close(); await batchClose; await services?.jobs.close(); await services?.recall?.close(); }
      finally { try { database?.close(); } finally { try { await instance?.close(); } finally { await releaseAttributes(); } } }
    } };
  } catch (error) {
    try { await server.close(); const batchClose = services?.batches?.close(); await services?.compiler?.close(); await batchClose; await services?.jobs.close(); await services?.recall?.close(); }
    finally { try { database?.close(); } finally { await instance?.close(); } }
    throw error;
  }
}

async function main() {
  if (process.argv.length === 5 && process.argv[2] === '--recover' && process.argv[3] === '--config' && process.argv[4]) {
    const result = await recoverDatabase(await loadConfig(process.argv[4]));
    console.log(JSON.stringify({ event: 'core_recovered', ...result }));
    return;
  }
  if (process.argv.length !== 4 || process.argv[2] !== '--config' || !process.argv[3]) {
    throw new CoreError('CONFIG_ERROR', 'Usage: node packages/core/dist/main.js [--recover] --config <absolute config.json>', 400);
  }
  const core = await startCore(await loadConfig(process.argv[3]));
  console.log(JSON.stringify({ event: 'core_started', instance_id: core.instance_id, port: core.config.port, status: 'ready', database_initialized: true }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await core.close();
    console.log(JSON.stringify({ event: 'core_stopped' }));
    if (process.connected) process.disconnect();
  };
  const requestStop = () => { void stop().catch(error => {
    console.error(JSON.stringify({ event: 'core_failed', code: errorCode(error), ...(error instanceof CoreError && error.details ? { details: error.details } : {}) }));
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }); };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  if (process.send) process.on('message', message => {
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'stop') requestStop();
  });
  // Only a native host-created private pipe opts into this lifecycle protocol.
  if (process.env.ENGRAMWEAVE_HOST_STDIN === '1') {
    const control = createInterface({ input: process.stdin });
    control.on('line', line => { if (line === '{"type":"stop"}') { control.close(); process.stdin.destroy(); requestStop(); } });
    control.once('close', requestStop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(JSON.stringify({ event: 'core_failed', code: errorCode(error), ...(error instanceof CoreError && error.details ? { details: error.details } : {}) }));
    process.exitCode = 1;
  });
}
