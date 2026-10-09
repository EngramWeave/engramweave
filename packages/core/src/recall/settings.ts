import path from 'node:path';
import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { RecallSettingsSchema, type RecallSettings } from '@engramweave/contracts';
import { atomicWrite, regularRead, crypt, endpointKey, localEndpoint } from '../execution/settings.js';
import { CoreError } from '../errors.js';

export const defaultRecallSettings: RecallSettings = {
  endpoint: 'http://127.0.0.1:8095/v1', model: '',
  query_instruction: 'Given a search query, retrieve relevant passages from personal knowledge, ideas and research notes.',
  timeout_seconds: 60, reranker_enabled: false, reranker_endpoint: 'http://127.0.0.1:8086/v1', reranker_model: '', candidates: 40,
};
export const representationFingerprint = (s: RecallSettings) => createHash('sha256').update(JSON.stringify([endpointKey(s.endpoint), s.model, 'paragraph-byte-v1', 'icu-bm25-v1'])).digest('hex');
function validate(s: RecallSettings) {
  if (!Value.Check(RecallSettingsSchema, s)) throw new CoreError('CONFIG_ERROR', 'Recall settings fields are invalid', 400);
  for (const endpoint of [s.endpoint, s.reranker_endpoint].filter(Boolean)) {
    let url: URL; try { url = new URL(endpoint); } catch { throw new CoreError('CONFIG_ERROR', 'Recall endpoint is invalid', 400); }
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && localEndpoint(endpoint)))) throw new CoreError('CONFIG_ERROR', 'Use HTTPS or an explicit local HTTP endpoint without credentials', 400);
  }
}
export class RecallSettingsStore {
  private writing = false;
  constructor(private readonly directory: string) {}
  private async credential(channel: 'embedding' | 'reranker') {
    const bytes = await regularRead(path.join(this.directory, `recall-${channel}.dpapi`), 32768);
    if (!bytes) return null;
    try {
      const value = JSON.parse(bytes.toString());
      if (value.version !== 1 || typeof value.endpoint !== 'string' || typeof value.protected_key !== 'string') throw new Error();
      return value as { version: 1; endpoint: string; protected_key: string };
    } catch { throw new CoreError('CONFIG_ERROR', 'Recall credential record is invalid', 400); }
  }
  async read() {
    const bytes = await regularRead(path.join(this.directory, 'recall-settings.json'), 16384);
    let settings: RecallSettings;
    try { settings = bytes ? JSON.parse(bytes.toString()) : { ...defaultRecallSettings }; } catch { throw new CoreError('CONFIG_ERROR', 'Recall settings JSON is invalid', 400); }
    validate(settings);
    const [embedding, reranker] = await Promise.all([this.credential('embedding'), this.credential('reranker')]);
    return { settings, api_key_configured: Boolean(settings.endpoint && embedding?.endpoint === endpointKey(settings.endpoint)), reranker_key_configured: Boolean(settings.reranker_endpoint && reranker?.endpoint === endpointKey(settings.reranker_endpoint)) };
  }
  async save(settings: RecallSettings, key?: string, rerankerKey?: string) {
    if (this.writing) throw new CoreError('JOB_BUSY', 'Recall settings are being saved', 409);
    this.writing = true;
    try {
      validate(settings);
      for (const [channel, endpoint, value] of [['embedding', settings.endpoint, key], ['reranker', settings.reranker_endpoint, rerankerKey]] as const) {
        if (value === undefined) continue;
        if (!value.trim() || Buffer.byteLength(value) > 8192 || !endpoint) throw new CoreError('CONFIG_ERROR', 'A recall credential requires a nonempty key and endpoint', 400);
        await atomicWrite(path.join(this.directory, `recall-${channel}.dpapi`), JSON.stringify({ version: 1, endpoint: endpointKey(endpoint), protected_key: (await crypt('protect', Buffer.from(value))).toString('base64') }));
      }
      await atomicWrite(path.join(this.directory, 'recall-settings.json'), JSON.stringify(settings));
      return this.read();
    } finally { this.writing = false; }
  }
  async key(channel: 'embedding' | 'reranker', endpoint: string) {
    const credential = await this.credential(channel);
    if (!credential || credential.endpoint !== endpointKey(endpoint)) {
      if (localEndpoint(endpoint)) return '';
      throw new CoreError('CONFIG_ERROR', 'Configure a separate credential for this recall endpoint', 400);
    }
    return (await crypt('unprotect', Buffer.from(credential.protected_key, 'base64'))).toString();
  }
}
