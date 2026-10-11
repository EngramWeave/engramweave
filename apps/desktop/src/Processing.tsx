import { useEffect, useState } from 'react';
import type { ProcessingRound, ProcessingSettings as Settings } from '@engramweave/contracts';
import { client, failure, type Failure } from './client';
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

export function ProcessingRounds({ connected, active }: { connected: boolean; active: boolean }) {
  const [page,setPage] = useState<Awaited<ReturnType<typeof client.processingRounds>>>(); const [offset,setOffset] = useState(0);
  const [error,setError] = useState<Failure>();
  useEffect(() => {
    if (!connected) return; let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const load = async () => { try { const result = await client.processingRounds(offset); if (cancelled) return; setPage(result); if (result.items.some(r => ['queued','running'].includes(r.status))) timer = setTimeout(() => { void load(); },1000); } catch(e) {if (!cancelled) setError(failure(e));} };
    void load(); return () => {cancelled = true;clearTimeout(timer);};
  },[connected,active,offset]);
  const renderRound = (round: ProcessingRound) => <details key={round.id} open={['queued','running','failed','interrupted'].includes(round.status)} className="processing-round"><summary>{round.status} · {round.trigger} · {round.mode} · {new Date(round.created_at).toLocaleString()} · {round.items.filter(i => i.status === 'succeeded').length}/{round.items.length}</summary>
    <p className="path">Round · {round.id} · Extra retries {round.max_retries}</p>{round.error && <ErrorNotice error={round.error} />}
    {round.items.map((item,index) => <div className="processing-item" key={index}><strong>{item.source_path}</strong><span>{item.phase} · {item.status}</span>{item.draft_path && <div className="processing-draft"><span>{item.draft_path}</span><button onClick={() => { void client.open(item.draft_path!,'obsidian').catch(e => setError(failure(e))); }}>Open Draft</button></div>}<small className="path">Compiler · {item.compiler_job_id ?? '—'} · Analyzer · {item.analyzer_job_id ?? '—'}</small>{item.error && <ErrorNotice error={item.error} />}</div>)}
  </details>;
  return <section className="processing-rounds"><h2>Processing rounds</h2><p className="hint">查看处理轮次的步骤、结果和错误记录。</p>
    {error && <ErrorNotice error={error} />}{page?.items.map(renderRound)}{page && <div className="pagination"><button disabled={!offset} onClick={() => setOffset(Math.max(0,offset-20))}>Previous</button><span>{page.total} rounds</span><button disabled={offset+20>=page.total} onClick={() => setOffset(offset+20)}>Next</button></div>}
  </section>;
}
