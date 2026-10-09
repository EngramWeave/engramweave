import path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { AnalysisSettingsSchema, type AnalysisSettings, type AnalysisProfile } from '@engramweave/contracts';
import { atomicWrite, regularRead, crypt, endpointKey, localEndpoint, validateSettings } from '../execution/settings.js';
import { CoreError } from '../errors.js';

export class AnalysisSettingsStore {
  private writing = false;
  constructor(private readonly directory: string) {}
  private validate(settings: AnalysisSettings) {
    if (!Value.Check(AnalysisSettingsSchema, settings) || new Set(settings.profiles.map(p => p.id)).size !== settings.profiles.length
      || settings.default_profile !== null && !settings.profiles.some(p => p.id === settings.default_profile)) throw new CoreError('CONFIG_ERROR', 'Invalid or duplicate Analysis Profile references', 400);
    for (const profile of settings.profiles) for (const task of ['review','relation'] as const) {
      validateSettings(profile[task].execution);
      if (!profile[task].template_path.startsWith(`90_System/Prompts/${task === 'review' ? 'Review' : 'Relation'}/`)) throw new CoreError('CONFIG_ERROR', 'Template belongs to another Analyzer', 400);
    }
  }
  private credentialPath(id: string, task: 'review' | 'relation') {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new CoreError('CONFIG_ERROR', 'Invalid Profile ID', 400);
    return path.join(this.directory, `analysis-${id}-${task}.dpapi`);
  }
  private async credential(id: string, task: 'review' | 'relation') {
    const bytes = await regularRead(this.credentialPath(id, task), 32768);
    if (!bytes) return null;
    try { const record = JSON.parse(bytes.toString()); if (record.version !== 1 || typeof record.endpoint !== 'string' || typeof record.protected_key !== 'string') throw new Error(); return record as { endpoint: string; protected_key: string }; }
    catch { throw new CoreError('CONFIG_ERROR', 'Analyzer credential record is invalid', 400); }
  }
  async read() {
    const bytes = await regularRead(path.join(this.directory, 'analysis-settings.json'), 400_000);
    let settings: AnalysisSettings;
    try { settings = bytes ? JSON.parse(bytes.toString()) : { default_profile: null, profiles: [] }; } catch { throw new CoreError('CONFIG_ERROR', 'Analysis settings JSON is invalid', 400); }
    this.validate(settings);
    const credentials = await Promise.all(settings.profiles.map(async p => {
      const [review, relation] = await Promise.all([this.credential(p.id, 'review'), this.credential(p.id, 'relation')]);
      return { profile_id: p.id, review: Boolean(p.review.execution.endpoint && review?.endpoint === endpointKey(p.review.execution.endpoint)), relation: Boolean(p.relation.execution.endpoint && relation?.endpoint === endpointKey(p.relation.execution.endpoint)) };
    }));
    return { settings, credentials };
  }
  async save(settings: AnalysisSettings, credentials: { profile_id: string; task: 'review' | 'relation'; api_key: string }[] = []) {
    if (this.writing) throw new CoreError('JOB_BUSY', 'Analysis settings are being saved', 409);
    this.writing = true;
    try {
      this.validate(settings);
      for (const value of credentials) {
        const profile = settings.profiles.find(p => p.id === value.profile_id);
        const endpoint = profile?.[value.task]?.execution.endpoint;
        if (!endpoint || !value.api_key.trim() || Buffer.byteLength(value.api_key) > 8192) throw new CoreError('CONFIG_ERROR', 'Analyzer credential needs a configured Profile and endpoint', 400);
        await atomicWrite(this.credentialPath(value.profile_id, value.task), JSON.stringify({ version: 1, endpoint: endpointKey(endpoint), protected_key: (await crypt('protect', Buffer.from(value.api_key))).toString('base64') }));
      }
      await atomicWrite(path.join(this.directory, 'analysis-settings.json'), JSON.stringify(settings), 400_000);
      return this.read();
    } finally { this.writing = false; }
  }
  async select(id?: string): Promise<AnalysisProfile> {
    const { settings } = await this.read();
    const profile = settings.profiles.find(p => p.id === (id ?? settings.default_profile));
    if (!profile) throw new CoreError('CONFIG_ERROR', 'Select an existing Analysis Profile or configure an explicit default', 400);
    return profile;
  }
  async key(id: string, task: 'review' | 'relation', endpoint: string) {
    const credential = await this.credential(id, task);
    if (!credential || credential.endpoint !== endpointKey(endpoint)) {
      if (localEndpoint(endpoint)) return '';
      throw new CoreError('CONFIG_ERROR', 'Configure a separate credential for this Analyzer endpoint', 400);
    }
    return (await crypt('unprotect', Buffer.from(credential.protected_key, 'base64'))).toString();
  }
}
