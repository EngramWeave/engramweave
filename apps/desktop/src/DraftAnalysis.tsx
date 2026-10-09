import { useEffect, useRef, useState } from 'react';
import type { AnalyzeRequest, Document, Draft } from '@engramweave/contracts';
import { client, failure, type Failure, type JobPage } from './client';
import { ErrorNotice } from './Feedback';

export function DraftAnalysis({ document, drafts, jobs, active, onStarted, onPublished }: { document: Document; drafts: Draft[]; jobs: JobPage | null; active: boolean; onStarted: () => void; onPublished: () => void }) {
  const [config, setConfig] = useState<Awaited<ReturnType<typeof client.analysisSettings>>>();
  const [profile, setProfile] = useState(typeof document.metadata.analysis_profile === 'string' ? document.metadata.analysis_profile : '');
  const [selectedDraft, setSelectedDraft] = useState('');
  const [error, setError] = useState<Failure>();
  const [busy, setBusy] = useState(false);
  const pendingRequest = useRef<AnalyzeRequest | null>(null);
  const latest = jobs?.items.find(job => job.kind === 'analyze_draft' && job.source_path === document.path);
  useEffect(() => { let cancelled = false; void client.analysisSettings().then(value => { if (!cancelled) setConfig(value); }).catch(e => { if (!cancelled) setError(failure(e)); }); return () => { cancelled = true; }; }, []);
  useEffect(() => { setProfile(typeof document.metadata.analysis_profile === 'string' ? document.metadata.analysis_profile : ''); pendingRequest.current = null; }, [document.revision]);
  const select = async () => {
    if (!profile || busy) return; setBusy(true); setError(undefined);
    try { await client.analysisSelection({ path: document.path, revision: document.revision, profile_id: profile }); onPublished(); }
    catch (e) { setError(failure(e)); } finally { setBusy(false); }
  };
  const analyze = async () => {
    if (!selectedDraft || busy) return; setBusy(true); setError(undefined);
    try {
      const draft = await client.draft(selectedDraft);
      pendingRequest.current ??= { request_id: crypto.randomUUID(), source_path: document.path, source_revision: document.revision, draft_path: draft.path, draft_revision: draft.revision, ...(profile ? { profile_id: profile } : {}) };
      await client.analyze(pendingRequest.current); pendingRequest.current = null; onStarted();
    } catch (e) { setError(failure(e)); } finally { setBusy(false); }
  };
  return <section className="draft-analysis"><h3>Draft Analyzer</h3><p className="hint">选择具体 Draft，独立运行 Review → Relation。不会重新编译或修改正文。</p>
    <label>Analysis Profile<select aria-label="Analysis Profile" value={profile} onChange={e => { setProfile(e.target.value); pendingRequest.current = null; }}><option value="">{config?.settings.default_profile ? `Default · ${config.settings.default_profile}` : 'Choose Profile'}</option>
      {profile && !config?.settings.profiles.some(p => p.id === profile) && <option value={profile}>{profile} (unavailable)</option>}{config?.settings.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    {document.kind === 'source' && document.processing_status === 'pending' && document.lifecycle_status === 'active' && <button disabled={!profile || busy || active} onClick={() => { void select(); }}>Save Source selection</button>}
    <label>Draft<select aria-label="Draft" value={selectedDraft} onChange={e => { setSelectedDraft(e.target.value); pendingRequest.current = null; }}><option value="">Choose a Draft</option>{drafts.map(d => <option key={d.path} value={d.path}>{d.title} · {d.path}</option>)}</select></label>
    <button className="primary" disabled={!selectedDraft || !drafts.some(d => d.path === selectedDraft) || busy || active || document.lifecycle_status !== 'active' || document.kind !== 'source' || document.processing_status === 'archived'} onClick={() => { void analyze(); }}>Analyze Draft</button>
    {latest?.kind === 'analyze_draft' && <div role="status"><p>{latest.draft_path}</p><p>Review · {latest.review.status} / Relation · {latest.relation.status}</p>{(['review','relation'] as const).map(t => latest[t].error && <ErrorNotice key={t} error={latest[t].error!} />)}
      {['queued','running'].includes(latest.status) && <button disabled={busy} onClick={() => { setBusy(true); void client.cancelAnalysis(latest.id).then(onStarted).catch(e => setError(failure(e))).finally(() => setBusy(false)); }}>Cancel analysis</button>}</div>}
    {error && <ErrorNotice error={error} />}
  </section>;
}
