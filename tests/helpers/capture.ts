import type { CaptureResponse } from '@engramweave/contracts';

export async function submitCapture(request: (route: string, init?: RequestInit) => Promise<Response>, relative: string, markdown: string) {
  const response = await request('/v1/captures', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: relative, markdown }) });
  return { status: response.status, body: await response.json() as CaptureResponse };
}
