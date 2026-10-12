import { useEffect, useState } from 'react';
import type { PlannerSettings as Settings } from '@engramweave/contracts';
import { client, failure, type Failure } from './client';
import { ErrorNotice } from './Feedback';
import './compiler.css';

export function PlannerSettings({ connected }: { connected: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<Failure>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setSettings(null); setError(undefined); setSaved(false);
    if (!connected) return;
    let canceled = false;
    void Promise.all([client.plannerSettings(), client.plannerTemplate()]).then(([configuration]) => {
      if (!canceled) setSettings(configuration.settings);
    }).catch(error => { if (!canceled) setError(failure(error)); });
    return () => { canceled = true; };
  }, [connected]);
  const update = <K extends keyof Settings>(field: K, value: Settings[K]) => {
    setSettings(previous => previous ? { ...previous, [field]: value } : previous);
    setSaved(false);
  };
  const save = async () => {
    if (!settings || busy) return;
    setBusy(true); setError(undefined); setSaved(false);
    try { await client.savePlannerSettings(settings); setSaved(true); }
    catch (error) { setError(failure(error)); }
    finally { setBusy(false); }
  };
  return <section className="compiler-settings planner-settings" aria-labelledby="planner-settings-title">
    <h2 id="planner-settings-title">Integration Planner · Agent</h2>
    <p className="hint">根据所选 Reviewed Draft 和 Intent 生成候选方案，在 Obsidian 审查。保存配置不启动推理。</p>
    {!settings ? <p className="hint">连接 Core 后配置 Planner。</p> : <>
      <label className="planner-enable"><input type="checkbox" checked={settings.enabled} onChange={event => update('enabled', event.target.checked)} /> Enable Agent Planner</label>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="compiler-form">
          <label className="planner-wide">Codex executable<input required={settings.enabled} placeholder="C:\…\codex.exe" value={settings.codex_path} onChange={event => update('codex_path', event.target.value)} /></label>
          <label>Model<input placeholder="Codex default" value={settings.model} onChange={event => update('model', event.target.value)} /></label>
          <label>Reasoning effort<select value={settings.reasoning_effort} onChange={event => update('reasoning_effort', event.target.value)}>{['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => <option key={value}>{value}</option>)}</select></label>
          <label>Timeout (seconds)<input type="number" min={10} max={1800} value={settings.timeout_seconds} onChange={event => update('timeout_seconds', Number(event.target.value))} /></label>
          <label className="planner-wide">Optional Relation template<input placeholder="90_System/Prompts/Relation/Knowledge.md" value={settings.relation_template_path ?? ''} onChange={event => update('relation_template_path', event.target.value || null)} /></label>
        </div>
        <div className="planner-template-location">
          <strong>Planner template · Vault file</strong>
          <code>90_System/Prompts/Planner.md</code>
          <p className="hint">在 Obsidian 中打开此文件编辑。每轮规划读取文件的最新内容；保存模型配置不会覆盖模板。</p>
        </div>
        <div className="analysis-actions"><button type="submit" disabled={busy}>Save Planner settings</button>{saved && <span className="compiler-saved" role="status">Planner 配置已保存。</span>}</div>
      </form>
    </>}
    {error && <ErrorNotice error={error} />}
  </section>;
}
