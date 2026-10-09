import { useEffect, useState } from 'react';
import type { AnalysisSettings as Settings, AnalysisProfile, CompilerSettings } from '@engramweave/contracts';
import { client, failure, type Failure } from './client';
import { ErrorNotice } from './Feedback';
import './compiler.css';

const taskDefaults = (): CompilerSettings => ({ route: 'api', model: '', endpoint: 'http://127.0.0.1:8094/v1', codex_path: '', output_format: 'text', reasoning_effort: 'default', timeout_seconds: 300 });
function TaskEditor({ task, value, templates, configured, apiKey, update, keyChange }: {
  task: 'review' | 'relation'; value: AnalysisProfile['review']; templates: string[]; configured: boolean; apiKey: string;
  update: (value: AnalysisProfile['review']) => void; keyChange: (key: string) => void;
}) {
  const execution = value.execution;
  const set = <K extends keyof CompilerSettings>(field: K, next: CompilerSettings[K]) => update({ ...value, execution: { ...execution, [field]: next } });
  return <fieldset className="analysis-task"><legend>{task === 'review' ? 'Review Analyzer' : 'Relation Analyzer'}</legend><div className="compiler-form">
    <label>Template<select value={value.template_path} onChange={e => update({ ...value, template_path: e.target.value })}>{!templates.includes(value.template_path) && <option value={value.template_path}>{value.template_path} (unavailable)</option>}{templates.map(path => <option key={path} value={path}>{path.split('/').pop()}</option>)}</select></label>
    <label>Execution path<select value={execution.route} onChange={e => set('route', e.target.value as CompilerSettings['route'])}><option value="api">API</option><option value="codex">Codex</option></select></label>
    <label>Model<input required maxLength={200} value={execution.model} onChange={e => set('model', e.target.value)} /></label>
    {execution.route === 'api' ? <><label>API endpoint<input required type="url" value={execution.endpoint} onChange={e => set('endpoint', e.target.value)} /></label>
      <label>API key<input type="password" autoComplete="off" value={apiKey} onChange={e => keyChange(e.target.value)} placeholder={configured ? '已安全保存；留空保留' : '本机可留空；远端需独立密钥'} /></label>
      <label>Output format<select value={execution.output_format} onChange={e => set('output_format', e.target.value as CompilerSettings['output_format'])}>{['json_schema','json_object','text'].map(v => <option key={v} value={v}>{v}</option>)}</select></label></>
      : <label>Codex executable<input required value={execution.codex_path} onChange={e => set('codex_path', e.target.value)} placeholder="C:\…\codex.exe" /></label>}
    <label>Reasoning effort<select value={execution.reasoning_effort} onChange={e => set('reasoning_effort', e.target.value as CompilerSettings['reasoning_effort'])}>{['default','none','low','medium','high','xhigh','max'].map(v => <option key={v} value={v}>{v}</option>)}</select></label>
    <label>Timeout (seconds)<input type="number" min={10} max={1800} value={execution.timeout_seconds} onChange={e => set('timeout_seconds', Number(e.target.value))} /></label>
  </div></fieldset>;
}
export function AnalysisSettings({ connected }: { connected: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [templates, setTemplates] = useState<Awaited<ReturnType<typeof client.analysisTemplates>>['items']>([]);
  const [credentials, setCredentials] = useState<Awaited<ReturnType<typeof client.analysisSettings>>['credentials']>([]);
  const [keys, setKeys] = useState<Record<string,string>>({});
  const [error, setError] = useState<Failure>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [templatePath, setTemplatePath] = useState('');
  const [templateContent, setTemplateContent] = useState('');
  const [templateSaved, setTemplateSaved] = useState(false);
  useEffect(() => {
    setKeys({}); if (!connected) { setSettings(null); return; }
    let cancelled = false;
    void Promise.all([client.analysisSettings(), client.analysisTemplates()]).then(([config, files]) => {
      if (!cancelled) { setSettings(config.settings); setCredentials(config.credentials); setTemplates(files.items); setError(undefined); }
    }).catch(e => { if (!cancelled) setError(failure(e)); });
    return () => { cancelled = true; };
  }, [connected]);
  const updateProfile = (index: number, value: AnalysisProfile) => { setSettings(s => s ? { ...s, profiles: s.profiles.map((p, i) => i === index ? value : p) } : s); setSaved(false); };
  const save = async () => {
    if (!settings || busy) return; setBusy(true); setError(undefined); setSaved(false);
    try {
      const values = settings.profiles.flatMap(p => (['review','relation'] as const).flatMap(task => keys[`${p.id}:${task}`] ? [{ profile_id: p.id, task, api_key: keys[`${p.id}:${task}`]! }] : []));
      const result = await client.saveAnalysisSettings({ settings, ...(values.length ? { credentials: values } : {}) });
      setSettings(result.settings); setCredentials(result.credentials); setKeys({}); setSaved(true);
    } catch (e) { setError(failure(e)); } finally { setBusy(false); }
  };
  const saveTemplate = async () => {
    const original = templates.find(t => t.path === templatePath); if (!original || busy) return;
    setBusy(true); setError(undefined); setTemplateSaved(false);
    try { const file = await client.saveAnalysisTemplate({ ...original, content: templateContent }); setTemplates(items => items.map(t => t.path === file.path ? file : t)); setTemplateSaved(true); }
    catch (e) { setError(failure(e)); } finally { setBusy(false); }
  };
  return <section className="compiler-settings"><h2>Draft Analyzer</h2><p className="hint">分别配置 Review 和 Relation。保存设置不调用模型；每次明确分析读取当前 Profile 和模板。结果正文由 Obsidian 侧边栏展示。</p>
    {settings && <form onSubmit={e => { e.preventDefault(); void save(); }}>
      <div className="compiler-form"><label>Default Analysis Profile<select value={settings.default_profile ?? ''} onChange={e => { setSettings({ ...settings, default_profile: e.target.value || null }); setSaved(false); }}><option value="">Explicit selection required</option>{settings.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>
      {settings.profiles.map((p, i) => <details className="analysis-profile" key={i} open><summary>{p.name}</summary>
        <div className="compiler-form"><label>Profile ID<input required pattern={'[a-z][a-z0-9_\\-]{0,63}'} value={p.id} onChange={e => updateProfile(i, { ...p, id: e.target.value })} /><small>Source 保存此引用；已有选择不会随重命名自动改变。</small></label>
          <label>Name<input required maxLength={100} value={p.name} onChange={e => updateProfile(i, { ...p, name: e.target.value })} /></label>
          <label>Relation reuse<select value={p.reuse} onChange={e => updateProfile(i, { ...p, reuse: e.target.value as AnalysisProfile['reuse'] })}><option value="none">Independent context</option><option value="input">Review input context</option><option value="output">Reference Review output</option></select></label></div>
        {(['review','relation'] as const).map(task => <TaskEditor key={task} task={task} value={p[task]} templates={templates.filter(t => t.path.includes(task === 'review' ? '/Review/' : '/Relation/')).map(t => t.path)} configured={credentials.find(c => c.profile_id === p.id)?.[task] ?? false}
          apiKey={keys[`${p.id}:${task}`] ?? ''} keyChange={key => setKeys(k => ({ ...k, [`${p.id}:${task}`]: key }))} update={value => updateProfile(i, { ...p, [task]: value })} />)}
        <button type="button" disabled={busy} onClick={() => { setSettings({ default_profile: settings.default_profile === p.id ? null : settings.default_profile, profiles: settings.profiles.filter((_, index) => index !== i) }); setSaved(false); }}>Remove Profile</button>
      </details>)}
      <div className="analysis-actions"><button type="button" disabled={busy || settings.profiles.length >= 20} onClick={() => { const id = `profile-${crypto.randomUUID().slice(0,8)}`; setSettings({ ...settings, profiles: [...settings.profiles, { id, name: 'New Profile', review: { template_path: '90_System/Prompts/Review/Knowledge.md', execution: taskDefaults() }, relation: { template_path: '90_System/Prompts/Relation/Knowledge.md', execution: taskDefaults() }, reuse: 'none' }] }); setSaved(false); }}>Add Profile</button>
        <button className="primary" disabled={busy}>Save Analysis settings</button>{saved && <span role="status">已保存</span>}</div>
    </form>}
    {connected && <details className="analysis-profile"><summary>Analysis templates</summary><p className="hint">模板保存在 Vault。context 的 scope、limit、required 定义召回范围；正文可个性化编辑。新模板可在同目录创建后重新载入。</p>
      <div className="analysis-actions"><select aria-label="Analysis template" value={templatePath} onChange={e => { const file = templates.find(t => t.path === e.target.value); setTemplatePath(e.target.value); setTemplateContent(file?.content ?? ''); setTemplateSaved(false); }}><option value="">Choose template</option>{templates.map(t => <option key={t.path} value={t.path}>{t.path}</option>)}</select>
        <button disabled={busy} onClick={() => { void client.analysisTemplates().then(value => { setTemplates(value.items); const file = value.items.find(t => t.path === templatePath); if (file) setTemplateContent(file.content); }).catch(e => setError(failure(e))); }}>Reload templates</button></div>
      {templatePath && <><textarea className="analysis-template-editor" aria-label="Template content" value={templateContent} onChange={e => { setTemplateContent(e.target.value); setTemplateSaved(false); }} /><button disabled={busy} onClick={() => { void saveTemplate(); }}>Save template</button>{templateSaved && <span role="status">已保存</span>}</>}
    </details>}
    {!connected && <p className="hint">连接 Core 后配置 Analyzer。</p>}{error && <ErrorNotice error={error} />}
  </section>;
}
