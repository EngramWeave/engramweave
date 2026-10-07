import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { compilerResult } from '../../packages/core/src/compiler/input.js';
import { executeApi } from '../../packages/core/src/execution/api.js';
import { defaultSettings } from '../../packages/core/src/execution/settings.js';

describe('Compiler model boundaries', () => {
  it.each(['{}', 'null', '{"title":"t","body":"b","analysis":"extra"}', '{"title":" ","body":"b"}', '{"title":"t\\nfilename","body":"b"}', 'not JSON'])('rejects incomplete or extended model output %s', output => {
    expect(() => compilerResult(output)).toThrow();
  });
  it('accepts only title and body without classifying personal understanding', () => {
    expect(compilerResult('{"title":"Memory","body":"My understanding is part of this knowledge."}')).toEqual({ title: 'Memory', body: 'My understanding is part of this knowledge.' });
  });
  it('performs one bounded API call with submitted context, handles split UTF-8 and rejects refusal', async () => {
    const requests: any[] = []; let refusal = false;
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      requests.push({ url: req.url, input: JSON.parse(Buffer.concat(chunks).toString()), auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      const bytes = Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: '记忆', body: '条件甲下成立，理解也保留。' }), ...(refusal ? { refusal: 'refused' } : {}) } }] }));
      for (let offset = 0; offset < bytes.length; offset += 5) res.write(bytes.subarray(offset, offset + 5));
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    try {
      const settings = { ...defaultSettings, route: 'api' as const, endpoint, model: 'fixture-model' };
      expect(await executeApi(settings, 'mock-key', '{"submitted_content":"condition A","annotation":"personal understanding"}', AbortSignal.timeout(5000), 'Custom Compiler instructions')).toEqual({ title: '记忆', body: '条件甲下成立，理解也保留。' });
      expect(requests[0].url).toBe('/v1/chat/completions');
      expect(requests[0].input.messages[1].content).toContain('personal understanding');
      expect(requests[0].input.messages[0].content).toBe('Custom Compiler instructions');
      expect(requests[0].input).not.toHaveProperty('tools');
      expect(requests[0].input.response_format.json_schema.schema.additionalProperties).toBe(false);
      refusal = true;
      await expect(executeApi(settings, 'mock-key', '{}', AbortSignal.timeout(5000), 'Custom Compiler instructions')).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
      expect(requests).toHaveLength(2);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
