import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { failure, type Failure } from './client';
import './file-browser.css';

export interface FileCategory { id: string; title: string; caption: string; tone: string; icon: IconName }
export function FileStats({ categories, counts, view, change, connected }: { categories: FileCategory[]; counts: Record<string, number> | undefined; view: string; change: (view: string) => void; connected: boolean }) {
  return <div className="source-stats" style={{ '--card-count': categories.length } as React.CSSProperties}>{categories.map(item => <button key={item.id} className={`source-stat ${item.tone} ${view === item.id ? 'selected' : ''}`} disabled={!connected} onClick={() => change(item.id)}>
    <span className="row-symbol"><Icon name={item.icon} /></span><span><strong>{item.title}</strong><b>{counts?.[item.id] ?? '—'}</b><small>{item.caption}</small></span>
    <svg className="stat-wave" viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true"><path d="M0 31Q24-9 45 19T84 29T125 34H200V40H0Z" fill="currentColor" /></svg>
  </button>)}</div>;
}
export function FileEmpty({ icon, children }: { icon: IconName; children: ReactNode }) {
  return <aside className="panel inspector-empty"><span className="empty-symbol blue"><Icon name={icon} /></span><h2>A closer look</h2><p>{children}</p></aside>;
}
export function FilePagination({ total, offset, setOffset, loading, label }: { total: number; offset: number; setOffset: (offset: number) => void; loading: boolean; label: string }) {
  return <div className="pagination"><span>{total} {label}</span><button disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Previous</button><button disabled={loading || offset + 20 >= total} onClick={() => setOffset(offset + 20)}>Next</button></div>;
}
export function FileSearch({ label, placeholder, value, disabled, change }: { label: string; placeholder: string; value: string; disabled: boolean; change: (value: string) => void }) {
  const [term, setTerm] = useState(value);
  useEffect(() => { setTerm(value); }, [value]);
  return <form onSubmit={event => { event.preventDefault(); change(term.trim()); }}>
    <input aria-label={label} placeholder={placeholder} maxLength={200} value={term} onChange={event => setTerm(event.target.value)} />
    <button aria-label={label} disabled={disabled}>⌕</button>
  </form>;
}
export function useFileList<Q, T>(load: (query: Q) => Promise<T>, query: Q, connected: boolean, refreshKey: string, onFailure: (error: Failure) => void) {
  const [page, setPage] = useState<T>(); const [error, setError] = useState<Failure>(); const [loading, setLoading] = useState(false); const [revision, setRevision] = useState(0);
  const failureHandler = useRef(onFailure); failureHandler.current = onFailure;
  useEffect(() => {
    if (!connected) { setPage(undefined); setError(undefined); setLoading(false); return; }
    let cancelled = false; setLoading(true); setError(undefined);
    void load(query).then(value => { if (!cancelled) setPage(value); }).catch(error => {
      if (!cancelled) { const value = failure(error); setError(value); if (['CORE_UNAVAILABLE', 'INSTANCE_UNCERTAIN', 'UNAUTHORIZED'].includes(value.code)) failureHandler.current(value); }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load, query, connected, refreshKey, revision]);
  return { page, error, loading, revision, refresh: () => setRevision(value => value + 1) };
}
export function FileActionDialog({ title, description, targets, busy, confirm, cancel }: { title: string; description: string; targets: string[]; busy: boolean; confirm: () => void; cancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog className="source-action-dialog" ref={ref} onCancel={event => { event.preventDefault(); if (!busy) cancel(); }}><h3>{title}</h3><p>{description}</p>
    <div className="action-targets">{targets.map(target => <div className="action-source path" key={target}>{target}</div>)}</div><div className="dialog-actions"><button disabled={busy} onClick={confirm}>{busy ? 'Working…' : 'Confirm'}</button><button disabled={busy} onClick={cancel}>Cancel</button></div>
  </dialog>;
}
export function FileTabs({ tabs, tab, setTab }: { tabs: string[]; tab: string; setTab: (tab: string) => void }) {
  return <div className="file-tabs" role="tablist">{tabs.map(value => <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{value}</button>)}</div>;
}
export const fileDate = (date: string | null) => date ? new Date(date).toLocaleString() : '—';
