import { pathToFileURL } from 'node:url';
import { loadConfig, validateConfig } from './config.js';
import { CoreError, errorCode } from './errors.js';
import { createHttp, type HttpRuntime } from './http.js';
import { acquireInstance, type Instance } from './instance.js';
import type { Config } from '@engramweave/contracts';

export async function startCore(input: Config) {
  const config = await validateConfig(input);
  const runtime: HttpRuntime = { token: null, status: 'starting' };
  const server = createHttp(config, runtime);
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
    // T03 provides real database initialization. T01 deliberately cannot report ready.
    runtime.status = 'degraded';
    let closed = false;
    return { config, instance_id: instance.id, server, async close() {
      if (closed) return;
      closed = true;
      runtime.status = 'degraded';
      try { await server.close(); }
      finally { await instance?.close(); }
    } };
  } catch (error) {
    await server.close();
    await instance?.close();
    throw error;
  }
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config' || !process.argv[3]) {
    throw new CoreError('CONFIG_ERROR', 'Usage: node packages/core/dist/main.js --config <absolute config.json>', 400);
  }
  const core = await startCore(await loadConfig(process.argv[3]));
  console.log(JSON.stringify({ event: 'core_started', instance_id: core.instance_id, port: core.config.port, status: 'degraded', database_initialized: false }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await core.close();
    console.log(JSON.stringify({ event: 'core_stopped' }));
    if (process.connected) process.disconnect();
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  if (process.send) process.on('message', message => {
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'stop') void stop();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(JSON.stringify({ event: 'core_failed', code: errorCode(error) }));
    process.exitCode = 1;
  });
}
