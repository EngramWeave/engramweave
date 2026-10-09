import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CompilerSettings } from '@engramweave/contracts';
import { CoreError } from '../errors.js';
import { compilerResult } from '../compiler/input.js';
import { resultJsonSchema } from './api.js';
import { runProcess } from './process.js';

export async function executeCodex(settings: CompilerSettings, dataDirectory: string, prompt: string, signal: AbortSignal, instructions: string) {
  return compilerResult(await executeCodexText(settings, dataDirectory, prompt, signal, instructions, resultJsonSchema));
}
export async function executeCodexText(settings: CompilerSettings, dataDirectory: string, prompt: string, signal: AbortSignal, instructions: string, outputSchema: object,
  mcp?: { command: string; script: string; env: NodeJS.ProcessEnv }) {
  if (!settings.codex_path || !path.isAbsolute(settings.codex_path)) throw new CoreError('CONFIG_ERROR', 'Configure an absolute Codex executable path', 400);
  const executable = await lstat(settings.codex_path).catch(() => null);
  if (!executable?.isFile() || executable.isSymbolicLink()) throw new CoreError('CONFIG_ERROR', 'Configured Codex executable is unavailable or linked', 400);
  const directory = await mkdtemp(path.join(dataDirectory, mcp ? 'analyzer-codex-' : 'compiler-codex-'));
  const schema = path.join(directory, 'schema.json'); const answer = path.join(directory, 'answer.json');
  await writeFile(schema, JSON.stringify(outputSchema), { flag: 'wx' });
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--json', '-C', directory,
    '-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="auto"', '-c', 'approval_policy="never"', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
    '--disable', 'shell_tool', '--disable', 'code_mode_host', '--disable', 'apps', '--disable', 'plugins', '--disable', 'hooks', '--disable', 'tool_search', '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'skill_search', '--disable', 'multi_agent',
    '--output-schema', schema, '--output-last-message', answer, ...(settings.reasoning_effort !== 'default' ? ['-c', `model_reasoning_effort="${settings.reasoning_effort}"`] : []), ...(settings.model ? ['--model', settings.model] : []), '-'];
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|CODEX_ACCESS_TOKEN|ENGRAMWEAVE_HOST_STDIN)$/i.test(name)) delete env[name];
  if (mcp) {
    Object.assign(env, mcp.env);
    args.splice(args.length - 1, 0, '-c', `mcp_servers.analysis.command=${JSON.stringify(mcp.command)}`, '-c', `mcp_servers.analysis.args=${JSON.stringify([mcp.script])}`,
      '-c', 'mcp_servers.analysis.env_vars=["ENGRAMWEAVE_ANALYSIS_URL","ENGRAMWEAVE_ANALYSIS_TOKEN"]', '-c', 'mcp_servers.analysis.enabled_tools=["read_input","recall","read_evidence"]',
      '-c', 'mcp_servers.analysis.required=true', '-c', 'mcp_servers.analysis.default_tools_approval_mode="auto"',
      '-c', 'features.code_mode.direct_only_tool_namespaces=["mcp__analysis"]');
  }
  const secrets = [mcp?.env.ENGRAMWEAVE_ANALYSIS_TOKEN, process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY, process.env.CODEX_ACCESS_TOKEN].filter((v): v is string => Boolean(v));
  const redact = (text: string) => secrets.reduce((result, secret) => result.split(secret).join('[redacted]'), text);
  const events = await runProcess(settings.codex_path, args, `${instructions}\n\n${prompt}`, { cwd: directory, env, signal, maxBytes: 4_000_000, async onOutput(output, diagnostics) {
    await writeFile(path.join(directory, 'events.jsonl'), redact(output), { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(directory, 'diagnostics.txt'), redact(diagnostics), { flag: 'wx', mode: 0o600 });
  } });
  let completed = false;
  for (const line of events.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { throw new CoreError('INVALID_MODEL_OUTPUT', 'Codex returned invalid execution events', 422); }
    if (event.type === 'turn.failed' || event.type === 'error') throw new CoreError('EXECUTION_FAILED', 'Codex could not complete the Compiler task');
    if (event.type === 'turn.completed') completed = true;
    if (event.item && !['agent_message', 'reasoning', 'error'].includes(event.item.type)) {
      if (!mcp || event.item.type !== 'mcp_tool_call' || event.item.server !== 'analysis' || !['read_input','recall','read_evidence'].includes(event.item.tool)) throw new CoreError('EXECUTION_FAILED', 'Runner attempted a tool outside its task contract');
    }
  }
  if (!completed) throw new CoreError('EXECUTION_FAILED', 'Codex did not complete its task');
  const info = await lstat(answer).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 1_100_000) throw new CoreError('INVALID_MODEL_OUTPUT', 'Codex did not produce a bounded result', 422);
  return readFile(answer, 'utf8');
}
