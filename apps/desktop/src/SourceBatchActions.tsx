import { useEffect, useRef, useState } from 'react';
import type { Source, SourceBatch, SourceBatchRequest } from '@engramweave/contracts';
import { client, failure, type Failure } from './client';
import { ErrorNotice } from './Feedback';

type Preview = Awaited<ReturnType<typeof client.discardPreview>>;
export function SourceBatchActions({ selected, clear, disabled, refresh, currentBatch }: { selected: Source[]; clear: () => void; disabled: boolean; refresh: () => void; currentBatch?: SourceBatch | null | undefined }) {
  const [batch, setBatch] = useState<SourceBatch | null>(null);
  const [error, setError] = useState<Failure>();
  const [previews, setPreviews] = useState<Preview[] | null>(null);
  const [references, setReferences] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const request = useRef<SourceBatchRequest | null>(null);
  const selectionKey = selected.map(item => `${item.path}:${item.revision}`).join('|');
  const running = batch?.status === 'running';
  useEffect(() => { if (currentBatch) setBatch(currentBatch); }, [currentBatch]);
  useEffect(() => { request.current = null; }, [selectionKey]);
  useEffect(() => {
    if (!running || !batch) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await client.sourceBatchStatus(batch.id);
        if (cancelled) return;
        setBatch(value); refresh();
        if (value.status === 'running') timer = setTimeout(() => { void poll(); }, 1000);
      } catch (error) { if (!cancelled) setError(failure(error)); }
    };
    timer = setTimeout(() => { void poll(); }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [running, batch?.id, refresh]);
  const submit = async (action: SourceBatchRequest['action']) => {
    setError(undefined); setLoading(true);
    if (request.current?.action !== action) request.current = null;
    request.current ??= { id: crypto.randomUUID(), action, items: selected.filter(source => source.revision).map(source => ({ path: source.path, revision: source.revision!, request_id: crypto.randomUUID(), ...(action === 'discard' ? { related: [...(previews?.find(preview => preview.source.path === source.path)?.drafts ?? []), ...(previews?.find(preview => preview.source.path === source.path)?.references.filter(target => references.includes(target.path)) ?? [])] } : {}) })) };
    try { setBatch(await client.sourceBatch(request.current)); request.current = null; setPreviews(null); clear(); refresh(); }
    catch (error) { setError(failure(error)); }
    finally { setLoading(false); }
  };
  const previewDiscard = async () => {
    setLoading(true); setError(undefined); request.current = null; setReferences([]);
    try { setPreviews(await Promise.all(selected.map(source => client.discardPreview(source.path)))); }
    catch (error) { setError(failure(error)); }
    finally { setLoading(false); }
  };
  const formal = [...new Map(previews?.flatMap(preview => preview.references).map(target => [target.path, target]) ?? []).values()];
  return <div className="source-batch-actions">
    {selected.length > 0 && <div className="selection-toolbar"><strong>{selected.length} selected</strong>
      <button disabled={disabled || loading || running} onClick={() => { void submit('compile'); }}>Compile selected</button>
      <button disabled={disabled || loading || running} onClick={() => { void previewDiscard(); }}>Discard selected</button>
      <button disabled={disabled || loading || running} onClick={() => { void submit('restore'); }}>Restore selected</button>
      <button disabled={loading || running} onClick={clear}>Clear selection</button>
    </div>}
    {previews && <div className="discard-confirmation" role="dialog" aria-label="Confirm Discard"><h3>Discard selected files</h3><p>标记 discarded，保留文件和处理阶段。未归档 Source 的相关 Draft 同步标记。</p>
      <ul>{previews.map(preview => <li key={preview.source.path}><strong>{preview.source.path}</strong>{preview.drafts.map(target => <span className="path" key={target.path}>{target.path}</span>)}</li>)}</ul>
      {formal.length > 0 && <fieldset><legend>Formal references · 默认保留，按需明确选择</legend>{formal.map(target => <label key={target.path}><input type="checkbox" checked={references.includes(target.path)} onChange={() => setReferences(current => current.includes(target.path) ? current.filter(value => value !== target.path) : [...current, target.path])} />{target.path}</label>)}</fieldset>}
      <button disabled={loading} onClick={() => { request.current = null; void submit('discard'); }}>Confirm Discard</button><button disabled={loading} onClick={() => setPreviews(null)}>Cancel</button>
    </div>}
    {batch && <details className="batch-summary"><summary>Batch · {batch.status} · {batch.items.filter(item => item.status === 'succeeded').length}/{batch.items.length} succeeded</summary><ul>{batch.items.map(item => <li key={item.path}>{item.path} · {item.status}{item.error ? ` · ${item.error.message}` : ''}</li>)}</ul></details>}
    {error && <ErrorNotice error={error} />}
  </div>;
}
