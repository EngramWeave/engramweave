import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Source, SourceBatch, SourceBatchRequest } from '@engramweave/contracts';
import { client, failure, type Failure } from './client';
import { ErrorToast } from './Feedback';

type Preview = Awaited<ReturnType<typeof client.discardPreview>>;
type Action = SourceBatchRequest['action'];
function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="source-action-dialog" aria-label={title} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="section-heading"><h3>{title}</h3><button aria-label="Close dialog" onClick={close}>×</button></div>{children}
  </dialog>;
}
export function SourceBatchActions({ selected, clear, disabled, refresh, currentBatch, discardedView }: { selected: Source[]; clear: () => void; disabled: boolean; refresh: () => void; currentBatch?: SourceBatch | null | undefined; discardedView: boolean }) {
  const [batch, setBatch] = useState<SourceBatch | null>(null);
  const [error, setError] = useState<Failure>();
  const [previews, setPreviews] = useState<Preview[] | null>(null);
  const [action, setAction] = useState<Action>('discard');
  const [choices, setChoices] = useState<string[]>([]);
  const [references, setReferences] = useState<string[]>([]);
  const [deleteTargets, setDeleteTargets] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [notification, setNotification] = useState<SourceBatch | null>(null);
  const [showResult, setShowResult] = useState(false);
  const request = useRef<SourceBatchRequest | null>(null);
  const observed = useRef<string | null>(null);
  const selectionKey = selected.map(item => `${item.path}:${item.revision}`).join('|');
  const running = batch?.status === 'running';
  useEffect(() => { if (currentBatch) setBatch(currentBatch); }, [currentBatch]);
  useEffect(() => { request.current = null; }, [selectionKey]);
  useEffect(() => {
    if (!batch) return;
    if (batch.status === 'running') observed.current = batch.id;
    if (observed.current === batch.id) setNotification(batch);
  }, [batch]);
  useEffect(() => {
    if (!notification || notification.status === 'running') return;
    const timer = setTimeout(() => setNotification(null), 8000);
    return () => clearTimeout(timer);
  }, [notification]);
  useEffect(() => {
    if (!running || !batch) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await client.sourceBatchStatus(batch.id);
        if (cancelled) return;
        setBatch(value); refresh();
        if (value.status === 'running') timer = setTimeout(() => { void poll(); }, batch.action === 'compile' ? 1000 : 200);
      } catch (error) { if (!cancelled) setError(failure(error)); }
    };
    timer = setTimeout(() => { void poll(); }, batch.action === 'compile' ? 500 : 100);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [running, batch?.id, refresh]);
  const submit = async (operation: Action) => {
    setError(undefined); setLoading(true);
    if (request.current?.action !== operation) request.current = null;
    request.current ??= { id: crypto.randomUUID(), action: operation, items: selected.filter(source => source.revision && (operation !== 'delete' || deleteTargets.includes(source.path)) && (operation !== 'discard_drafts' || previews?.find(preview => preview.source.path === source.path)?.drafts.some(target => choices.includes(target.path)))).map(source => {
      const preview = previews?.find(preview => preview.source.path === source.path);
      return { path: source.path, revision: source.revision!, request_id: crypto.randomUUID(),
        ...(operation === 'discard' ? { related: [...(source.processing_status === 'archived' ? [] : preview?.drafts ?? []), ...(preview?.references.filter(target => references.includes(target.path)) ?? [])].map(({ path, revision }) => ({ path, revision })) } : {}),
        ...(operation === 'discard_drafts' ? { related: preview?.drafts.filter(target => choices.includes(target.path)).map(({ path, revision }) => ({ path, revision })) ?? [] } : {}),
        ...(operation === 'delete' && preview?.references.length ? { allow_referenced: true, reference_revisions: preview.references } : {}),
      };
    }) };
    try {
      const value = await client.sourceBatch(request.current); observed.current = value.id; setBatch(value); setNotification(value);
      request.current = null; setPreviews(null); clear(); refresh();
    } catch (error) { setError(failure(error)); }
    finally { setLoading(false); }
  };
  const previewAction = async (operation: Action) => {
    setLoading(true); setError(undefined); request.current = null; setReferences([]); setAction(operation);
    try {
      const value = await Promise.all(selected.map(source => client.discardPreview(source.path)));
      setPreviews(value); setChoices([...new Set(value.flatMap(preview => preview.drafts.map(target => target.path)))]);
      setDeleteTargets(value.filter(preview => preview.references.length === 0).map(preview => preview.source.path));
    } catch (error) { setError(failure(error)); }
    finally { setLoading(false); }
  };
  const toggle = (current: string[], value: string) => current.includes(value) ? current.filter(item => item !== value) : [...current, value];
  const formal = [...new Map(previews?.flatMap(preview => preview.references).map(target => [target.path, target]) ?? []).values()];
  const draftPaths = [...new Set(previews?.flatMap(preview => preview.drafts.map(target => target.path)) ?? [])];
  const title = action === 'discard_drafts' ? 'Discard Drafts' : action === 'delete' ? 'Delete permanently' : 'Confirm Discard';
  const blocked = disabled || loading || running || !selected.length;
  return <div className="source-batch-actions">
    <div className="selection-toolbar"><strong>{selected.length ? `${selected.length} selected` : 'Select Sources for batch actions'}</strong>
      {discardedView ? <>
        <button disabled={blocked} onClick={() => { void previewAction('delete'); }}>Delete permanently</button>
        <button disabled={blocked} onClick={() => { void submit('restore'); }}>Restore selected</button>
      </> : <>
        <button disabled={blocked} onClick={() => { void submit('compile'); }}>Compile selected</button>
        <button disabled={blocked} onClick={() => { void previewAction('discard'); }}>Discard selected</button>
        <button disabled={blocked} onClick={() => { void previewAction('discard_drafts'); }}>Discard Drafts</button>
      </>}
      <button disabled={loading || running || !selected.length} onClick={clear}>Clear selection</button>
      {loading && <span role="status">Loading…</span>}
    </div>
    {previews && <Modal title={title} close={() => { if (!loading) setPreviews(null); }}>
      <p>{action === 'discard_drafts' ? '勾选需要标记 discarded 的 Draft。文件、Source 和处理阶段保留。' : action === 'delete' ? '永久删除以下 Source Record 及其 inline 正文，无法撤销。关联 Draft 与外部或未证明专属的 Asset 保留；正式知识链接不会自动修复。' : '标记 Source 为 discarded，保留文件和阶段。未归档 Source 的 active Draft 同步标记；已 discarded 的 Draft 不重复列出。'}</p>
      {action === 'discard_drafts' && <label className="select-all-drafts"><input type="checkbox" checked={draftPaths.length > 0 && choices.length === draftPaths.length} onChange={() => setChoices(choices.length === draftPaths.length ? [] : draftPaths)} />Select all Drafts ({draftPaths.length})</label>}
      <div className="action-targets">{previews.map(preview => <div key={preview.source.path} className="action-source">
        {action === 'delete' ? <label><input type="checkbox" checked={deleteTargets.includes(preview.source.path)} onChange={() => setDeleteTargets(current => toggle(current, preview.source.path))} /><strong>{preview.source.path}</strong></label> : <strong>{preview.source.path}</strong>}
        {action === 'delete' && preview.references.length > 0 && <div className="reference-warning">Active formal references · 默认跳过，勾选此 Source 表示确认保留坏链：<ul>{preview.references.map(target => <li key={target.path}>{target.path}</li>)}</ul></div>}
        {action !== 'delete' && !(action === 'discard' && selected.find(source => source.path === preview.source.path)?.processing_status === 'archived') && preview.drafts.map(target => action === 'discard_drafts' ? <label key={target.path}><input type="checkbox" aria-label={target.path} checked={choices.includes(target.path)} onChange={() => setChoices(current => toggle(current, target.path))} /><span>{target.title || target.path}<small className="path">{target.path}</small></span></label> : <span className="path" key={target.path}>{target.title ? `${target.title} · ` : ''}{target.path}</span>)}
      </div>)}</div>
      {action === 'discard' && formal.length > 0 && <fieldset><legend>Formal references · 默认保留，按需选择</legend>{formal.map(target => <label key={target.path}><input type="checkbox" checked={references.includes(target.path)} onChange={() => setReferences(current => toggle(current, target.path))} />{target.path}</label>)}</fieldset>}
      {action === 'discard_drafts' && !draftPaths.length && <p>No active Drafts.</p>}
      <div className="dialog-actions"><button disabled={loading || action === 'discard_drafts' && !choices.length || action === 'delete' && !deleteTargets.length} onClick={() => { request.current = null; void submit(action); }}>{action === 'delete' ? 'Confirm permanent deletion' : action === 'discard_drafts' ? 'Confirm Discard Drafts' : 'Confirm Discard'}</button><button disabled={loading} onClick={() => setPreviews(null)}>Cancel</button></div>
    </Modal>}
    {notification && <div className="batch-toast" role="status"><strong>Batch · {notification.status}</strong><span>{notification.items.filter(item => item.status === 'succeeded').length}/{notification.items.length} succeeded{notification.items.some(item => item.error) ? ' · Some items need attention' : ''}</span><button onClick={() => setShowResult(true)}>View results</button><button aria-label="Dismiss batch notification" onClick={() => setNotification(null)}>×</button></div>}
    {showResult && batch && <Modal title="Batch results" close={() => setShowResult(false)}><ul className="batch-results">{batch.items.map(item => <li key={item.path}>{item.path} · {item.status}{item.error ? ` · ${item.error.message}` : ''}</li>)}</ul></Modal>}
    <ErrorToast error={error} dismiss={() => setError(undefined)} />
  </div>;
}
