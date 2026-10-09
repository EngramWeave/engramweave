import path from 'node:path';
import { DateTime } from 'luxon';
import { Value } from '@sinclair/typebox/value';
import { ProcessingSettingsSchema, type ProcessingSettings } from '@engramweave/contracts';
import { atomicWrite, regularRead } from '../execution/settings.js';
import { CoreError } from '../errors.js';

export const defaultProcessingSettings = (): ProcessingSettings => ({ enabled: false, mode: 'daily', daily_time: '03:00',
  time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, interval_minutes: 60, max_retries: 2 });
export class ProcessingSettingsStore {
  private current: ProcessingSettings = defaultProcessingSettings();
  private writing = false;
  constructor(private readonly directory: string) {}
  read() { return structuredClone(this.current); }
  private validate(value: unknown): asserts value is ProcessingSettings {
    if (!Value.Check(ProcessingSettingsSchema, value) || !DateTime.now().setZone(value.time_zone).isValid) throw new CoreError('CONFIG_ERROR', 'Processing settings require a valid time zone, daily time, interval and retry bound', 400);
  }
  async initialize() {
    const bytes = await regularRead(path.join(this.directory, 'processing-settings.json'), 16384);
    if (!bytes) return;
    let value: unknown; try { value = JSON.parse(bytes.toString()); } catch { throw new CoreError('CONFIG_ERROR', 'Processing settings JSON is invalid', 400); }
    this.validate(value); this.current = value;
  }
  async save(value: ProcessingSettings) {
    if (this.writing) throw new CoreError('JOB_BUSY', 'Processing settings are being saved', 409);
    this.validate(value); this.writing = true;
    try { await atomicWrite(path.join(this.directory, 'processing-settings.json'), JSON.stringify(value)); this.current = structuredClone(value); return this.read(); }
    finally { this.writing = false; }
  }
}
