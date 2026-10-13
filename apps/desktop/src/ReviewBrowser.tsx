import { useEffect, useMemo, useRef, useState } from 'react';
import type { Draft, DraftReview, ReviewBrowserQuery, ReviewFile } from '@engramweave/contracts';
import { client, failure, type Failure } from './client';
import { ErrorNotice } from './Feedback';
import { processingLabel, processingTone, lifecycleLabel } from './status-labels';
import { FileEmpty, FilePagination, FileSearch, FileStats, FileTabs, fileDate, useFileList, type FileCategory } from './FileBrowserUI';
import { Icon } from './Icon';

const categories: FileCategory[] = [
  { id: 'all', title: 'All Drafts', caption: 'Active files and issues', tone: 'blue', icon: 'file' },
  { id: 'to_review', title: 'To Review', caption: 'Compiled Sources', tone: 'orange', icon: 'list' },
  { id: 'reviewed', title: 'Reviewed', caption: 'Selected for integration', tone: 'violet', icon: 'check' },
  { id: 'planned', title: 'Planned', caption: 'A proposal is available', tone: 'green', icon: 'branch' },
  { id: 'issues', title: 'Issues', caption: 'Files or linked Sources', tone: 'red', icon: 'help' },
  { id: 'discarded', title: 'Discarded', caption: 'Retained Draft files', tone: 'slate', icon: 'trash' },
];
export function ReviewBrowser({ connected, refreshKey, active, focus, source, change, jobs, started, onFailure }: {
  connected: boolean; refreshKey: string; active: boolean; focus: string | null; source: (path: string) => void; change: (id: string) => void; jobs: (id?: string) => void; started: () => void; onFailure: (error: Failure) => void;
}) {
  const [query, setQuery] = useState<ReviewBrowserQuery>({ view: 'all', sort: 'title_asc' });
  const [offset, setOffset] = useState(0); const input = useMemo(() => ({ ...query, limit: 20, offset }), [query, offset]);
  const list = useFileList(client.reviewFiles, input, connected, refreshKey, onFailure);
  const [path, setPath] = useState<string | null>(focus); const [draft, setDraft] = useState<Draft>(); const [review, setReview] = useState<DraftReview>();
  const [related, setRelated] = useState<Awaited<ReturnType<typeof client.changeFiles>>>();
  const [error, setError] = useState<Failure>(); const [tab, setTab] = useState('Preview'); const [working, setWorking] = useState(false); const [message, setMessage] = useState('');
  const pendingPlan = useRef<Parameters<typeof client.plan>[0] | null>(null); const pendingAnalysis = useRef<Parameters<typeof client.analyze>[0] | null>(null);
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (focus) { setPath(focus); setQuery({ view: 'all', sort: 'title_asc', path: focus }); setOffset(0); } }, [focus]);
  useEffect(() => {
    setDraft(undefined); setReview(undefined); setRelated(undefined); setError(undefined); pendingPlan.current = null; pendingAnalysis.current = null;
    if (!connected || !path) return;
    let cancelled = false;
    void client.draft(path).then(async value => {
      if (cancelled) return; setDraft(value); if (query.path === value.path) setQuery(current => ({ ...current, view: value.lifecycle_status === 'discarded' ? 'discarded' : 'all' }));
      const results = await Promise.allSettled([client.draftReview(path), value.sources[0] ? client.changeFiles({ source_path: value.sources[0], limit: 100 }) : Promise.resolve(undefined)]);
      if (cancelled) return;
      const current = results[0]; if (current.status === 'fulfilled') setReview(current.value); else setError(failure(current.reason));
      const changes = results[1]; if (changes.status === 'fulfilled') setRelated(changes.value); else setError(failure(changes.reason));
    }).catch(error => { if (!cancelled) setError(failure(error)); });
    return () => { cancelled = true; };
  }, [connected, path, query.path, refreshKey, list.revision]);
  const update = (next: ReviewBrowserQuery) => { setQuery(next); setOffset(0); };
  const run = async (work: () => Promise<void>) => {
    if (working) return; setWorking(true); setError(undefined); setMessage('');
    try { await work(); } catch (error) { if (alive.current) setError(failure(error)); }
    finally { if (alive.current) setWorking(false); }
  };
  const analyze = (task?: 'review' | 'relation') => run(async () => {
    if (!path) return; const current = await client.draftReview(path);
    if (pendingAnalysis.current?.task !== task) pendingAnalysis.current = null;
    pendingAnalysis.current ??= { request_id: crypto.randomUUID(), source_path: current.source.path, source_revision: current.source.revision, draft_path: current.draft.path, draft_revision: current.draft.revision, ...(task ? { task } : {}) };
    await client.analyze(pendingAnalysis.current); pendingAnalysis.current = null; started(); setMessage('Analysis started. Draft body is preserved.');
  });
  const selected = review?.human_review?.selected_draft === path;
  const stage = review?.source.kind === 'source' ? review.source.processing_status : null;
  const canAnalyze = draft?.lifecycle_status === 'active' && review?.source.lifecycle_status === 'active' && ['compiled', 'reviewed'].includes(stage ?? '');
  const row = list.page?.items.find(item => item.path === path);
  return <div className="sources-page file-browser review-browser">
    <FileStats categories={categories} counts={list.page?.views} view={query.view ?? 'all'} connected={connected} change={view => { update({ ...query, view: view as NonNullable<ReviewBrowserQuery['view']> }); }} />
    <div className="sources-layout"><section className="source-list panel" aria-label="Drafts list">
      <div className="source-toolbar"><FileSearch label="Search Drafts" placeholder="Search Drafts or Sources…" value={query.q ?? ''} disabled={!connected} change={q => update({ ...query, q })} />
        <details className="source-filter-menu"><summary>+ Filter ▾</summary><div className="filter-popover"><label>Source stage<select value={query.stages ?? ''} onChange={e => { const next = { ...query }; if (e.target.value) next.stages = e.target.value; else delete next.stages; update(next); }}><option value="">All stages</option>{['pending', 'compiled', 'reviewed', 'planned', 'archived'].map(stage => <option key={stage}>{stage}</option>)}</select></label>
          <label>Analysis<select value={query.analysis ?? ''} onChange={e => { const next = { ...query }; if (e.target.value) next.analysis = e.target.value as NonNullable<ReviewBrowserQuery['analysis']>; else delete next.analysis; update(next); }}><option value="">All results</option>{['none', 'running', 'complete', 'partial', 'failed', 'stale'].map(state => <option key={state}>{state}</option>)}</select></label><label>Source path<input placeholder="20_Sources/…" value={query.source_path ?? ''} onChange={e => { const next = { ...query }; if (e.target.value) next.source_path = e.target.value; else delete next.source_path; update(next); }} /></label></div></details>
        <select aria-label="Sort Drafts" value={query.sort} onChange={e => update({ ...query, sort: e.target.value as NonNullable<ReviewBrowserQuery['sort']> })}><option value="title_asc">Sort · Title A–Z</option><option value="updated_desc">Sort · Recently updated</option><option value="updated_asc">Sort · Oldest updated</option></select>
      </div><div className="file-list-actions"><span>{list.loading ? 'Loading…' : 'Current Draft files · Read only'}</span><button disabled={!connected || list.loading} onClick={() => { list.refresh(); started(); }}>Refresh Drafts</button>{(query.stages || query.analysis || query.source_path) && <button onClick={() => update({ view: query.view ?? 'all', sort: query.sort ?? 'title_asc' })}>Clear filters</button>}</div>
      {list.error && <ErrorNotice error={list.error} />}
      <div className="filter-chips">{query.stages && <button className="filter-chip" onClick={() => { const next = { ...query }; delete next.stages; update(next); }}>Stage · {query.stages} ×</button>}{query.analysis && <button className="filter-chip" onClick={() => { const next = { ...query }; delete next.analysis; update(next); }}>Analysis · {query.analysis} ×</button>}{query.source_path && <button className="filter-chip" onClick={() => { const next = { ...query }; delete next.source_path; update(next); }}>Source · {query.source_path} ×</button>}</div>
      {query.path && <button className="filter-chip" onClick={() => { const next = { ...query }; delete next.path; update(next); }}>Focused Draft · {query.path} ×</button>}
      <div className="table-scroll"><table className="file-table"><thead><tr><th>Draft</th><th>Source</th><th>Source stage</th><th>Analysis</th><th>Lifecycle</th><th>Updated</th></tr></thead><tbody>{list.page?.items.map(item => <tr key={item.path} className={path === item.path ? 'selected' : ''}>
        <td><button className="row-copy row-select" onClick={() => { setPath(item.path); setTab('Preview'); }}><span className="row-title">{item.title}</span><span className="row-meta" title={item.path}>{item.path}</span></button>{item.selected && <span className="state-tag violet">Selected</span>}{item.diagnostics.length > 0 && <span className="state-tag red">Needs attention</span>}</td>
        <td><span className="row-title" title={item.source_path ?? ''}>{item.source_title ?? item.source_path ?? '—'}</span></td>
        <td><span className={`state-tag ${processingTone(item.source_stage)}`}>{processingLabel(item.source_stage)}</span></td><td><span className={`state-tag ${item.analysis === 'failed' ? 'red' : item.analysis === 'stale' ? 'orange' : 'blue'}`}>{item.analysis}</span></td>
        <td><span className={`state-tag ${item.lifecycle_status === 'active' ? 'green' : 'slate'}`}>{lifecycleLabel(item.lifecycle_status)}</span></td><td className="row-meta" title={fileDate(item.updated_at)}>{item.updated_at ? new Date(item.updated_at).toLocaleDateString() : '—'}</td>
      </tr>)}</tbody></table></div>
      {!list.loading && !list.page?.items.length && <p className="empty">{connected ? '没有符合条件的 Draft。' : '连接 Core 后查看 Draft 文件。'}</p>}
      {list.page && <FilePagination total={list.page.total} offset={offset} setOffset={setOffset} loading={list.loading} label="Drafts" />}
      {query.view === 'discarded' && <p className="hint">保留的旧稿可预览。独立恢复与清理暂不可用。</p>}
    </section><div className="source-inspector">{path ? <aside className="panel file-inspector">
      <div className="section-heading"><h2>{draft?.title ?? row?.title ?? 'Draft'}</h2><button aria-label="Close Draft details" onClick={() => setPath(null)}>×</button></div><p className="path">{path}</p>
      <div className="file-actions"><button disabled={!connected || working} onClick={() => { void run(() => client.open(path, 'obsidian')); }}>Open Draft in Obsidian</button>{draft?.sources[0] && <button onClick={() => source(draft.sources[0]!)}>View Source</button>}</div>
      {error && <ErrorNotice error={error} />}{row?.diagnostics.map((error, index) => <ErrorNotice key={index} error={error} />)}{message && <p role="status">{message}</p>}
      <FileTabs tabs={['Preview', 'Context', 'Analysis', 'Properties']} tab={tab} setTab={setTab} />
      {tab === 'Preview' && (draft ? <pre className="file-preview">{draft.body}</pre> : <p className="hint">正文读取不可用；可在 Obsidian 检查文件。</p>)}
      {tab === 'Properties' && draft && <pre className="file-preview">{JSON.stringify(draft.metadata, null, 2)}</pre>}
      {tab === 'Context' && <><h3>Review selection</h3><p>{review?.human_review?.selected_draft ?? 'No current selection'}{selected ? ' · This Draft' : ''}</p><h3>Integration Intent</h3><p className="file-text">{review?.human_review?.intent ?? '尚无已提交 Intent。'}</p><h3>Source Annotation</h3><p className="file-text">{review?.source.annotation || '—'}</p>{review?.source.kind === 'source' && review.source.original_locator && <p className="path">{review.source.original_locator}</p>}
        <h3>Related Drafts</h3>{review?.related_drafts.map(item => <button className="file-link" key={item.path} onClick={() => setPath(item.path)}>{item.title}</button>)}
        <h3>ChangeSets</h3>{related?.items.length ? related.items.map(item => <button className="file-link" key={item.id} onClick={() => change(item.id)}>{item.title} · {item.state}</button>) : <p className="hint">No existing ChangeSet.</p>}
        <button disabled={!connected || active || working || !selected || stage !== 'reviewed'} onClick={() => { void run(async () => { const current = await client.draftReview(path); if (current.human_review?.selected_draft !== path) throw new Error('Reviewed Draft selection changed. Refresh before planning.'); pendingPlan.current ??= { request_id: crypto.randomUUID(), source_path: current.source.path, source_revision: current.source.revision }; await client.plan(pendingPlan.current); pendingPlan.current = null; started(); setMessage('Planner started.'); }); }}>Run Integration Planner</button>
      </>}
      {tab === 'Analysis' && <>{(['review', 'relation'] as const).map(task => { const job = review?.analyses?.[task]; const result = job?.[task]; return <section key={task}><h3>{task === 'review' ? 'Review Analyzer' : 'Relation Analyzer'}</h3><p>{result?.status ?? 'Not run'}{job && (job.draft_revision !== draft?.revision || job.source_revision !== review?.source.revision) ? ' · Stale input' : ''}</p>{result?.error && <ErrorNotice error={result.error} />}{job && <button onClick={() => jobs(job.id)}>View Job</button>}<button disabled={!connected || active || working || !canAnalyze} onClick={() => { void analyze(task); }}>Retry {task === 'review' ? 'Review' : 'Relation'}</button></section>; })}<button disabled={!connected || active || working || !canAnalyze} onClick={() => { void analyze(); }}>Analyze Draft</button><p className="hint">详细分析建议在 Obsidian 侧边栏查看；分析不修改正文。</p></>}
    </aside> : <FileEmpty icon="list">选择 Draft 查看正文、来源上下文和审阅选择。</FileEmpty>}</div></div>
  </div>;
}
