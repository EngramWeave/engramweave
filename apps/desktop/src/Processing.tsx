import { useEffect, useRef, useState } from 'react';
import type { ProcessingRequest, ProcessingRound, ProcessingSettings as Settings } from '@engramweave/contracts';
import { client, failure, type Failure, type JobPage } from './client';
import { ErrorNotice } from './Feedback';
import './processing.css';

export function ProcessingSettings({ connected, onChange }: { connected: boolean; onChange: () => void }) {
  const [settings,setSettings] = useState<Settings>(); const [state,setState] = useState<Awaited<ReturnType<typeof client.processingState>>>();
  const [error,setError] = useState<Failure>(); const [busy,setBusy] = useState(false);
  useEffect(() => { if (!connected) return; let cancelled = false; void Promise.all([client.processingSettings(),client.processingState()]).then(([s,t]) => { if (!cancelled) { setSettings(s); setState(t); } }).catch(e => { if (!cancelled) setError(failure(e)); }); return () => { cancelled = true; }; },[connected]);
  if (!connected || !settings) return null;
  const save = async () => { setBusy(true); setError(undefined); try { setSettings(await client.saveProcessingSettings(settings)); setState(await client.processingState()); onChange(); } catch(e) { setError(failure(e)); } finally {setBusy(false);} };
  return <section className="processing-settings"><h3>Processing schedule</h3><p className="hint">Core 运行时按计划处理 active Pending。保存设置不会调用模型；停止、睡眠和重启错过的计划不补跑。</p>
    <label><input type="checkbox" checked={settings.enabled} onChange={e => setSettings({...settings,enabled:e.target.checked})} />Enable schedule</label>
    <div className="processing-fields"><label>Mode<select aria-label="Processing mode" value={settings.mode} onChange={e => setSettings({...settings,mode:e.target.value as Settings['mode']})}><option value="daily">Daily</option><option value="interval">Interval</option></select></label>
      {settings.mode === 'daily' ? <><label>Local time<input type="time" value={settings.daily_time} onChange={e => setSettings({...settings,daily_time:e.target.value})} /></label><label>Time zone<input value={settings.time_zone} onChange={e => setSettings({...settings,time_zone:e.target.value})} /></label></> : <label>Interval (minutes)<input type="number" min={1} max={10080} value={settings.interval_minutes} onChange={e => setSettings({...settings,interval_minutes:Number(e.target.value)})} /></label>}
      <label>Extra retries per task<input type="number" min={0} max={5} value={settings.max_retries} onChange={e => setSettings({...settings,max_retries:Number(e.target.value)})} /></label></div>
    <button disabled={busy} onClick={() => { void save(); }}>Save processing settings</button><button disabled={busy} onClick={() => { void client.processingState().then(setState).catch(e => setError(failure(e))); }}>Refresh schedule</button>
    <p className="hint">Zone · {settings.time_zone} · Next · {state?.schedule.next_due ? new Date(state.schedule.next_due).toLocaleString() : 'Disabled'}{state?.schedule.waiting ? ' · One round waiting' : ''}</p>{state?.schedule.reason && <p className="hint">{state.schedule.reason}</p>}{error && <ErrorNotice error={error} />}
  </section>;
}

