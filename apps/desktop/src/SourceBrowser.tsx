import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Document, Source, SourceBatch, SourcesQuery } from '@engramweave/contracts';
import type { Failure, SourcePage } from './client';
import { Detail } from './Detail';
import { Icon, type IconName } from './Icon';
import { lifecycleLabel, processingLabel, processingTone } from './status-labels';
import { DocumentFailure, ErrorNotice } from './Feedback';
import { SourceFilters, typeLabel } from './SourceFilters';
import { SourceBatchActions } from './SourceBatchActions';
import './source-browser.css';

export type SourceState = NonNullable<SourcesQuery['view']>;
export type SourceCounts = Record<SourceState, number>;
const categories: { state: SourceState; title: string; caption: string; tone: string; icon: IconName }[] = [
  { state: 'all', title: 'All Sources', caption: 'Browse every Source', tone: 'blue', icon: 'file' },
  { state: 'pending', title: 'Pending', caption: 'Waiting for processing', tone: 'orange', icon: 'clock' },
  { state: 'processing', title: 'Processing', caption: 'Compiled · Reviewed · Planned', tone: 'violet', icon: 'layers' },
  { state: 'archived', title: 'Archived', caption: 'Integrated Sources', tone: 'green', icon: 'archive' },
  { state: 'issues', title: 'Issues', caption: 'Missing · Invalid · Unsupported', tone: 'red', icon: 'help' },
  { state: 'discarded', title: 'Discarded', caption: 'Retained for cleanup', tone: 'slate', icon: 'trash' },
];
const healthTones = { ready: 'green', missing: 'orange', invalid: 'red', unsupported: 'violet' };
export function SourceBrowser({ page, counts, query, changeQuery, document, selectedPath, documentError, listError, select, close, open, connected, offset, setOffset, compilerActions, active, refresh, currentBatch }: {
  page: SourcePage | null; counts: SourceCounts | null; query: SourcesQuery; changeQuery: (query: SourcesQuery) => void;
  document: Document | null; selectedPath: string | null; documentError?: Failure | undefined; listError?: Failure | undefined;
  select: (path: string) => void; close: () => void; open: (target: 'obsidian' | 'original') => void; connected: boolean; offset: number; setOffset: (offset: number) => void;
  compilerActions?: ReactNode; active: boolean; refresh: () => void; currentBatch?: SourceBatch | null | undefined;
}) {
  const [selected, setSelected] = useState<Record<string, Source>>({});
  const handledBatch = useRef(currentBatch?.status === 'completed' ? currentBatch.id : null);
  useEffect(() => {
    if (currentBatch?.status === 'running') { handledBatch.current = null; return; }
    if (currentBatch?.status !== 'completed' || handledBatch.current === currentBatch.id) return;
    handledBatch.current = currentBatch.id;
    if (!selectedPath || !['delete', 'discard'].includes(currentBatch.action)) return;
    if (currentBatch.items.some(item => item.path === selectedPath && item.status === 'succeeded')) close();
  }, [selectedPath, currentBatch, close]);
  const selectedItems = Object.values(selected);
  const toggle = (source: Source) => setSelected(current => {
    const next = { ...current }; if (next[source.path]) delete next[source.path]; else if (source.revision && Object.keys(next).length < 100) next[source.path] = source; return next;
  });
  const selectable = page?.items.filter(source => source.revision) ?? [];
  const allSelected = selectable.length > 0 && selectable.every(source => selected[source.path]);
  return <div className="sources-page">
    <div className="source-stats">{categories.map(category => <button key={category.state} className={`source-stat ${category.tone} ${(query.view ?? 'all') === category.state ? 'selected' : ''}`} disabled={!connected} onClick={() => { setSelected({}); const next = { ...query, view: category.state }; delete next.stages; delete next.issues; changeQuery(next); }}>
      <span className="row-symbol"><Icon name={category.icon} /></span><span><strong>{category.title}</strong><b>{counts?.[category.state] ?? '—'}</b><small>{category.caption}</small></span>
      <svg className="stat-wave" viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true"><path d="M0 31Q24-9 45 19T84 29T125 34H200V40H0Z" fill="currentColor" /></svg>
    </button>)}</div>
    <div className="sources-layout"><section className="source-list panel" aria-label="Sources list">
      <SourceFilters query={query} change={changeQuery} connected={connected} facets={page?.facets ?? { types: [], tags: [] }} />
      {listError && <ErrorNotice error={listError} />}
      <div className="table-scroll"><table className="source-table"><thead><tr>
        <th className="selection-column"><input type="checkbox" aria-label="Select this page" checked={allSelected} disabled={!connected || selectable.length === 0} onChange={() => setSelected(current => { const next = { ...current }; for (const source of selectable) { if (allSelected) delete next[source.path]; else if (Object.keys(next).length < 100) next[source.path] = source; } return next; })} /></th>
        <th>Title</th><th>Type</th><th>Health</th><th>Processing</th><th>Lifecycle</th><th>Captured</th>
      </tr></thead><tbody>{page?.items.map(source => <tr key={source.id} className={selectedPath === source.path ? 'selected' : ''}>
        <td><input type="checkbox" aria-label={`Select ${source.title || source.path}`} disabled={!connected || !source.revision || !selected[source.path] && selectedItems.length >= 100} checked={Boolean(selected[source.path])} onChange={() => toggle(source)} /></td>
        <td><div className="source-title-cell"><span className={`row-symbol ${source.source_type === 'manual' ? 'orange' : 'blue'}`}><Icon name={source.source_type === 'web' ? 'link' : source.source_type === 'manual' ? 'note' : 'file'} /></span><button className="row-copy row-select" onClick={() => select(source.path)}><span className="row-title">{source.title || source.path}</span><span className="row-meta" title={source.original_locator ?? source.path}>{source.original_locator ?? source.path}</span></button></div>
          {source.diagnostics.filter(item => item.code !== 'CAPTURED_AT_UNKNOWN').map((item, index) => <span className="diagnostic" key={index}>{item.code}: {item.message}</span>)}
        </td>
        <td><span className={`type-tag ${source.source_type === 'manual' ? 'green' : 'blue'}`}>{source.source_type ? typeLabel(source.source_type) : 'Unknown'}</span></td>
        <td><span className={`state-tag ${healthTones[source.state]}`}><i />{source.state === 'ready' ? 'Available' : typeLabel(source.state)}</span></td>
        <td title={source.state === 'ready' ? 'processing_status' : 'Last known processing_status'}><span className={`state-tag ${source.processing_status ? processingTone(source.processing_status) : 'slate'}`}>{processingLabel(source.processing_status)}</span></td>
        <td title={source.state === 'ready' ? 'lifecycle_status' : 'Last known lifecycle_status'}><span className={`state-tag ${source.lifecycle_status === 'active' ? 'green' : 'slate'}`}>{lifecycleLabel(source.lifecycle_status)}</span></td>
        <td><span className="row-meta" title={source.captured_at ?? 'Captured time unknown'}>{source.captured_at && !Number.isNaN(Date.parse(source.captured_at)) ? new Date(source.captured_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}</span></td>
      </tr>)}</tbody></table></div>
      {!page?.items.length && <p className="empty">{connected ? '没有符合条件的 Source。可刷新 Vault 或更改筛选。' : '连接 Core 后查看资料。'}</p>}
      {page && <div className="pagination"><span>{page.total} Sources · Generation {page.index_generation}</span><button disabled={offset === 0 || !connected} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</button><button disabled={offset + 20 >= page.total || !connected} onClick={() => setOffset(offset + 20)}>Next</button></div>}
      <SourceBatchActions selected={selectedItems} clear={() => setSelected({})} disabled={!connected || active} refresh={refresh} currentBatch={currentBatch} discardedView={query.view === 'discarded'} />
    </section><div className="source-inspector">{document ? <Detail document={document} close={close} open={open} error={documentError}>{compilerActions}</Detail> : documentError ? <DocumentFailure error={documentError} path={selectedPath} close={close} /> : <aside className="panel inspector-empty"><span className="empty-symbol blue"><Icon name="file" /></span><h2>A closer look</h2><p>选择 Source 查看 Annotation、属性和原始引用。</p></aside>}</div></div>
  </div>;
}
