import { useState } from 'react';
import type { SourcesQuery } from '@engramweave/contracts';

type Dimension = 'types' | 'tags' | 'time_ranges' | 'stages' | 'issues';
const labels: Record<Dimension, string> = { types: 'Type', tags: 'Tags', time_ranges: 'Captured Time', stages: 'processing_status', issues: 'Issue' };
export const typeLabel = (value: string) => ({ web: 'Web', manual: 'Manual', paper: 'Paper', zotero: 'Zotero', desktop: 'Desktop' })[value as 'web'] ?? value.charAt(0).toUpperCase() + value.slice(1);
const values = (encoded?: string): string[] => encoded ? JSON.parse(encoded) : [];
type TimeRange = { from: string; to: string; label: string };
export function SourceFilters({ query, change, facets, connected }: {
  query: SourcesQuery; change: (query: SourcesQuery) => void; facets: { types: string[]; tags: string[] }; connected: boolean;
}) {
  const [term, setTerm] = useState(query.q ?? '');
  const [dimension, setDimension] = useState<Dimension>('types');
  const [tagInput, setTagInput] = useState('');
  const [time, setTime] = useState('Last 7 days');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const allowed: Dimension[] = ['types', 'tags', 'time_ranges', ...(query.view === 'processing' ? ['stages' as const] : []), ...(query.view === 'issues' ? ['issues' as const] : [])];
  const currentDimension = allowed.includes(dimension) ? dimension : 'types';
  const update = (key: Dimension, choice: string, remove = false) => {
    const selected = values(query[key]);
    const next = remove || selected.includes(choice) ? selected.filter(item => item !== choice) : [...selected, choice];
    const updated = { ...query }; if (next.length) updated[key] = JSON.stringify(next); else delete updated[key]; change(updated);
  };
  const timeRanges: TimeRange[] = query.time_ranges ? JSON.parse(query.time_ranges) : [];
  const addTime = () => {
    let start: Date, end: Date;
    if (time === 'Custom range') {
      if (!from || !to) return;
      start = new Date(`${from}T00:00:00`); end = new Date(`${to}T23:59:59.999`);
    } else {
      end = new Date(); end.setHours(23, 59, 59, 999); start = new Date(end); start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (time === 'Today' ? 0 : time === 'Last 7 days' ? 6 : 29));
    }
    if (start > end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
    const range = { from: start.toISOString(), to: end.toISOString(), label: time === 'Custom range' ? `${from} – ${to}` : time };
    if (!timeRanges.some(item => item.from === range.from && item.to === range.to) && timeRanges.length < 20) change({ ...query, time_ranges: JSON.stringify([...timeRanges, range]) });
  };
  const options = currentDimension === 'types' ? [...new Set(['web', 'manual', 'paper', 'desktop', ...facets.types])]
    : currentDimension === 'tags' ? facets.tags.filter(tag => tag.toLowerCase().includes(tagInput.toLowerCase()))
      : currentDimension === 'stages' ? ['compiled', 'reviewed', 'planned'] : ['missing', 'invalid', 'unsupported'];
  const hasFilters = allowed.some(key => Boolean(query[key])) || Boolean(query.recompile);
  return <>
    <div className="source-toolbar">
      <form onSubmit={event => { event.preventDefault(); change({ ...query, q: term.trim() }); }}>
        <input aria-label="Search sources" placeholder="Search sources…" maxLength={200} value={term} onChange={event => setTerm(event.target.value)} />
        <button aria-label="Search sources" disabled={!connected}>⌕</button>
      </form>
      <details className="source-filter-menu"><summary>+ Filter ▾</summary><div className="filter-popover">
        <label>Filter by<select value={currentDimension} onChange={event => setDimension(event.target.value as Dimension)}>{allowed.map(key => <option value={key} key={key}>{labels[key]}</option>)}</select></label>
        {currentDimension === 'time_ranges' ? <>
          <label>Captured Time<select aria-label="Captured Time" value={time} onChange={event => setTime(event.target.value)}>{['Today', 'Last 7 days', 'Last 30 days', 'Custom range'].map(value => <option key={value}>{value}</option>)}</select></label>
          {time === 'Custom range' && <div className="date-range"><label>From<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label>To<input type="date" min={from} value={to} onChange={event => setTo(event.target.value)} /></label></div>}
          <button disabled={!connected || time === 'Custom range' && (!from || !to || from > to)} onClick={addTime}>Add time filter</button>
        </> : <>
          {currentDimension === 'tags' && <input aria-label="Find tags" placeholder="Type a tag…" value={tagInput} onChange={event => setTagInput(event.target.value)} />}
          <div className="filter-options">{options.map(option => <label key={option}><input type="checkbox" disabled={!connected} checked={values(query[currentDimension]).includes(option)} onChange={() => update(currentDimension, option)} />{currentDimension === 'tags' ? option : typeLabel(option)}</label>)}</div>
          {currentDimension === 'tags' && tagInput.trim() && !facets.tags.includes(tagInput.trim()) && <button disabled={!connected} onClick={() => update('tags', tagInput.trim())}>Use “{tagInput.trim()}”</button>}
        </>}
      </div></details>
      <select aria-label="Sort sources" value={query.sort ?? 'title_asc'} onChange={event => change({ ...query, sort: event.target.value as NonNullable<SourcesQuery['sort']> })}>
        <option value="title_asc">Sort · Title A–Z</option><option value="title_desc">Sort · Title Z–A</option><option value="captured_desc">Sort · Newest captured</option><option value="captured_asc">Sort · Oldest captured</option>
      </select>
    </div>
    {query.view === 'pending' && <label className="filter-chip">Compilation<select aria-label="Compilation filter" value={query.recompile ?? ''} onChange={event => { const next = {...query}; if (event.target.value) next.recompile = event.target.value as 'first' | 'recompile'; else delete next.recompile; change(next); }}><option value="">All Pending</option><option value="first">First compile</option><option value="recompile">Recompile requested</option></select></label>}
    {hasFilters && <div className="filter-chips">
      {allowed.filter(key => key !== 'time_ranges').flatMap(key => values(query[key]).map(choice => <button className="filter-chip" key={`${key}:${choice}`} onClick={() => update(key, choice, true)}>{labels[key]}: {key === 'tags' ? choice : typeLabel(choice)} ×</button>))}
      {timeRanges.map((range, index) => <button className="filter-chip" key={`${range.from}:${range.to}`} onClick={() => { const updated = { ...query }; const remaining = timeRanges.filter((_, current) => current !== index); if (remaining.length) updated.time_ranges = JSON.stringify(remaining); else delete updated.time_ranges; change(updated); }}>Captured: {range.label} ×</button>)}
      <button className="clear-filters" onClick={() => { const updated = { ...query }; for (const key of ['types', 'tags', 'time_ranges', 'stages', 'issues', 'recompile'] as const) delete updated[key]; change(updated); }}>Clear all</button>
    </div>}
  </>;
}