export function ProcessingRounds({ connected, active, onChange, jobs }: { connected: boolean; active: boolean; onChange: () => void; jobs: JobPage | null }) {
  const [page,setPage] = useState<Awaited<ReturnType<typeof client.processingRounds>>>(); const [offset,setOffset] = useState(0);
  const [error,setError] = useState<Failure>(); const [busy,setBusy] = useState(false); const [selection,setSelection] = useState<string[]>([]);
  const request = useRef<ProcessingRequest | null>(null);
  const running = page?.items.some(r => ['queued','running'].includes(r.status)) ?? false;
  const analyzedDrafts = [...new Map(jobs?.items.filter(j => j.kind === 'analyze_draft').map(j => [j.draft_path,j]) ?? []).values()];
  useEffect(() => {
    if (!connected) return; let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => { try { const result = await client.processingRounds(offset); if (cancelled) return; setPage(result); if (result.items.some(r => ['queued','running'].includes(r.status))) timer = setTimeout(() => { void load(); },1000); } catch(e) {if (!cancelled) setError(failure(e));} };
    void load(); return () => {cancelled = true;clearTimeout(timer);};
  },[connected,active,offset]);
  const submit = async (task?: 'review' | 'relation') => {
    setBusy(true); setError(undefined);
    try {
      if (!request.current) {
        const drafts = [...new Set(selection)];
        const items = task ? await Promise.all(drafts.map(async path => { const r = await client.draftReview(path); return {source_path:r.source.path,source_revision:r.source.revision,draft_path:r.draft.path,draft_revision:r.draft.revision,task}; })) : undefined;
        request.current = {request_id:crypto.randomUUID(),mode:task ? 'analyze' : 'pending',...(items ? {items} : {})};
      }
      await client.process(request.current); request.current = null; setSelection([]); setPage(await client.processingRounds(offset)); onChange();
    } catch(e) {setError(failure(e));} finally {setBusy(false);}
  };
  const renderRound = (round: ProcessingRound) => <details key={round.id} open={['queued','running','failed','interrupted'].includes(round.status)} className="processing-round"><summary>{round.status} · {round.trigger} · {round.mode} · {new Date(round.created_at).toLocaleString()} · {round.items.filter(i => i.status === 'succeeded').length}/{round.items.length}</summary>
    <p className="path">Round · {round.id} · Extra retries {round.max_retries}</p>{round.error && <ErrorNotice error={round.error} />}
    {['queued','running'].includes(round.status) && <button disabled={busy} onClick={() => { setBusy(true); void client.cancelProcessing(round.id).then(async () => {setPage(await client.processingRounds(offset));onChange();}).catch(e => setError(failure(e))).finally(() => setBusy(false)); }}>Cancel round</button>}
    {round.items.map((item,index) => <div className="processing-item" key={index}><strong>{item.source_path}</strong><span>{item.phase} · {item.status}</span>{item.draft_path && <label><input type="checkbox" checked={selection.includes(item.draft_path)} disabled={active || running || busy} onChange={() => { request.current = null; setSelection(current => current.includes(item.draft_path!) ? current.filter(p => p !== item.draft_path) : [...current,item.draft_path!].slice(0,100)); }} />{item.draft_path}<button onClick={() => { void client.open(item.draft_path!,'obsidian').catch(e => setError(failure(e))); }}>Open Draft</button></label>}<small className="path">Compiler · {item.compiler_job_id ?? '—'} · Analyzer · {item.analyzer_job_id ?? '—'}</small>{item.error && <ErrorNotice error={item.error} />}</div>)}
  </details>;
  return <section className="processing-rounds"><h2>Processing rounds</h2><p className="hint">完整轮次由 Core 执行：本地登记 → Compiler → Review → Relation。人工批准后才入库。</p><div className="connection-actions"><button className="primary" disabled={!connected || active || running || busy} onClick={() => { void submit(); }}>Process Pending</button><button disabled={!connected || busy} onClick={() => { void client.processingRounds(offset).then(setPage).catch(e => setError(failure(e))); }}>Refresh rounds</button><button disabled={!selection.length || active || running || busy} onClick={() => {void submit('review');}}>Retry Review ({selection.length})</button><button disabled={!selection.length || active || running || busy} onClick={() => {void submit('relation');}}>Retry Relation ({selection.length})</button></div>
    {error && <ErrorNotice error={error} />}{analyzedDrafts.length > 0 && <details className="processing-round"><summary>Select analyzed Drafts ({analyzedDrafts.length})</summary>{analyzedDrafts.map(job => <label className="processing-item" key={job.draft_path}><span><input type="checkbox" checked={selection.includes(job.draft_path)} disabled={active || running || busy} onChange={() => {request.current = null;setSelection(current => current.includes(job.draft_path) ? current.filter(p => p !== job.draft_path) : [...current,job.draft_path].slice(0,100));}} />{job.draft_path}</span><small>{job.source_path} · Review {job.review.status} / Relation {job.relation.status}</small></label>)}</details>}{page?.items.map(renderRound)}{page && <div className="pagination"><button disabled={!offset} onClick={() => setOffset(Math.max(0,offset-20))}>Previous</button><span>{page.total} rounds</span><button disabled={offset+20>=page.total} onClick={() => setOffset(offset+20)}>Next</button></div>}
  </section>;
}
