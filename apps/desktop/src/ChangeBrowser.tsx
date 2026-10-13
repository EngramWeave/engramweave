import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeBrowserQuery, ChangeFile, CandidateDocument } from '@engramweave/contracts';
import { client, failure, type Failure } from './client';
import { ErrorNotice } from './Feedback';
import { FileActionDialog, FileEmpty, FilePagination, FileSearch, FileStats, FileTabs, fileDate, useFileList, type FileCategory } from './FileBrowserUI';

const categories: FileCategory[] = [
  { id: 'all', title: 'All ChangeSets', caption: 'Existing workspaces', tone: 'blue', icon: 'branch' },
  { id: 'preparing', title: 'Preparing', caption: 'Planner is generating', tone: 'orange', icon: 'clock' },
  { id: 'ready', title: 'Ready', caption: 'Waiting for human approval', tone: 'violet', icon: 'list' },
  { id: 'executing', title: 'Executing', caption: 'Accepted · protected', tone: 'green', icon: 'activity' },
  { id: 'issues', title: 'Issues', caption: 'Inspect files or tasks', tone: 'red', icon: 'help' },
];
type Overview = Awaited<ReturnType<typeof client.changeOverview>>;
export function ChangeBrowser({ connected, refreshKey, active, focus, draft, source, jobs, started, onFailure }: {
  connected: boolean; refreshKey: string; active: boolean; focus: string | null; draft: (path: string) => void; source: (path: string) => void; jobs: (id?: string) => void; started: () => void; onFailure: (error: Failure) => void;
}) {
  const [query, setQuery] = useState<ChangeBrowserQuery>({ view: 'all', sort: 'created_desc' }); const [offset, setOffset] = useState(0);
  const input = useMemo(() => ({ ...query, limit: 20, offset }), [query, offset]);
  const list = useFileList(client.changeFiles, input, connected, refreshKey, onFailure);
  const [id, setId] = useState<string | null>(focus); const [overview, setOverview] = useState<Overview>(); const [itemId, setItemId] = useState<string | null>(null);
  const [detailRow, setDetailRow] = useState<ChangeFile | null>();
  const [candidate, setCandidate] = useState<CandidateDocument>(); const [error, setError] = useState<Failure>(); const [previewError, setPreviewError] = useState<Failure>(); const [tab, setTab] = useState('Overview');
  const [selected, setSelected] = useState<Record<string, ChangeFile>>({}); const [confirmation, setConfirmation] = useState<{ action: 'cancel' | 'replan' | 'stop'; files: ChangeFile[] }>();
  const [working, setWorking] = useState(false); const [message, setMessage] = useState(''); const [results, setResults] = useState<string[]>([]); const [showResults, setShowResults] = useState(false);
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (focus) { setId(focus); setQuery({ view: 'all', sort: 'created_desc', q: focus }); setOffset(0); } }, [focus]);
  useEffect(() => {
    setOverview(undefined); setDetailRow(undefined); setError(undefined); setCandidate(undefined); setPreviewError(undefined);
    if (!connected || !id) return; let cancelled = false;
    void client.changeOverview(id).then(value => { if (!cancelled) { setOverview(value); setItemId(prior => value.manifest.items.some(item => item.id === prior) ? prior : value.manifest.items[0]?.id ?? null); } }).catch(error => { if (!cancelled) setError(failure(error)); });
    void client.changeFiles({ q: id, limit: 100 }).then(value => { if (!cancelled) setDetailRow(value.items.find(item => item.id === id) ?? null); }).catch(error => { if (!cancelled) setError(failure(error)); });
    return () => { cancelled = true; };
  }, [connected, id, refreshKey, list.revision]);
  const item = overview?.manifest.items.find(item => item.id === itemId);
  useEffect(() => {
    setCandidate(undefined); setPreviewError(undefined); if (!connected || !id || !item?.candidate_path) return; let cancelled = false;
    void client.candidate(id, item.id).then(value => { if (!cancelled) setCandidate(value); }).catch(error => { if (!cancelled) setPreviewError(failure(error)); });
    return () => { cancelled = true; };
  }, [connected, id, item?.id, refreshKey, list.revision]);
  const row = detailRow === undefined ? list.page?.items.find(item => item.id === id) : detailRow;
  const changeQuery = (next: ChangeBrowserQuery) => { if (next.view !== query.view) setSelected({}); setQuery(next); setOffset(0); };
  const selectable = list.page?.items.filter(item => item.state === 'ready' && item.can_cancel) ?? [];
  const allSelected = selectable.length > 0 && selectable.every(item => selected[item.id]);
  const choose = (item: ChangeFile) => setSelected(current => { const next = { ...current }; if (next[item.id]) delete next[item.id]; else if (Object.keys(next).length < 100) next[item.id] = item; return next; });
  const run = async (work: () => Promise<void>) => {
    if (working) return; setWorking(true); setError(undefined); setMessage('');
    try { await work(); } catch (error) { if (alive.current) setError(failure(error)); }
    finally { if (alive.current) setWorking(false); }
  };
  const execute = () => run(async () => {
    if (!confirmation) return;
    const outcomes: string[] = [];
    for (const file of confirmation.files) {
      let canceled = false;
      try {
        if (confirmation.action === 'stop') { if (!file.planner_job) throw new Error('Planner job is unavailable'); await client.cancelPlan(file.planner_job); }
        else {
          const prior = await client.cancelChangeSet(file.id); canceled = true;
          if (confirmation.action === 'replan') { await client.plan({ request_id: crypto.randomUUID(), source_path: prior.source_path }); started(); }
        }
        outcomes.push(`${file.title} · ${confirmation.action === 'replan' ? 'Old proposal canceled; Planner started' : confirmation.action === 'stop' ? 'Planner cancellation requested' : 'Canceled'}`);
        setSelected(current => { const next = { ...current }; delete next[file.id]; return next; });
        if (id === file.id && confirmation.action !== 'stop') setId(null);
      } catch (error) { outcomes.push(`${file.title} · ${canceled ? 'Old proposal canceled; new planning did not confirm success. Check Jobs or retry from Review. ' : ''}${failure(error).message}`); }
    }
    if (!alive.current) return;
    setResults(outcomes); setShowResults(true); setMessage('Management request finished. See item results.'); setConfirmation(undefined); list.refresh(); started();
  });
  return <div className="sources-page file-browser change-browser">
    <FileStats categories={categories} counts={list.page?.views} view={query.view ?? 'all'} connected={connected} change={view => changeQuery({ ...query, view: view as NonNullable<ChangeBrowserQuery['view']> })} />
    <div className="sources-layout"><section className="source-list panel" aria-label="ChangeSets list">
      <div className="source-toolbar"><FileSearch label="Search ChangeSets" placeholder="Search proposals, Sources or targets…" value={query.q ?? ''} disabled={!connected} change={q => changeQuery({ ...query, q })} />
        <details className="source-filter-menu"><summary>+ Filter ▾</summary><div className="filter-popover"><label>Operation<select value={query.kind ?? ''} onChange={e => { const next = { ...query }; if (e.target.value) next.kind = e.target.value as NonNullable<ChangeBrowserQuery['kind']>; else delete next.kind; changeQuery(next); }}><option value="">All operations</option><option value="write">Write</option><option value="directory">Directory</option><option value="discard">Discard</option></select></label>
          <label>Target domain<select value={query.domain ?? ''} onChange={e => { const next = { ...query }; if (e.target.value) next.domain = e.target.value as NonNullable<ChangeBrowserQuery['domain']>; else delete next.domain; changeQuery(next); }}><option value="">All domains</option>{['10_Ideas', '40_Knowledge', '50_Research', '60_Projects'].map(root => <option key={root}>{root}</option>)}</select></label></div></details>
        <select aria-label="Sort ChangeSets" value={query.sort} onChange={e => changeQuery({ ...query, sort: e.target.value as NonNullable<ChangeBrowserQuery['sort']> })}><option value="created_desc">Sort · Newest first</option><option value="created_asc">Sort · Oldest first</option><option value="title_asc">Sort · Title A–Z</option></select>
      </div><div className="file-list-actions"><span>{list.loading ? 'Loading…' : 'Live ChangeSet workspaces'}</span><button disabled={!connected || list.loading} onClick={() => { list.refresh(); started(); }}>Refresh ChangeSets</button>{(query.kind || query.domain || query.source_path) && <button onClick={() => changeQuery({ view: query.view ?? 'all', sort: query.sort ?? 'title_asc' })}>Clear filters</button>}</div>
      {list.error && <ErrorNotice error={list.error} />}
      <div className="filter-chips">{query.kind && <button className="filter-chip" onClick={() => { const next = { ...query }; delete next.kind; changeQuery(next); }}>Operation · {query.kind} ×</button>}{query.domain && <button className="filter-chip" onClick={() => { const next = { ...query }; delete next.domain; changeQuery(next); }}>Domain · {query.domain} ×</button>}</div>
      <div className="table-scroll"><table className="file-table"><thead><tr><th><input type="checkbox" aria-label="Select this page" checked={allSelected} disabled={working || list.loading || !selectable.length} onChange={() => setSelected(current => { const next = { ...current }; for (const item of selectable) { if (allSelected) delete next[item.id]; else if (Object.keys(next).length < 100) next[item.id] = item; } return next; })} /></th><th>ChangeSet</th><th>Source / Draft</th><th>State</th><th>Impact</th><th>Created</th></tr></thead><tbody>{list.page?.items.map(file => <tr key={file.id} className={id === file.id ? 'selected' : ''}>
        <td><input type="checkbox" aria-label={`Select ${file.title}`} checked={Boolean(selected[file.id])} disabled={!connected || working || list.loading || file.state !== 'ready' || !file.can_cancel || !selected[file.id] && Object.keys(selected).length >= 100} onChange={() => choose(file)} /></td>
        <td><button className="row-copy row-select" onClick={() => { setId(file.id); setTab('Overview'); }}><span className="row-title">{file.title}</span><span className="row-meta" title={file.path}>{file.id.slice(0, 8)}</span></button>{file.diagnostics.length > 0 && <span className="state-tag red">Needs attention</span>}</td>
        <td><span className="row-meta" title={file.source_path ?? ''}>{file.source_path ?? 'Unknown Source'}</span><span className="row-meta" title={file.draft_path ?? ''}>{file.draft_path ?? 'Unknown Draft'}</span></td>
        <td><span className={`state-tag ${file.state === 'issues' ? 'red' : file.state === 'executing' ? 'green' : 'violet'}`}>{file.state}</span>{file.execution_status && <small className="row-meta">{file.execution_status}</small>}</td>
        <td className="row-meta">{file.impact.write} write<br />{file.impact.directory} folders · {file.impact.discard} discard</td><td className="row-meta" title={fileDate(file.created_at)}>{file.created_at ? new Date(file.created_at).toLocaleDateString() : '—'}</td>
      </tr>)}</tbody></table></div>
      {!list.loading && !list.page?.items.length && <p className="empty">{connected ? '没有符合条件的 ChangeSet。已消费或取消的结果在 Jobs 查看。' : '连接 Core 后查看方案文件。'}</p>}
      {list.page && <FilePagination total={list.page.total} offset={offset} setOffset={setOffset} loading={list.loading} label="ChangeSets" />}
      {Object.keys(selected).length > 0 && <div className="source-batch-actions"><div className="selection-toolbar"><strong>{Object.keys(selected).length} selected</strong><button disabled={!connected || active || working} onClick={() => setConfirmation({ action: 'cancel', files: Object.values(selected) })}>Cancel selected</button><button disabled={working} onClick={() => setSelected({})}>Clear selection</button></div></div>}
    </section><div className="source-inspector">{id ? <aside className="panel file-inspector">
      <div className="section-heading"><h2>{row?.title ?? 'ChangeSet'}</h2><button aria-label="Close ChangeSet details" onClick={() => setId(null)}>×</button></div><p className="path">70_ChangeSets/{id}</p>
      <div className="file-actions"><button disabled={!connected || working || row?.state !== 'ready'} onClick={() => { void run(() => client.openChangeSet(id)); }}>Open in Obsidian</button>{overview?.manifest.draft_path && <button onClick={() => draft(overview.manifest.draft_path)}>View original Draft</button>}{overview?.manifest.source_path && <button onClick={() => source(overview.manifest.source_path)}>View Source</button>}</div>
      {error && <ErrorNotice error={error} />}{row?.diagnostics.map((error, index) => <ErrorNotice key={index} error={error} />)}{message && <p role="status">{message}</p>}
      <FileTabs tabs={['Overview', 'Items', 'Preview', 'Diagnostics']} tab={tab} setTab={setTab} />
      {tab === 'Overview' && overview && <><p>{row?.state ?? overview.manifest.state} · {fileDate(overview.manifest.created_at)}</p><p>Model · {overview.manifest.model || 'Codex default'}</p><h3>Integration Intent</h3><p className="file-text">{overview.manifest.intent || '—'}</p><p>{overview.manifest.items.length} proposed operations</p><p className="hint">未批准方案不会修改正式内容。成功消费或取消后工作区清理，结果保留在 Jobs。</p></>}
      {tab === 'Items' && overview?.manifest.items.map(entry => <section key={entry.id} className={`file-item ${itemId === entry.id ? 'selected' : ''}`}><button onClick={() => { setItemId(entry.id); setTab('Preview'); }}>{entry.kind === 'write' ? entry.before_revision === null ? 'Create / write' : 'Update / write' : entry.kind} · {entry.target}</button><p className="file-text">{entry.reason}</p><small>{overview.review?.decisions.find(item => item.item_id === entry.id)?.decision ?? (row?.execution_id ? 'Accepted execution' : 'No saved decision')}</small>{entry.requires_domain_approval && <p className="state-tag orange">New domain approval required</p>}<details><summary>Evidence · {entry.evidence.length}</summary>{entry.evidence.map((evidence, index) => <p className="path" key={index}>{evidence.path} · lines {evidence.start_line}–{evidence.end_line}</p>)}</details></section>)}
      {tab === 'Preview' && <><label>Proposed item<select aria-label="Candidate item" value={itemId ?? ''} onChange={e => setItemId(e.target.value)}>{overview?.manifest.items.map(entry => <option key={entry.id} value={entry.id}>{entry.kind} · {entry.target}</option>)}</select></label>{previewError && <ErrorNotice error={previewError} />}{item && <><p className="path">{item.target}</p><p className="file-text">{item.reason}</p>{item.candidate_path ? candidate ? <><button disabled={working || overview?.manifest.state !== 'ready'} onClick={() => { void run(() => client.previewCandidate(id, item.id)); }}>Preview Markdown in Obsidian</button><pre className="file-preview">{candidate.content}</pre></> : <p className="hint">Loading saved Candidate…</p> : <p className="hint">{item.kind === 'directory' ? 'Proposes creating this directory.' : 'Proposes marking this formal file discarded; no physical deletion.'}</p>}</>}</>}
      {tab === 'Diagnostics' && <><p>Planner · {row?.planner_job ?? 'Unavailable'}</p><p>Executor · {row?.execution_id ?? 'Not accepted'}</p><p>{row?.execution_status ?? ''}</p>{row?.diagnostics.length ? row.diagnostics.map((error, index) => <ErrorNotice key={index} error={error} />) : <p className="hint">No workspace diagnostic. Local Draft edits do not automatically invalidate this proposal.</p>}</>}
      <div className="file-actions">{row?.planner_job && <button onClick={() => jobs(row.planner_job!)}>View Planner Job</button>}{row?.execution_id && <button onClick={() => jobs(row.execution_id!)}>View Execution</button>}
        {row?.state === 'preparing' && row.planner_job && <button disabled={working} onClick={() => setConfirmation({ action: 'stop', files: [row] })}>Cancel Planner</button>}
        {row?.can_cancel && <><button disabled={active || working} onClick={() => setConfirmation({ action: 'cancel', files: [row] })}>Cancel ChangeSet</button><button disabled={active || working} onClick={() => setConfirmation({ action: 'replan', files: [row] })}>Replan</button></>}
      </div>{row?.state === 'executing' && <p className="hint">已接受执行，不能取消、重规划或清理。请查看原执行结果，并在 Obsidian 使用原批准恢复入口。</p>}
    </aside> : <FileEmpty icon="branch">选择 ChangeSet 查看整份方案、目标文件和管理操作。</FileEmpty>}</div></div>
    {confirmation && <FileActionDialog title={confirmation.action === 'replan' ? 'Replan ChangeSet?' : confirmation.action === 'stop' ? 'Cancel Planner?' : 'Cancel ChangeSets?'} description={confirmation.action === 'replan' ? '旧候选及其已保存修改将清理；使用当前 Draft、Intent 和知识库重新规划。新方案需要重新批准。请先处理 Obsidian 的未保存编辑。' : confirmation.action === 'stop' ? '取消当前规划任务；不执行正式知识变更。' : '清理这些未批准方案；有效审阅选择返回 reviewed，Source 和 Draft 保留。Obsidian 的旧候选编辑将不再用于此方案，请先处理未保存内容。'} targets={confirmation.files.map(file => `${file.title} · ${file.path}`)} busy={working} confirm={() => { void execute(); }} cancel={() => setConfirmation(undefined)} />}
    {showResults && <FileActionDialog title="Management results" description="逐项结果；已接受执行的工作区不会被取消。" targets={results} busy={false} confirm={() => setShowResults(false)} cancel={() => setShowResults(false)} />}
  </div>;
}
