import { useEffect, useState, type FormEvent } from 'react';
import type { CompilerSettings as Settings } from '@engramweave/contracts';
import { client, failure, type Failure } from './client';
import { ErrorNotice } from './Feedback';
import './compiler.css';
import { OutputBudget } from './OutputBudget';

export function CompilerSettings({ connected }: { connected: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [configured, setConfigured] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState<Failure>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!connected) { setSettings(null); setKey(''); return; }
    let cancelled = false;
    void client.compilerSettings().then(value => {
      if (!cancelled) { setSettings(value.settings); setConfigured(value.api_key_configured); setError(undefined); }
    }).catch(error => { if (!cancelled) setError(failure(error)); });
    return () => { cancelled = true; };
  }, [connected]);
  const update = <K extends keyof Settings>(name: K, value: Settings[K]) => { setSettings(current => current ? { ...current, [name]: value } : current); setSaved(false); };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!settings || saving) return;
    setSaving(true); setError(undefined); setSaved(false);
    try { const value = await client.saveCompilerSettings(settings, key || undefined); setConfigured(value.api_key_configured); setKey(''); setSaved(true); }
    catch (error) { setError(failure(error)); }
    finally { setSaving(false); }
  };
  return <section className="compiler-settings">
    <h2>Compiler</h2>
    <p className="hint">设置正文编译的执行路径和模型。投递、启动与扫描不会运行 Compiler。</p>
    <p className="hint">Prompt template: <code>90_System/Prompts/Compiler.md</code>。在 Vault 中编辑，下一次执行读取当前模板；已有任务使用开始时的模板。</p>
    {settings && <form onSubmit={event => { void save(event); }} className="compiler-form">
      <label>Execution path<select value={settings.route} onChange={event => update('route', event.target.value as Settings['route'])}><option value="codex">Codex</option><option value="api">API</option></select></label>
      <label>Model<input required maxLength={200} value={settings.model} onChange={event => update('model', event.target.value)} placeholder="填写可用的模型名称" /></label>
      {settings.route === 'api' ? <>
        <label>API endpoint<input required type="url" value={settings.endpoint} onChange={event => update('endpoint', event.target.value)} placeholder="https://api.openai.com/v1" /></label>
        <label>API key<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={configured ? '已安全保存；留空保留现有密钥' : '本地端点可留空；远程端点需密钥'} /></label>
        <label>Output format<select value={settings.output_format} onChange={event => update('output_format', event.target.value as Settings['output_format'])}><option value="json_schema">JSON Schema</option><option value="json_object">JSON object</option><option value="text">JSON in text</option></select></label>
        <OutputBudget value={settings.output_tokens} onChange={value => update('output_tokens', value)} />
      </> : <label>Codex executable<input required value={settings.codex_path} onChange={event => update('codex_path', event.target.value)} placeholder="C:\…\codex.exe" /><small>使用此 CLI 已有的 ChatGPT 登录。</small></label>}
      <label>Reasoning effort<select value={settings.reasoning_effort} onChange={event => update('reasoning_effort', event.target.value as Settings['reasoning_effort'])}>{['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Timeout (seconds)<input type="number" min={10} max={1800} value={settings.timeout_seconds} onChange={event => update('timeout_seconds', Number(event.target.value))} /></label>
      <div><button className="primary" disabled={saving || !connected}>{saving ? 'Saving…' : 'Save Compiler settings'}</button>{saved && <span className="compiler-saved" role="status">已保存</span>}</div>
    </form>}
    {!connected && <p className="hint">连接 Core 后配置 Compiler。</p>}
    {error && <ErrorNotice error={error} />}
  </section>;
}
