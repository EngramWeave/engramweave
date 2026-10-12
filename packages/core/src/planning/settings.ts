import path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { PlannerSettingsSchema, type Config, type PlannerSettings, type CompilerSettings } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { defaultSettings, validateSettings, atomicWrite, regularRead } from '../execution/settings.js';
import { PropertyNative } from '../files/property-native.js';
import { publishFile } from '../files/publication.js';
import { readVaultFile } from '../files/read.js';
import { writeCandidateFile } from '../files/properties.js';
import { parseTemplate } from '../analysis/templates.js';

export const plannerTemplate = `# Integration Planner\n\nIntegrate the selected Reviewed Draft and its own Intent into the current library. Respect submitted meaning, conditions and user understanding. Revalidate unapproved Relation suggestions; missing recall does not mean no relationship. Knowledge holds independently useful concepts/methods; Research holds context-specific results/evidence.\n\nThe Reviewed Draft and its Intent are the final authority for submitted content. Use Source for traceability and context, never to reintroduce material omitted or corrected by Human Review. Merge user understanding naturally into note prose without inventing user-judgment classifications or origin labels. Do not add AI review cautions, verification reminders or advisory commentary to formal prose unless the Reviewed Draft or explicit Intent calls for that content.\n\nInspect relevant notes and existing folders with task tools. Propose one coherent ChangeSet of final Markdown files, folders and discarded markers. Create/update/split/merge are outcomes, never separate modes. Preserve useful content, Properties and previous source links; add the submitted Source Record link to the sources Property of each written note. New top-level domains require explicit approval. Never delete or modify formal files.\n\nUse write_file or edit_file for candidates and propose_structure for directories/discard. Cite only delivered evidence with exact path, revision and lines. Return the assigned changeset_id and a brief summary after the complete proposal is present; Core validates and publishes it.\n`;
export const defaultPlannerSettings: PlannerSettings = { enabled: false, model: '', codex_path: '', reasoning_effort: 'default', timeout_seconds: 600, relation_template_path: null };
export const plannerExecution = (settings: PlannerSettings): CompilerSettings => ({ ...defaultSettings, route: 'codex', model: settings.model, codex_path: settings.codex_path, reasoning_effort: settings.reasoning_effort, timeout_seconds: settings.timeout_seconds });
export class PlannerSettingsStore {
  private value = { ...defaultPlannerSettings };
  constructor(private readonly config: Config) {}
  private filename() { return path.join(this.config.data_dir, 'planner-settings.json'); }
  async initialize() {
    const bytes = await regularRead(this.filename(), 32768);
    if (bytes) { const value = JSON.parse(bytes.toString()); this.validate(value); this.value = value; }
  }
  private async ensureTemplate() {
    const native = new PropertyNative();
    try {
      await native.ensureTaskDirectory(this.config.vault_path, '90_System/Prompts');
      try { await readVaultFile(this.config.vault_path, '90_System/Prompts/Planner.md'); }
      catch (error) { if (!(error instanceof CoreError && error.code === 'DOCUMENT_NOT_FOUND')) throw error; await publishFile(this.config.vault_path, '90_System/Prompts/Planner.md', Buffer.from(plannerTemplate)); }
    } finally { await native.close(); }
  }
  private validate(value: unknown): asserts value is PlannerSettings {
    if (!Value.Check(PlannerSettingsSchema, value)) throw new CoreError('CONFIG_ERROR', 'Invalid Planner settings', 400);
    validateSettings(plannerExecution(value));
    if (value.enabled && !value.codex_path) throw new CoreError('CONFIG_ERROR', 'Enabled Planner requires an absolute Codex executable', 400);
  }
  read() { return { ...this.value }; }
  async save(value: PlannerSettings) { this.validate(value); await atomicWrite(this.filename(), JSON.stringify(value)); this.value = { ...value }; return this.read(); }
  async template() {
    await this.ensureTemplate();
    const file = await readVaultFile(this.config.vault_path, '90_System/Prompts/Planner.md');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
    if (!content.trim() || file.size > 64000) throw new CoreError('CONFIG_ERROR', 'Planner template must contain 1–64000 bytes', 400);
    const settings = this.read(); let relation: { path: string; content: string; revision: string } | null = null;
    if (settings.relation_template_path) {
      const selected = await readVaultFile(this.config.vault_path, settings.relation_template_path);
      const selectedContent = new TextDecoder('utf-8', { fatal: true }).decode(selected.bytes); parseTemplate(selectedContent);
      relation = { path: settings.relation_template_path, content: selectedContent, revision: selected.revision };
    }
    return { content, revision: file.revision, relation };
  }
  async saveTemplate(input: { content: string; revision: string }) {
    if (!input.content.trim() || Buffer.byteLength(input.content) > 64000) throw new CoreError('VALIDATION_ERROR', 'Invalid Planner template size', 400);
    const file = await readVaultFile(this.config.vault_path, '90_System/Prompts/Planner.md');
    if (file.revision !== input.revision) throw new CoreError('SOURCE_CHANGED', 'Planner template changed; reload it', 409);
    const native = new PropertyNative();
    try { const saved = await writeCandidateFile(this.config.vault_path, '90_System/Prompts/Planner.md', file, Buffer.from(input.content), native); return { content: input.content, revision: saved.revision }; }
    finally { await native.close(); }
  }
}
