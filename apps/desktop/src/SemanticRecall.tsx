import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { RecallSettings, RecallStatus, RecallResponse } from '@engramweave/contracts';
import { client, failure, type Failure } from './client';
import { ErrorNotice } from './Feedback';
import './compiler.css';

function useIndexStatus(connected: boolean, generation?: number) {
  const [status, setStatus] = useState<RecallStatus>(); const [error, setError] = useState<Failure>(); const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!connected) { setStatus(undefined); return; }
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await client.recallStatus(); if (!cancelled) { setStatus(value); setError(undefined); if (value.state === 'running') timer = setTimeout(() => { void poll(); }, 1000); } }
      catch (error) { if (!cancelled) setError(failure(error)); }
    };
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [connected, generation, refresh]);
  return { status, error, reload: () => setRefresh(value => value + 1) };
}
function IndexStatus({ status }: { status: RecallStatus | undefined }) {
  return status ? <div className="semantic-status" role="status">
    <strong>Semantic Index · {status.state}</strong>
    <p className="hint">{status.indexed_documents} / {status.eligible_documents} notes · {status.indexed_chunks} passages · {status.stale_documents} stale · Generation {status.generation}</p>
    {status.state === 'running' && <p className="hint">Processed {status.processed_documents} · Embedded {status.embedded_chunks} · Reused {status.reused_chunks}</p>}
    {status.error && <p className="notice warning">{status.error}</p>}
    {status.stale_documents > 0 && <p className="notice warning">有未更新的材料。Refresh workspace 后更新；检索会排除已变化的旧片段。</p>}
  </div> : null;
}
export function SemanticSettings({ connected, generation, onIndexChange }: { connected: boolean; generation?: number | undefined; onIndexChange: () => void }) {
  const [settings, setSettings] = useState<RecallSettings>(); const [key, setKey] = useState(''); const [rerankerKey, setRerankerKey] = useState('');
  const [error, setError] = useState<Failure>(); const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  const { status, error: statusError, reload } = useIndexStatus(connected, generation);
  useEffect(() => {
    let cancelled = false;
    if (connected) void client.recallSettings().then(value => { if (!cancelled) setSettings(value.settings); }).catch(error => { if (!cancelled) setError(failure(error)); });
    else { setSettings(undefined); setKey(''); setRerankerKey(''); }
    return () => { cancelled = true; };
  }, [connected]);
  const update = <K extends keyof RecallSettings>(name: K, value: RecallSettings[K]) => { setSettings(current => current ? { ...current, [name]: value } : current); setMessage(''); };
  const action = async (operation: () => Promise<string>) => {
    setBusy(true); setError(undefined); setMessage('');
    try { setMessage(await operation()); reload(); onIndexChange(); } catch (error) { setError(failure(error)); } finally { setBusy(false); }
  };
  return <section className="compiler-settings">
    <h2>Semantic Recall</h2>
    <p className="hint">检索 Knowledge、Ideas、Research。首次明确建立索引；之后 Refresh workspace 增量更新。启动和普通编辑不调用 Embedding。</p>
    <p className="hint">本机优先。配置远端后，文档片段与查询会发送到该服务；不会沿用 Compiler 的 endpoint 或密钥。</p>
    {settings && <form className="compiler-form" onSubmit={event => { event.preventDefault(); void action(async () => { await client.saveRecallSettings(settings, key || undefined, rerankerKey || undefined); setKey(''); setRerankerKey(''); return 'Recall settings saved'; }); }}>
      <label>Embedding endpoint<input required type="url" value={settings.endpoint} onChange={e => update('endpoint', e.target.value)} /></label>
      <label>Embedding model<input required maxLength={512} value={settings.model} onChange={e => update('model', e.target.value)} placeholder="填写 /v1/models 返回的模型 ID" /></label>
      <label>Embedding API key<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder="本机可留空；留空保留已保存密钥" /></label>
      <label>Query instruction<input value={settings.query_instruction} maxLength={2000} onChange={e => update('query_instruction', e.target.value)} /></label>
      <label>Timeout (seconds)<input type="number" min={5} max={300} value={settings.timeout_seconds} onChange={e => update('timeout_seconds', Number(e.target.value))} /></label>
      <label>Candidates<input type="number" min={20} max={50} value={settings.candidates} onChange={e => update('candidates', Number(e.target.value))} /></label>
      <label><span><input type="checkbox" checked={settings.reranker_enabled} onChange={e => update('reranker_enabled', e.target.checked)} /> Enable Reranker by default</span></label>
      <label>Reranker endpoint<input type="url" value={settings.reranker_endpoint} onChange={e => update('reranker_endpoint', e.target.value)} /></label>
      <label>Reranker model<input maxLength={512} value={settings.reranker_model} onChange={e => update('reranker_model', e.target.value)} /></label>
      <label>Reranker API key<input type="password" autoComplete="off" value={rerankerKey} onChange={e => setRerankerKey(e.target.value)} placeholder="独立凭据；本机可留空" /></label>
      <div><button className="primary" disabled={busy || !connected}>Save Recall settings</button></div>
    </form>}
    <div className="connection-actions">
      <button disabled={!connected || busy} onClick={() => { void action(async () => { const result = await client.recallTest(); return `Service available · ${result.dimensions} dimensions · Reranker ${result.reranker}`; }); }}>Test services</button>
      <button disabled={!connected || busy || status?.state === 'running' || Boolean(status?.initialized)} onClick={() => { void action(async () => { await client.recallIndex('build'); return 'Semantic index build started'; }); }}>Build Semantic Index</button>
      <button disabled={!connected || busy || !status?.initialized || status.state === 'running' || status.state === 'rebuild_required'} onClick={() => { void action(async () => { await client.recallIndex('update'); return 'Semantic index update started'; }); }}>Update / Retry</button>
      <button disabled={!connected || busy || status?.state === 'running'} onClick={() => { void action(async () => { await client.recallIndex('rebuild'); return 'Semantic index rebuild started'; }); }}>Rebuild Semantic Index</button>
    </div>
    <p className="hint">建立索引前先 Refresh workspace 登记笔记。修改模型后需明确重建；查询策略与 Reranker 的修改无需重算文档向量。</p>
    {message && <p role="status">{message}</p>}
    {(error || statusError) && <ErrorNotice error={error ?? statusError!} />}
    <IndexStatus status={status} />
  </section>;
}
export function SemanticSearch({ connected, generation, query, setQuery, select }: { connected: boolean; generation?: number | undefined; query: string; setQuery: (value: string) => void; select: (path: string) => void }) {
  const [scope, setScope] = useState<'all' | 'knowledge' | 'ideas' | 'research'>('all');
  const [rerank, setRerank] = useState(false); const [result, setResult] = useState<RecallResponse>(); const [error, setError] = useState<Failure>(); const [busy, setBusy] = useState(false);
  const epoch = useRef(0); const { status, error: statusError } = useIndexStatus(connected, generation);
  useEffect(() => { let cancelled = false; if (connected) void client.recallSettings().then(value => { if (!cancelled) setRerank(value.settings.reranker_enabled); }).catch(() => {}); return () => { cancelled = true; epoch.current++; }; }, [connected]);
  const search = async (event: FormEvent) => {
    event.preventDefault(); const current = ++epoch.current; setBusy(true); setError(undefined); setResult(undefined);
    try { const value = await client.recall({ q: query, scope, rerank }); if (current === epoch.current) setResult(value); }
    catch (error) { if (current === epoch.current) setError(failure(error)); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  return <section>
    <p className="hint">查找含义相关、表达不同的笔记。结果是相关候选，不代表已成立的关系。</p>
    <form className="search-form" onSubmit={e => { void search(e); }}>
      <label>Scope<select value={scope} onChange={e => setScope(e.target.value as typeof scope)}><option value="all">Knowledge / Ideas / Research</option><option value="knowledge">Knowledge</option><option value="ideas">Ideas</option><option value="research">Research</option></select></label>
      <label className="query">Query<input maxLength={2000} value={query} onChange={e => setQuery(e.target.value)} placeholder="用自然语言描述你想找的材料" /></label>
      <label><span><input type="checkbox" checked={rerank} onChange={e => setRerank(e.target.checked)} /> Reranker</span></label>
      <button className="primary" disabled={!connected || busy || !status?.initialized || status.state === 'rebuild_required'}>{busy ? 'Searching…' : 'Semantic Search'}</button>
    </form>
    {(error || statusError) && <ErrorNotice error={error ?? statusError!} />}
    <IndexStatus status={status} />
    {result && <>
      <p className="hint">{new Set(result.items.map(hit => hit.path)).size} notes · {result.items.length} passages · Reranker {result.reranker} · {(result.timings.total_ms / 1000).toFixed(2)}s</p>
      {result.coverage.generation !== status?.generation && <p className="notice warning">索引已更新，请重新搜索。</p>}
      {result.diagnostics.map((d, i) => <p className="notice warning" key={i}>{d.message} {d.path}</p>)}
      {!result.items.length && <p className="empty">没有可用候选。有限覆盖和未召回不能证明没有联系。</p>}
      <div className="results">{result.items.map(hit => <article key={hit.chunk_id}>
        <div className="section-heading"><button className="text-button" onClick={() => select(hit.path)}>{hit.title}</button><span>{hit.kind === 'idea' ? 'Idea' : hit.kind === 'research' ? 'Research' : 'Knowledge'}</span></div>
        <p className="path">{hit.path} · Lines {hit.start_line}–{hit.end_line}</p>
        <p className="field-label">{hit.heading} · {hit.channels.join(' + ')} · Revision {hit.revision.slice(0, 12)}</p>
        <p className="snippet">{hit.text}</p>
        <button onClick={() => { void client.open(hit.path, 'obsidian').catch(error => setError(failure(error))); }}>Open in Obsidian</button>
      </article>)}</div>
    </>}
  </section>;
}
