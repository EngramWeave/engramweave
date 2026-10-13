import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { startCore } from '../../packages/core/dist/main.js';
import { resourceVault } from '../helpers/resource-vault.mjs';

const require = createRequire('C:/Users/18214/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const { chromium } = require('playwright');
const unusedPort = async () => { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; };
const root = path.resolve('.local/P3/ui', `desktop-${Date.now()}`); await mkdir(root, { recursive: true });
const fixture = await resourceVault(root, await unusedPort()); const configPath = path.join(root, 'config.json'); await writeFile(configPath, JSON.stringify(fixture.config));
const core = await startCore(fixture.config); const debugPort = await unusedPort();
const child = spawn(path.resolve('apps/desktop/src-tauri/target/debug/engramweave-desktop.exe'), [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, ENGRAMWEAVE_CONFIG: configPath, WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1` } });
let browser; let activePage; const errors = []; const consoleErrors = [];
try {
  let endpoint;
  for (let attempt = 0; attempt < 60; attempt++) { try { endpoint = (await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).webSocketDebuggerUrl; if (endpoint) break; } catch {} if (child.exitCode !== null) throw new Error('Task-owned Desktop exited'); await new Promise(resolve => setTimeout(resolve, 500)); }
  assert(endpoint); browser = await chromium.connectOverCDP(endpoint); const page = browser.contexts()[0].pages()[0]; activePage = page; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  assert.equal(await page.title(), 'EngramWeave'); assert(new URL(page.url()).hostname === 'tauri.localhost');
  await page.locator('button.system-heading').click(); await page.getByRole('button', { name: '连接已有 Core', exact: true }).click();
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.review-panel .compact-row').length === 2 && document.querySelectorAll('.changes-panel .compact-row').length === 2);
  assert(!(await page.locator('.review-panel').innerText()).includes('示例内容'));
  await page.waitForFunction(() => document.querySelector('[aria-label="Review"] .nav-count')?.textContent === '2' && document.querySelector('[aria-label="Changes"] .nav-count')?.textContent === '2');
  await page.getByRole('button', { name: 'Sources', exact: true }).click(); await page.getByRole('textbox', { name: 'Search sources', exact: true }).waitFor();
  const sourceSearch = await page.locator('.source-toolbar form').evaluate(element => { const style = getComputedStyle(element); return { border: style.border, radius: style.borderRadius, padding: style.padding, height: style.height }; });
  await page.getByRole('button', { name: 'Review', exact: true }).click(); await page.locator('.review-browser .file-table tbody tr').first().waitFor();
  assert.deepEqual(await page.locator('.review-browser .source-toolbar form').evaluate(element => { const style = getComputedStyle(element); return { border: style.border, radius: style.borderRadius, padding: style.padding, height: style.height }; }), sourceSearch);
  for (const [title, total] of [['All Drafts', 27], ['To Review', 2], ['Reviewed', 0], ['Planned', 2], ['Issues', 1], ['Discarded', 1]]) {
    await page.getByRole('button', { name: new RegExp(`^${title}`) }).click();
    await page.waitForFunction(({ title, total }) => document.querySelector('.review-browser .source-stat.selected strong')?.textContent === title && document.querySelector('.review-browser .pagination > span')?.textContent === `${total} Drafts` && document.querySelector('.review-browser .file-list-actions > span')?.textContent === 'Current Draft files · Read only', { title, total });
    await page.locator('.review-browser .source-filter-menu').evaluate(element => { element.open = true; });
    await page.locator('.review-browser .source-filter-menu select').first().selectOption('archived');
    await page.waitForFunction(() => document.querySelector('.review-browser .pagination > span')?.textContent === '0 Drafts' && document.querySelector('.review-browser .file-list-actions > span')?.textContent === 'Current Draft files · Read only');
    await page.locator('.review-browser .source-filter-menu select').first().selectOption('');
    await page.waitForFunction(total => document.querySelector('.review-browser .pagination > span')?.textContent === `${total} Drafts` && document.querySelector('.review-browser .file-list-actions > span')?.textContent === 'Current Draft files · Read only', total);
    assert.equal(await page.locator('.review-browser .filter-chip').count(), 0);
    assert.equal(await page.locator('[aria-label="Review"] .nav-count').innerText(), '2');
    await page.locator('.review-browser .source-filter-menu').evaluate(element => { element.open = false; });
  }
  await page.getByRole('button', { name: /^All Drafts/ }).click();
  await page.getByRole('textbox', { name: 'Search Drafts', exact: true }).fill('gamma');
  await page.getByRole('button', { name: 'Search Drafts', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.review-browser .pagination > span')?.textContent === '2 Drafts');
  assert.equal(await page.locator('[aria-label="Review"] .nav-count').innerText(), '2');
  await page.getByRole('textbox', { name: 'Search Drafts', exact: true }).fill(''); await page.getByRole('textbox', { name: 'Search Drafts', exact: true }).press('Enter');
  await page.waitForFunction(() => document.querySelector('.review-browser .pagination > span')?.textContent === '27 Drafts');
  assert.equal(await page.locator('.review-browser .file-table tbody tr').count(), 20); await page.getByRole('button', { name: 'Next', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.review-browser .file-table tbody tr').length === 7);
  await page.getByRole('button', { name: /^Reviewed/ }).click(); await page.getByText('没有符合条件的 Draft。').waitFor();
  await page.getByRole('button', { name: /^Planned/ }).click(); await page.waitForFunction(() => document.querySelectorAll('.review-browser .file-table tbody tr').length === 2);
  assert.equal(await page.locator('.review-browser .file-table .state-tag').filter({ hasText: /^Selected$/ }).count(), 2);
  await page.getByRole('button', { name: /^Discarded/ }).click(); await page.getByRole('button', { name: /^Archived old draft/ }).click(); await page.getByRole('button', { name: 'Open Draft in Obsidian', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Delete permanently', exact: true }).count(), 0);
  await page.getByRole('button', { name: /^To Review/ }).click(); await page.getByRole('button', { name: /^gamma reviewed understanding/ }).click(); await page.getByRole('tab', { name: 'Context', exact: true }).click(); await page.getByText('Personal interpretation', { exact: true }).waitFor();
  const session = await browser.contexts()[0].newCDPSession(page);
  for (const width of [1440, 900]) { await session.send('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false }); await page.screenshot({ path: path.join(root, `review-${width}.png`), fullPage: true }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await page.getByRole('button', { name: 'Changes', exact: true }).click(); await page.getByRole('button', { name: /^Ready/ }).click(); await page.waitForFunction(() => document.querySelectorAll('.change-browser .file-table tbody tr').length === 2);
  assert.deepEqual(await page.locator('.change-browser .source-toolbar form').evaluate(element => { const style = getComputedStyle(element); return { border: style.border, radius: style.borderRadius, padding: style.padding, height: style.height }; }), sourceSearch);
  await page.getByRole('textbox', { name: 'Search ChangeSets', exact: true }).fill('alpha'); await page.getByRole('textbox', { name: 'Search ChangeSets', exact: true }).press('Enter');
  await page.waitForFunction(() => document.querySelector('.change-browser .pagination > span')?.textContent === '1 ChangeSets');
  assert.equal(await page.locator('[aria-label="Changes"] .nav-count').innerText(), '2');
  await page.getByRole('textbox', { name: 'Search ChangeSets', exact: true }).fill(''); await page.getByRole('button', { name: 'Search ChangeSets', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.change-browser .pagination > span')?.textContent === '2 ChangeSets');
  await page.getByRole('button', { name: /^alpha reviewed understanding/ }).click(); await page.getByRole('tab', { name: 'Items', exact: true }).click(); await page.getByRole('button', { name: /^Create \/ write/ }).click(); await page.getByRole('button', { name: 'Preview Markdown in Obsidian', exact: true }).waitFor();
  assert((await page.locator('.change-browser .file-preview').innerText()).includes('condition A'));
  for (const width of [1440, 900]) { await session.send('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false }); await page.screenshot({ path: path.join(root, `changes-${width}.png`), fullPage: true }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.equal(await page.locator('.change-browser .file-table td.row-meta').first().evaluate(element => getComputedStyle(element).display), 'table-cell'); }
  await session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await page.getByRole('button', { name: 'View original Draft', exact: true }).click(); await page.getByRole('button', { name: 'Open Draft in Obsidian', exact: true }).waitFor(); assert((await page.locator('.review-browser .file-preview').innerText()).includes('User-reviewed wording'));
  await page.getByRole('button', { name: 'Changes', exact: true }).click(); await page.getByRole('button', { name: /^Ready/ }).click(); await page.getByLabel('Select alpha reviewed understanding', { exact: true }).check(); await page.getByRole('button', { name: 'Cancel selected', exact: true }).click(); await page.getByRole('button', { name: 'Confirm', exact: true }).click(); await page.getByRole('heading', { name: 'Management results', exact: true }).waitFor(); assert((await page.locator('dialog').innerText()).includes('Canceled')); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.change-browser .file-table tbody tr').length === 1);
  await page.waitForFunction(() => document.querySelector('[aria-label="Changes"] .nav-count')?.textContent === '1');
  assert((await readFile(path.join(fixture.config.vault_path, '20_Sources/alpha.md'), 'utf8')).includes('processing_status: reviewed')); assert.equal(await page.getByRole('button', { name: 'Approve & Apply', exact: true }).count(), 0);
  await page.getByRole('button', { name: /^beta reviewed understanding/ }).click(); await page.getByRole('button', { name: 'Replan', exact: true }).click(); await page.getByRole('button', { name: 'Confirm', exact: true }).click(); await page.getByRole('heading', { name: 'Management results', exact: true }).waitFor(); assert((await page.locator('dialog').innerText()).includes('Old proposal canceled; Planner started')); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByRole('button', { name: /^Issues/ }).click(); await page.locator('.change-browser .file-table tbody tr').first().waitFor();
  await session.detach(); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
  await writeFile(path.join(root, 'outcomes.json'), JSON.stringify({ native_desktop: true, actual_core_files: true, simulated_proposals: true, review_paging_and_selection: true, all_stage_reset_in_all_six_views: true, navigation_counts_independent_of_filters: true, ready_count_after_cancel: true, search_matches_sources_style: true, search_button_and_enter: true, discarded_preview: true, context_and_candidate_preview: true, cross_page_draft_navigation: true, cancel_and_replan: true, widths: [1440, 900], no_desktop_approval: true, browser_plugin: 'not available; native WebView2 tested with existing Playwright CDP flow', page_errors: errors, console_errors: consoleErrors }, null, 2));
  console.log(JSON.stringify({ status: 'passed', root }));
} catch (error) { await writeFile(path.join(root, 'failure.txt'), String(error.stack ?? error)); if (activePage) await writeFile(path.join(root, 'failure-ui.txt'), await activePage.locator('body').innerText()); console.error(error); process.exitCode = 1; }
finally { await browser?.close(); if (child.pid && child.exitCode === null) await new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve())); await core.close(); }
