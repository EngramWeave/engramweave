import { afterEach, describe, expect, it } from 'vitest';
import { createHttp } from '../../packages/core/src/http.js';
import { isolatedRuntime } from '../helpers/runtime.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const isolated = await isolatedRuntime();
  cleanups.push(isolated.cleanup);
  const runtime = { token: 'a'.repeat(64), status: 'degraded' as const };
  const server = createHttp(isolated.config, runtime);
  cleanups.push(() => server.close());
  return { server, token: runtime.token, host: `127.0.0.1:${isolated.config.port}` };
}

describe('local HTTP access and errors', () => {
  it('reports unavailable initialization without disclosing paths or secrets', async () => {
    const { server, host } = await fixture();
    const response = await server.inject({ url: '/v1/health', headers: { host } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'degraded', core_version: '0.1.0', api_version: '1' });
  });
  it('requires token even for unavailable protected routes and does not log request content', async () => {
    const { server, host, token } = await fixture();
    for (const authorization of [undefined, 'Bearer wrong', `Bearer ${token}extra`]) {
      const headers = authorization ? { host, authorization } : { host };
      const response = await server.inject({ url: '/v1/status', headers });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHORIZED');
      expect(response.body).not.toContain('wrong');
    }
    const response = await server.inject({ url: '/v1/status', headers: { host, authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ROUTE_NOT_FOUND');
  });
  it.each(['evil.example', 'localhost:43127', '127.0.0.1:1'])('rejects unexpected Host %s on health too', async host => {
    const { server } = await fixture();
    const response = await server.inject({ url: '/v1/health', headers: { host } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('HOST_NOT_ALLOWED');
  });
  it.each(['https://evil.example', 'http://localhost:1420', 'null', 'tauri://localhost'])('rejects browser Origin %s', async origin => {
    const { server, host } = await fixture();
    const response = await server.inject({ url: '/v1/health', headers: { host, origin } });
    expect(response.statusCode).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
  });
  it('rejects unknown health arguments without reflecting supplied secrets', async () => {
    const { server, host, token } = await fixture();
    const response = await server.inject({ url: `/v1/health?secret=${token}`, headers: { host } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(response.body).not.toContain(token);
  });
});
