import type { CompilerSettings } from '@engramweave/contracts';

export function OutputBudget({ value, onChange }: { value: CompilerSettings['output_tokens']; onChange: (value: CompilerSettings['output_tokens']) => void }) {
  return <label>Output token limit<input type="number" min={1} max={131072} value={value?.limit ?? ''} placeholder="Service default" onChange={e => onChange(e.target.value === '' ? undefined : { parameter: value?.parameter ?? 'max_tokens', limit: Number(e.target.value) })} />
    {value && <select aria-label="Output token parameter" value={value.parameter} onChange={e => onChange({ ...value, parameter: e.target.value as NonNullable<typeof value>['parameter'] })}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select>}
    <small>留空使用服务默认值。按服务支持选择参数；部分模型将推理 token 计入预算。此上限不等于最终字数。</small>
  </label>;
}
