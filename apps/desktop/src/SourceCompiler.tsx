import { useEffect, useRef, useState } from 'react';
import type { CompileRequest, Document, Draft } from '@engramweave/contracts';
import { client, failure, type Failure, type JobPage } from './client';
import { ErrorNotice } from './Feedback';
import './compiler.css';
import { lifecycleLabel } from './status-labels';

export function SourceCompiler({ document, jobs, active, onStarted, onPublished }: {
  document: Document; jobs: JobPage | null; active: boolean; onStarted: () => void; onPublished: () => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<Failure>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const request = useRef<CompileRequest | null>(null);
  const observedRun = useRef<string | null>(null);
  const latest = jobs?.items.find(job => job.kind === 'compile_source' && job.source_path === document.path);
  const latestStatus = latest?.status;
  useEffect(() => {
    let cancelled = false;
    void client.drafts(document.path).then(value => {
      if (!cancelled) {
        setDrafts(value.items);
        if (value.diagnostics.length) setError({ code: 'DRAFT_UNREADABLE', message: value.diagnostics.map(item => `${item.path}: ${item.message}`).join('\n') });
      }
    }).catch(error => { if (!cancelled) setError(failure(error)); });
    return () => { cancelled = true; };
  }, [document.path, document.revision, latestStatus]);
  useEffect(() => {
    if (latest?.kind !== 'compile_source') return;
    if (['queued', 'running'].includes(latest.status)) observedRun.current = latest.id;
    if (latest.status === 'succeeded' && observedRun.current === latest.id) {
      observedRun.current = null;
      onPublished();
    }
  }, [latest, document.revision, onPublished]);
  const compile = async () => {
    if (busy || document.kind !== 'source') return;
    setBusy(true); setError(undefined);
    request.current ??= { path: document.path, revision: document.revision, request_id: crypto.randomUUID() };
    try { const submitted = await client.compile(request.current); observedRun.current = submitted.job.id; request.current = null; onStarted(); }
    catch (error) { setError(failure(error)); }
    finally { setBusy(false); }
  };
  const draft = drafts.find(item => item.path === selected);
  return <section className="source-compiler">
    <div className="section-heading"><h3>Compiler / Drafts</h3><button className="primary" disabled={busy || active || document.kind !== 'source' || !['pending', 'compiled'].includes(document.processing_status ?? '') || document.lifecycle_status !== 'active'} onClick={() => { void compile(); }}>{busy ? 'Starting…' : 'Run Compiler'}</button></div>
    <p className="hint">每次成功编译新增 Draft，已有正文和用户编辑保留。这里只执行正文编译。</p>
    {latest && <p role="status">Last Compiler · {latest.status}</p>}
    {latest?.error && <ErrorNotice error={latest.error} />}
    {error && <ErrorNotice error={error} />}
    {drafts.length === 0 ? <p className="hint">尚无 Draft。</p> : <ul className="draft-list">{drafts.map(item => <li key={item.path}>
      <button onClick={() => setSelected(item.path)}>{item.title}</button><span>{lifecycleLabel(item.lifecycle_status)}</span>
      <button onClick={() => { void client.open(item.path, 'obsidian').catch(error => setError(failure(error))); }}>Open in Obsidian</button>
    </li>)}</ul>}
    {draft && <details className="draft-preview" open><summary>{draft.title}</summary><pre>{draft.body}</pre></details>}
  </section>;
}
