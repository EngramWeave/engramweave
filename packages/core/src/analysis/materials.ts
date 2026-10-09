import type { AnalysisCitationSchema } from '@engramweave/contracts';
import type { Static } from '@sinclair/typebox';
import type { AnalysisSnapshot, AnalysisEvidence } from './input.js';
import { CoreError } from '../errors.js';

type Citation = Static<typeof AnalysisCitationSchema>;
type Segment = { id: string; text: string };

/** Task-local IDs address exactly the text delivered, not arbitrary Vault files. */
export class AnalysisMaterials {
  private readonly citations = new Map<string, Citation>();
  private readonly libraryIds = new Map<string, string>();
  private readonly input: { source: { title: string; segments: Segment[] }; draft: { title: string; segments: Segment[] } };
  constructor(snapshot: AnalysisSnapshot) {
    this.input = { source: { title: snapshot.input.source.title, segments: this.segments(snapshot.input.source, 'S') },
      draft: { title: snapshot.input.draft.title, segments: this.segments(snapshot.input.draft, 'D') } };
  }
  private segments(input: AnalysisSnapshot['input']['draft'], prefix: string): Segment[];
  private segments(input: AnalysisSnapshot['input']['source'], prefix: string): Segment[];
  private segments(input: { path: string; revision: string; numbered_lines: string[] }, prefix: string): Segment[] {
    const segments: Segment[] = []; let start = 1; let lines: string[] = []; let size = 0;
    const flush = () => {
      if (!lines.length) return;
      const id = `${prefix}${segments.length + 1}`;
      segments.push({ id, text: lines.join('\n') });
      this.citations.set(id, { path: input.path, revision: input.revision, start_line: start, end_line: start + lines.length - 1 });
      start += lines.length; lines = []; size = 0;
    };
    for (const numbered of input.numbered_lines) {
      const text = numbered.replace(/^\d+: /, '');
      if (lines.length && (size + text.length > 1500 || lines.length >= 40)) flush();
      lines.push(text); size += text.length + 1;
      if (!text.trim()) flush();
    }
    flush(); return segments;
  }
  library(evidence: AnalysisEvidence) {
    return { items: evidence.items.map(item => {
      const key = JSON.stringify([item.path, item.revision, item.chunk_id, item.start_line, item.end_line]);
      let id = this.libraryIds.get(key);
      if (!id) {
        id = `K${this.libraryIds.size + 1}`; this.libraryIds.set(key, id);
        this.citations.set(id, { path: item.path, revision: item.revision, start_line: item.start_line, end_line: item.end_line });
      }
      return { id, chunk_id: item.chunk_id, title: item.title, kind: item.kind, heading: item.heading, text: item.text };
    }) };
  }
  readInput(evidence: AnalysisEvidence) { return { ...this.input, library: this.library(evidence) }; }
  resolve(id: string): Citation {
    const citation = this.citations.get(id);
    if (!citation) throw new CoreError('INVALID_MODEL_OUTPUT', 'Analyzer referenced an unknown evidence ID; only IDs delivered in this task are permitted', 422);
    return { ...citation };
  }
}
