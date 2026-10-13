import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, copyFile, readdir } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import assert from 'node:assert/strict';
import { startCore } from '../../packages/core/dist/main.js';
import { resourceVault } from '../helpers/resource-vault.mjs';

const require = createRequire('C:/Users/18214/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const { chromium } = require('playwright');
const unusedPort = async () => { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
const root = path.resolve('.local/P3/ui', `obsidian-${Date.now()}`); await mkdir(root, { recursive: true });
const fixture = await resourceVault(root, await unusedPort()); const { config } = fixture;
const configPath = path.join(root, 'config.json'); await writeFile(configPath, JSON.stringify(config));
const userData = path.join(root, 'obsidian-user'); await mkdir(userData);
const pluginRoot = path.resolve('../engramweave-obsidian'); const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'manifest.json'), 'utf8'));
const install = path.join(config.vault_path, '.obsidian/plugins', manifest.id); await mkdir(install, { recursive: true });
for (const name of ['main.js', 'styles.css', 'manifest.json']) await copyFile(path.join(pluginRoot, name), path.join(install, name));
await writeFile(path.join(install, 'data.json'), JSON.stringify({ config_path: configPath }));
await writeFile(path.join(config.vault_path, '.obsidian/community-plugins.json'), JSON.stringify([manifest.id])); await writeFile(path.join(config.vault_path, '.obsidian/app.json'), JSON.stringify({ safeMode: false }));
const vaultId = createHash('sha256').update(config.vault_path).digest('hex').slice(0, 16); await writeFile(path.join(userData, 'obsidian.json'), JSON.stringify({ vaults: { [vaultId]: { path: config.vault_path, open: true, ts: Date.now() } } }));
const core = await startCore(config); const debugPort = await unusedPort();
const child = spawn('C:/Users/18214/AppData/Local/Programs/Obsidian/Obsidian.exe', [`--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
let browser; let page;
try {
  let endpoint;
  for (let attempt = 0; attempt < 60; attempt++) { try { endpoint = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl; if (endpoint) break; } catch {} if (child.exitCode !== null) throw new Error('Task-owned Obsidian exited'); await new Promise(resolve => setTimeout(resolve, 500)); }
  assert(endpoint); browser = await chromium.connectOverCDP(endpoint);
  for (let attempt = 0; attempt < 60; attempt++) { page = browser.contexts()[0].pages().find(value => value.url().startsWith('app://obsidian.md')); if (page && await page.evaluate(() => Boolean(window.app?.vault))) break; await new Promise(resolve => setTimeout(resolve, 500)); }
  assert(page); assert.equal((await page.evaluate(() => window.app.vault.adapter.getBasePath())).toLowerCase(), config.vault_path.toLowerCase());
  await page.evaluate(async id => { const plugins = window.app.plugins; if (!plugins.plugins[id]) { if (typeof plugins.setSafeMode === 'function') plugins.setSafeMode(false); if (typeof plugins.loadManifests === 'function') await plugins.loadManifests(); if (typeof plugins.setEnable === 'function') await plugins.setEnable(true); await plugins.enablePluginAndSave(id); } }, manifest.id);
  await page.waitForFunction(id => Boolean(window.app.plugins.plugins[id]), manifest.id);
  const openGamma = () => page.evaluate(async id => { const plugin = window.app.plugins.plugins[id]; await plugin.openFile('30_Drafts/gamma.md'); await plugin.openReview(); }, manifest.id);
  await openGamma(); await page.getByRole('button', { name: 'Review Complete', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Review Complete', exact: true }).click();
  await page.getByRole('heading', { name: 'Complete Review', exact: true }).waitFor();
  const modal = page.locator('.modal').filter({ has: page.getByRole('heading', { name: 'Complete Review', exact: true }) });
  assert.equal(await modal.locator('input[type=checkbox]').isChecked(), true); assert((await modal.innerText()).includes('30_Drafts/gamma-other.md')); assert(!(await modal.locator('ul').innerText()).includes('30_Drafts/gamma.md'));
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click(); assert((await readFile(path.join(config.vault_path, '20_Sources/gamma.md'), 'utf8')).includes('processing_status: compiled'));
  await page.getByRole('button', { name: 'Review Complete', exact: true }).click(); await modal.getByRole('button', { name: 'Review Complete', exact: true }).waitFor(); await page.screenshot({ path: path.join(root, 'cleanup-confirmation.png'), fullPage: true }); await modal.getByRole('button', { name: 'Review Complete', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes('Reviewed Draft · 30_Drafts/gamma.md'));
  assert((await readFile(path.join(config.vault_path, '30_Drafts/gamma-other.md'), 'utf8')).includes('lifecycle_status: discarded')); assert((await readFile(path.join(config.vault_path, '30_Drafts/gamma.md'), 'utf8')).includes('lifecycle_status: active'));
  const records = await Promise.all((await readdir(path.join(config.data_dir, 'human-review'))).filter(name => name.endsWith('.json') && !name.includes('.revoke.')).map(async name => JSON.parse(await readFile(path.join(config.data_dir, 'human-review', name), 'utf8'))));
  const accepted = records.find(record => record.request.source_path === '20_Sources/gamma.md' && record.request.action === 'complete'); assert.equal(accepted.request.discard_drafts.length, 1);
  await writeFile(path.join(config.vault_path, '30_Drafts/gamma-other.md'), fixture.draftBytes('gamma', 'gamma alternative understanding'));
  const token = await readFile(path.join(config.data_dir, 'token'), 'utf8');
  const replay = await core.server.inject({ method: 'POST', url: '/v1/human-review', headers: { host: `127.0.0.1:${config.port}`, authorization: `Bearer ${token}` }, payload: accepted.request }); assert.equal(replay.statusCode, 200);
  assert((await readFile(path.join(config.vault_path, '30_Drafts/gamma-other.md'), 'utf8')).includes('lifecycle_status: active'));
  await page.evaluate(async id => { const plugin = window.app.plugins.plugins[id]; await plugin.flushEditors(); const review = await plugin.workflow.review('30_Drafts/gamma.md'); await plugin.notes.submit('cancel', review); await plugin.openFile('30_Drafts/gamma.md'); plugin.refreshViews(); }, manifest.id);
  await page.waitForFunction(() => !document.body.innerText.includes('Reviewed Draft · 30_Drafts/gamma.md'));
  await page.getByRole('button', { name: 'Review Complete', exact: true }).click(); await modal.getByRole('button', { name: 'Review Complete', exact: true }).waitFor(); await modal.locator('input[type=checkbox]').uncheck(); await modal.getByRole('button', { name: 'Review Complete', exact: true }).click();
  await page.waitForFunction(() => document.body.innerText.includes('Reviewed Draft · 30_Drafts/gamma.md')); assert((await readFile(path.join(config.vault_path, '30_Drafts/gamma-other.md'), 'utf8')).includes('lifecycle_status: active'));
  const proposal = fixture.proposals[0]; const workspace = JSON.parse(await readFile(path.join(config.vault_path, `70_ChangeSets/${proposal}/manifest.json`), 'utf8'));
  await page.evaluate(async ({ id, proposal, item }) => { await window.app.plugins.plugins[id].previewCandidate(proposal, item); }, { id: manifest.id, proposal, item: workspace.items[0].id });
  assert.equal(await page.evaluate(() => window.app.workspace.getMostRecentLeaf().view.getMode()), 'preview');
  assert((await page.evaluate(() => window.app.workspace.getMostRecentLeaf().view.file.path)).startsWith(`70_ChangeSets/${proposal}/candidates/`));
  await page.screenshot({ path: path.join(root, 'native-candidate-preview.png'), fullPage: true });
  await writeFile(path.join(root, 'outcomes.json'), JSON.stringify({ native_obsidian: true, actual_core_lifecycle_writes: true, simulated_proposals: true, default_checked: true, cancel_no_mutation: true, sibling_only_discard: true, selected_draft_preserved: true, replay_keeps_restored_sibling: true, explicit_keep: true, candidate_native_reading_mode: true, os_uri_handoff_requires_manual_check: true }, null, 2)); console.log(JSON.stringify({ status: 'passed', root }));
} catch (error) { await writeFile(path.join(root, 'failure.txt'), String(error.stack ?? error)); if (page) await writeFile(path.join(root, 'failure-ui.txt'), await page.locator('body').innerText()); console.error(error); process.exitCode = 1; }
finally { await browser?.close(); if (child.pid && child.exitCode === null) await new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve())); await core.close(); }
