import { describe, expect, it, vi } from 'vitest';
import { executeApiText } from '../../packages/core/src/execution/api.js';
import { defaultSettings, validateSettings } from '../../packages/core/src/execution/settings.js';

describe('API output budgets and safe diagnostics', () => {
  it('sends exactly the selected budget field, preserves old settings and rejects invalid budgets', async () => {
    const requests: Record<string,unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => { requests.push(JSON.parse(init.body as string)); return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{}'}}]})); });
    try {
      for (const output_tokens of [undefined, {parameter:'max_tokens' as const,limit:4096}, {parameter:'max_completion_tokens' as const,limit:2048}]) {
        const settings = {...defaultSettings,...output_tokens ? {output_tokens} : {}}; validateSettings(settings);
        await executeApiText(settings,'','{}',AbortSignal.timeout(1000),'Instructions',{},'review');
      }
      expect(requests[0]).not.toHaveProperty('max_tokens'); expect(requests[0]).not.toHaveProperty('max_completion_tokens');
      expect(requests[1]?.max_tokens).toBe(4096); expect(requests[1]).not.toHaveProperty('max_completion_tokens');
      expect(requests[2]?.max_completion_tokens).toBe(2048); expect(requests[2]).not.toHaveProperty('max_tokens');
      for (const limit of [0,-1,1.5,131073]) expect(() => validateSettings({...defaultSettings,output_tokens:{parameter:'max_tokens',limit}})).toThrow();
    } finally { vi.unstubAllGlobals(); }
  });
  it('distinguishes rejected parameters, truncation, refusal and missing content without leaking provider text', async () => {
    try {
      vi.stubGlobal('fetch',async () => new Response(JSON.stringify({error:{param:'response_format',code:'unsupported_parameter',message:'secret-key private Source content'}}),{status:400}));
      let error: Error | undefined;
      try { await executeApiText(defaultSettings,'secret-key','private Source content',AbortSignal.timeout(1000),'Instructions',{},'review'); } catch (e) { error = e as Error; }
      expect(error?.message).toContain('response_format'); expect(error?.message).toContain('unsupported_parameter'); expect(error?.message).not.toMatch(/secret-key|private Source/);
      for (const [choice,message] of [
        [{finish_reason:'length',message:{content:'{}'}},'token limit'],
        [{finish_reason:'stop',message:{content:'{}',refusal:'no'}},'refused'],
        [{finish_reason:'stop',message:{content:null}},'no task content'],
      ] as const) {
        vi.stubGlobal('fetch',async () => new Response(JSON.stringify({choices:[choice]})));
        await expect(executeApiText(defaultSettings,'','{}',AbortSignal.timeout(1000),'Instructions',{},'review')).rejects.toThrow(message);
      }
    } finally { vi.unstubAllGlobals(); }
  });
});
