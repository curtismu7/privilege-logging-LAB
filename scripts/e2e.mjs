// Browser proof (Playwright). Usage:
//   node scripts/e2e.mjs mock [base-url]   Mock mode against a running app (default http://127.0.0.1:7801/), both themes and 375px
//   node scripts/e2e.mjs real              Real mode against FAKE gateway and search servers started here (never a real gateway)
//   node scripts/e2e.mjs all [base-url]    both
// Writes screenshots and e2e-output/evidence.json (git-ignored). Exit code 1 on any failed check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApp, startHttpServer } from '../server/src/app.js';
import { createHealth } from '../server/src/health.js';
import { KEY, fakeGateway, fakeK8s, fakeSearch, gatewayLog } from '../server/test/helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'e2e-output');
fs.mkdirSync(OUT, { recursive: true });
const EVIDENCE = path.join(ROOT, 'docs/evidence');
const KEEP = new Set(['mock-light-spinner', 'mock-dark-spinner', 'mock-light-json', 'mock-dark-json', 'mock-375-json', 'real-fetching', 'real-trace-json', 'real-unreachable', 'real-timeout', 'mock-dark-realonly']);
const [which = 'all', baseArg] = process.argv.slice(2);
const BASE = (baseArg || 'http://127.0.0.1:7801/').replace(/\/?$/, '/');
const evidence = []; let failed = 0;
const shot = async (p, name, opts = {}) => { const f = path.join(OUT, `${name}.png`); await p.screenshot({ path: f, ...opts }); if (KEEP.has(name)) { fs.mkdirSync(EVIDENCE, { recursive: true }); fs.copyFileSync(f, path.join(EVIDENCE, `${name}.png`)); } };
const check = (name, ok, detail = '') => { evidence.push({ name, ok: !!ok, detail }); if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`); };

async function launch() {
  const cache = path.join(process.env.HOME || '', 'Library/Caches/ms-playwright');
  try { return await chromium.launch(); } catch { /* browser build not installed: use any installed headless shell */ }
  const shells = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const d of shells) {
    const exe = path.join(cache, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
    if (fs.existsSync(exe)) return chromium.launch({ executablePath: exe });
  }
  throw new Error('no Chromium available: run npx playwright install chromium');
}

// WCAG contrast of an unselected control's border against what is behind it, computed in the page.
const CONTRAST = `(() => {
  const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] === undefined ? 1 : m[3] }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const behind = (el) => { for (let e = el.parentElement; e; e = e.parentElement) { const bg = parse(getComputedStyle(e).backgroundColor); if (bg.a > 0.9) return bg; } return parse(getComputedStyle(document.body).backgroundColor); };
  const out = [];
  for (const el of document.querySelectorAll('main button:not([aria-pressed="true"]):not([aria-selected="true"]):not(.primary):not(.linkish):not(:disabled), main select, main textarea')) {
    const cs = getComputedStyle(el); const border = parse(cs.borderTopColor);
    if (parseFloat(cs.borderTopWidth) < 1) { out.push({ el: el.outerHTML.slice(0, 60), ratio: 0 }); continue; }
    out.push({ el: el.outerHTML.slice(0, 60), ratio: ratio(border, behind(el)) });
  }
  return out;
})()`;


// The JSON tree viewer: distinct colours per value type at 4.5:1, collapse/expand, Expand/Collapse all, Raw, Copy, keyboard, badges, inert text.
const COLORS = `(() => {
  const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2] }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const bg = parse(getComputedStyle(document.querySelector('.entry')).backgroundColor);
  const out = {};
  for (const sel of ['.jt__key', '.jt__str', '.jt__num', '.jt__bool', '.jt__null']) {
    const el = document.querySelector(\`[data-testid=lines-pasted] \${sel}\`) || document.querySelector(sel);
    if (!el) { out[sel] = null; continue; }
    const c = getComputedStyle(el).color; out[sel] = { color: c, ratio: ratio(parse(c), bg) };
  }
  for (const f of ['user', 'agent', 'tool', 'decision']) { const el = document.querySelector(\`.fbadge--\${f}\`); if (el) out[f] = { color: getComputedStyle(el).color, ratio: ratio(parse(getComputedStyle(el).color), bg) }; }
  return out;
})()`;
async function jsonProof(p, label, shotPrefix) {
  // a pasted JSON record carries every value type, so every colour can be measured
  await p.fill('[data-testid=paste-box]', '{"Event":"mcp_response_blocked","Client":"lab-agent-key","User":"u-1","TopScore":1,"ok":true,"gone":null,"nested":{"list":[1,"two"]},"xss":"<img src=x onerror=alert(1)>"}');
  await p.click('[data-testid=paste-score]'); await p.waitForSelector('[data-testid=paste-result] [role=tree]');
  const c = await p.evaluate(COLORS);
  const types = ['.jt__key', '.jt__str', '.jt__num', '.jt__bool', '.jt__null'];
  check(`${label}: keys, strings, numbers, booleans and null each get a distinct colour`, types.every((t) => c[t]) && new Set(types.map((t) => c[t].color)).size === 5, types.map((t) => c[t]?.color).join(' '));
  const weak = types.filter((t) => c[t] && c[t].ratio < 4.5).map((t) => `${t} ${c[t].ratio.toFixed(2)}`);
  check(`${label}: every JSON value colour is 4.5:1 or more on the entry background`, weak.length === 0, weak.join('; ') || types.map((t) => c[t].ratio.toFixed(1)).join(' '));
  const badgeWeak = ['user', 'agent', 'tool', 'decision'].filter((f) => c[f] && c[f].ratio < 4.5);
  check(`${label}: the four field badges are 4.5:1 or more`, badgeWeak.length === 0, badgeWeak.join(','));
  const tree = p.locator('[data-testid=paste-result] [data-testid=entry-0]');
  const rows0 = await tree.locator('[role=treeitem]').count();
  await tree.locator('[data-testid=entry-0-collapse]').click();
  check(`${label}: Collapse all folds the tree to its root, Expand all opens every node`, (await tree.locator('[role=treeitem]').count()) === 1 && (await tree.locator('[role=treeitem]').first().getAttribute('aria-expanded')) === 'false' && (await (async () => { await tree.locator('[data-testid=entry-0-expand]').click(); return (await tree.locator('[role=treeitem]').count()) > rows0; })()));
  await tree.locator('[role=treeitem]').first().focus(); await p.keyboard.press('ArrowDown');
  check(`${label}: arrow keys move through the tree`, (await p.evaluate(() => document.activeElement?.getAttribute('role'))) === 'treeitem' && (await p.evaluate(() => document.activeElement?.getAttribute('aria-level'))) === '2');
  await tree.locator('[data-testid=entry-0-raw]').click();
  check(`${label}: Raw shows the original line`, /Event.*mcp_response_blocked/.test(await tree.locator('[data-testid=entry-0-rawtext]').textContent()));
  await tree.locator('[data-testid=entry-0-raw]').click();
  check(`${label}: hostile text is inert (no <img> in the page)`, (await p.locator('[data-testid=paste-result] img').count()) === 0 && /<img src=x/.test(await tree.textContent()));
  await tree.locator('[data-testid=entry-0-copy]').click();
  await p.waitForFunction(() => /Copied|blocked/.test(document.querySelector('[data-testid=paste-result] [data-testid=entry-0-copied]')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  check(`${label}: Copy gives feedback`, /Copied|blocked/.test(await tree.locator('[data-testid=entry-0-copied]').textContent()));
  check(`${label}: the field legend and a "not present" list are shown`, (await p.locator('[data-testid=field-legend]').count()) >= 1 && /Not present in this entry|All four/.test(await p.locator('[data-testid=paste-result] [data-testid=not-present]').textContent()));
  await p.locator('[data-testid=paste-result]').scrollIntoViewIfNeeded();
  await shot(p, `${shotPrefix}-json`);
}

async function mockProof(browser) {
  const reqs = new Set();
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    p.on('request', (r) => reqs.add(new URL(r.url()).origin));
    await p.goto(BASE); await p.waitForSelector('[data-testid=run-page]');
    await p.selectOption('[data-testid=theme-select]', theme);
    check(`mock/${theme}: data-theme applied`, await p.evaluate(() => document.documentElement.getAttribute('data-theme')) === theme);
    check(`mock/${theme}: banner says replay and nothing is sent`, /Replay of transactions measured on 2026-11-07; nothing is sent\./.test(await p.textContent('[data-testid=banner]')));
    // The shared TopMenu: the Real option carries disabled + the how-to title; the mode is the select's value.
    check(`mock/${theme}: Mock selected, Real disabled with a how-to tooltip`, (await p.inputValue('[data-testid=mode-select]')) === 'mock' && await p.isDisabled('[data-testid=mode-real]') && /PRIV_LOG_GATEWAY_URL/.test(await p.getAttribute('[data-testid=mode-real]', 'title')));
    const info = await (await p.request.get(`${BASE}api/info`)).json();
    console.log('DBG info', JSON.stringify(info).slice(0, 200)); // TEMP
    check(`mock/${theme}: /api/info source=mock realAvailable=false`, info.source === 'mock' && info.realAvailable === false);
    const real409 = await p.evaluate(async () => (await fetch('/api/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"source":"real"}' })).status);
    check(`mock/${theme}: POST /api/mode real answers 409 when not configured`, real409 === 409);
    await shot(p, `mock-${theme}-run`);
    // a single Run shows the two-phase spinner and stays on the Run page, at the same scroll position, with the result on the card
    const cardTop = () => p.evaluate(() => document.querySelector('[data-testid=case-mcp-allowed-key]').getBoundingClientRect().top);
    await p.locator('[data-testid=case-mcp-allowed-key]').scrollIntoViewIfNeeded();
    const y0 = await cardTop();
    await p.click('[data-testid=run-mcp-allowed-key]');
    await p.waitForSelector('[data-testid=busy-mcp-allowed-key]');
    const phase1 = await p.getAttribute('[data-testid=busy-mcp-allowed-key]', 'role');
    await p.waitForFunction(() => /Fetching the log entry/.test(document.querySelector('[data-testid=busy-mcp-allowed-key]')?.textContent || ''));
    check(`mock/${theme}: spinner is role=status, aria-busy on the case, and reaches "Fetching the log entry"`, phase1 === 'status' && (await p.getAttribute('[data-testid=case-mcp-allowed-key]', 'aria-busy')) === 'true');
    await shot(p, `mock-${theme}-spinner`);
    await p.waitForSelector('[data-testid=open-mcp-allowed-key]', { timeout: 15000 });
    check(`mock/${theme}: Run stays on the Run page, the card did not move on screen, and the banner still says replay`, (await p.locator('[data-testid=run-page]').count()) === 1 && (await p.locator('[data-testid=trace-page]').count()) === 0 && Math.abs((await cardTop()) - y0) < 2 && /nothing is sent/.test(await p.textContent('[data-testid=banner]')));
    await p.click('[data-testid=run-all]');
    await p.waitForSelector('[data-testid=open-intent-encoder-unreachable]', { timeout: 60000 });
    check(`mock/${theme}: Run all replayed 17 cases (the 17 not-yet-measured are not run)`, (await p.locator('[data-testid^=open-]').count()) === 17);
    const ro = p.locator('[data-testid=run-keys-revoked]');
    check(`mock/${theme}: a real-only case is listed, disabled, with the tooltip`, (await ro.isDisabled()) && (await ro.getAttribute('title')) === 'No recorded measurement yet. Real mode only.' && /No recorded measurement yet/.test(await p.textContent('[data-testid=mockonly-keys-revoked]')));
    await p.locator('[data-testid=case-keys-revoked]').scrollIntoViewIfNeeded(); await shot(p, `mock-${theme}-realonly`);
    const rc = await (await p.request.post(`${BASE}api/run`, { headers: { 'content-type': 'application/json', origin: new URL(BASE).origin }, data: { caseId: 'keys-revoked' } })).status();
    check(`mock/${theme}: POST /api/run for a real-only case answers 409 in Mock`, rc === 409);
    const caseCount = await p.locator('article[data-testid^=case-]').count();
    await p.click('[data-testid=case-tag-filter] [data-testid=filter-tag][data-tag="area:Federated identity"]');
    const fedOnly = await p.locator('article[data-testid^=case-]').count();
    const pills = await p.locator('[data-testid=case-fed-valid-token] [data-testid=entry-tag]').count();
    await shot(p, `mock-${theme}-run-tags`);
    await p.click('[data-testid=case-tag-filter] [data-testid=tag-filter-clear]');
    check(`mock/${theme}: Run page tag panel is open, cards carry tags, Federated identity = 5 cards, Clear restores`, fedOnly === 5 && pills >= 4 && (await p.locator('article[data-testid^=case-]').count()) === caseCount, `${fedOnly} of ${caseCount}, ${pills} pills`);
    const runContrast = (await p.evaluate(CONTRAST)).filter((c) => c.ratio < 3);
    check(`mock/${theme}: run page unselected control borders are 3:1 or more`, runContrast.length === 0, runContrast.slice(0, 3).map((w) => `${w.el} ${w.ratio.toFixed(2)}`).join('; '));
    await p.click('[data-testid=open-mcp-allowed-key]'); await p.waitForSelector('[data-testid=lines-gateway-log]');
    const marks = await p.$$eval('[data-testid=lines-gateway-log] mark', (ms) => ms.map((m) => `${m.dataset.field}:${m.textContent}`));
    check(`mock/${theme}: trace marks user, agent, tool and decision inline`, ['user', 'agent', 'tool', 'decision'].every((f) => marks.some((m) => m.startsWith(`${f}:`))), marks.join(' | '));
    await p.click('[data-testid=lines-gateway-log] [data-testid=tag-filter-open]');
    await p.click('[data-testid=lines-gateway-log] [data-testid=filter-tag][data-tag="type:auth"]');
    const filtered = await p.locator('[data-testid=lines-gateway-log] [data-testid=entry-item]').count();
    await p.click('[data-testid=lines-gateway-log] [data-testid=tag-filter-clear]');
    check(`mock/${theme}: entry tags filter the trace (auth = 1 of 3) and Clear restores`, filtered === 1 && (await p.locator('[data-testid=lines-gateway-log] [data-testid=entry-item]').count()) === 3);
    // back from a Trace opened far down the Run page: the button and the browser Back both land on that case card, in view
    const inView = (id) => p.evaluate((sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return !!r && r.top < window.innerHeight && r.bottom > 0; }, `[data-testid=case-${id}]`);
    await p.click('[data-testid=back-to-run]'); await p.waitForSelector('[data-testid=run-page]');
    await p.locator('[data-testid=case-intent-encoder-unreachable]').scrollIntoViewIfNeeded();
    await p.click('[data-testid=open-intent-encoder-unreachable]'); await p.waitForSelector('[data-testid=trace-page]');
    await p.click('[data-testid=back-to-run]'); await p.waitForSelector('[data-testid=run-page]');
    const byButton = await inView('intent-encoder-unreachable');
    await p.click('[data-testid=open-intent-encoder-unreachable]'); await p.waitForSelector('[data-testid=trace-page]');
    await p.goBack(); await p.waitForSelector('[data-testid=run-page]');
    check(`mock/${theme}: Back to Run and the browser Back both return to the Run page with the opened case in view`, byButton && await inView('intent-encoder-unreachable') && (await p.locator('[data-testid=trace-page]').count()) === 0);
    await p.click('[data-testid=open-mcp-allowed-key]'); await p.waitForSelector('[data-testid=lines-gateway-log]');
    await shot(p, `mock-${theme}-trace`, { fullPage: true });
    await jsonProof(p, `mock/${theme}`, `mock-${theme}`);
    const contrast = await p.evaluate(CONTRAST);
    const weak = contrast.filter((c) => c.ratio < 3);
    check(`mock/${theme}: every unselected control border is 3:1 or more (${contrast.length} checked)`, weak.length === 0, weak.slice(0, 3).map((w) => `${w.el} ${w.ratio.toFixed(2)}`).join('; '));
    await p.click('[data-testid=nav-scorecard]'); await p.waitForSelector('[data-testid=scorecard-table]');
    check(`mock/${theme}: scorecard has 17 measured rows and 17 "not measured" rows (no fabricated result)`, (await p.locator('[data-testid^=row-]').count()) === 34 && (await p.locator('[data-testid=row-keys-revoked] >> text=not measured').count()) === 4);
    const md = await p.inputValue('[data-testid=md-preview]');
    check(`mock/${theme}: Markdown export is one row per case and says not measured`, md.split('\n').filter((l) => l.startsWith('| ')).length === 36 && /Keys \| not measured/.test(md));
    await p.screenshot({ path: path.join(OUT, `mock-${theme}-scorecard.png`), fullPage: true });
    await p.click('[data-testid=nav-sinks]'); await p.waitForSelector('[data-testid=sinks-page]');
    check(`mock/${theme}: five sinks and an UNVERIFIED list`, (await p.locator('[data-testid^=sink-card-]').count()) === 5 && /UNVERIFIED/.test(await p.textContent('[data-testid=cannot-see]')));
    await p.screenshot({ path: path.join(OUT, `mock-${theme}-sinks.png`), fullPage: true });
    await p.click('[data-testid=nav-diagram]'); await p.waitForSelector('[data-testid=pattern-canvas]');
    const before = await p.$$eval('.react-flow__node', (ns) => ns.map((n) => n.style.transform));
    const box = await p.locator('.react-flow__node').first().boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p.mouse.down(); await p.mouse.move(box.x + 60, box.y + 120, { steps: 6 }); await p.mouse.up();
    const moved = await p.$$eval('.react-flow__node', (ns) => ns.map((n) => n.style.transform));
    check(`mock/${theme}: a diagram box can be moved`, JSON.stringify(before) !== JSON.stringify(moved));
    await p.click('[data-testid=pattern-reset]'); await p.waitForTimeout(150);
    const reset = await p.$$eval('.react-flow__node', (ns) => ns.map((n) => n.style.transform));
    check(`mock/${theme}: Reset restores the box positions`, JSON.stringify(reset) === JSON.stringify(before));
    await p.getByRole('button', { name: 'Simulate' }).click();
    check(`mock/${theme}: Simulate highlights an arrow`, (await p.locator('[data-testid=pattern-now]').count()) === 1);
    await p.screenshot({ path: path.join(OUT, `mock-${theme}-diagram.png`), fullPage: true });
    await p.click('[data-testid=presenter]');
    check(`mock/${theme}: presenter mode keeps the banner`, await p.isVisible('[data-testid=banner]') && await p.isVisible('[data-testid=presenter-say]'));
    await p.keyboard.press('Escape');
    // the one 409 is the deliberate "Real is not configured" probe above (the browser logs a refused request as a console error)
    const unexpected = errs.filter((e) => !/status of 409/.test(e));
    check(`mock/${theme}: no page or console errors (besides the one deliberate 409)`, unexpected.length === 0 && errs.length - unexpected.length === 1, errs.slice(0, 3).join(' | '));
    await ctx.close();
  }
  // 375px
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, colorScheme: 'dark' });
  const p = await ctx.newPage();
  for (const tab of ['run', 'trace', 'req9', 'scorecard', 'sinks', 'diagram', 'talk']) {
    await p.goto(`${BASE}#${tab}`); await p.waitForSelector('[data-testid=banner]'); await p.waitForTimeout(300);
    const w = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    check(`375px ${tab}: no horizontal page scroll`, w.sw <= w.iw, `${w.sw} <= ${w.iw}`);
    if (tab === 'run' || tab === 'scorecard') await p.screenshot({ path: path.join(OUT, `mock-375-${tab}.png`) });
    if (tab === 'trace') { await p.fill('[data-testid=paste-box]', 'time="2026-11-07T10:00:00Z" level=info msg="Access token found for user: u-1, client: lab-agent-key"'); await p.click('[data-testid=paste-score]'); await p.waitForSelector('[data-testid=paste-result] [role=tree]'); const w2 = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })); check('375px trace with a JSON tree: no horizontal page scroll', w2.sw <= w2.iw, `${w2.sw} <= ${w2.iw}`); await p.locator('[data-testid=paste-result]').scrollIntoViewIfNeeded(); await shot(p, 'mock-375-json'); }
  }
  await ctx.close();
  const outside = [...reqs].filter((o) => o !== new URL(BASE).origin);
  check('mock: the browser only talked to the app origin', outside.length === 0, outside.join(', '));
}

async function realProof(browser) {
  const gw = await fakeGateway({ audit: '{"user":"u-live","agent":"lab-agent-key","tool":"get_weather","decision":"allow"}' });
  const ctl = { mode: 'ok' };
  // A FAKE kubectl proxy: pod log lines for what the fake gateway received (slow on purpose, so the spinner can be seen).
  const k8s = await fakeK8s({ delayMs: 500, logText: () => (ctl.mode === 'ok' ? gatewayLog(gw).join('\n') : '') });
  const health = createHealth({ intervalMs: 3_600_000 }); await health.ready;
  const env = { STANDALONE_ENV: '/nonexistent', PRIV_LOG_GATEWAY_URL: gw.url, PRIV_LOG_AGENT_KEY: KEY, PRIV_LOG_K8S_PROXY_URL: k8s.base, PRIV_LOG_K8S_NAMESPACE: 'privilege', PRIV_LOG_K8S_POD: 'gateway-abc' };
  const app = await startHttpServer({ port: 0, host: '127.0.0.1', app: createApp({ health, env, useSettingsFile: false, retryMs: 400, maxMs: 2500, fallbackMs: 1500, mockDelayMs: 600 }) });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(app.url); await p.waitForSelector('[data-testid=run-page]');
  check('real: default mode is Real when configured, banner is live and says owner-run', (await p.inputValue('[data-testid=mode-select]')) === 'real' && /REAL \(owner-run\)/.test(await p.textContent('[data-testid=banner]')) && (await p.getAttribute('[data-testid=banner]', 'data-state')) === 'live');
  await shot(p, 'real-run');
  await p.locator('[data-testid=case-mcp-allowed-key]').scrollIntoViewIfNeeded(); await p.evaluate(() => window.scrollBy(0, 300));
  const yRun = await p.evaluate(() => window.scrollY);
  await p.click('[data-testid=run-mcp-allowed-key]'); await p.waitForSelector('[data-testid=confirm-gate]');
  check('real: the confirm gate opens inside the case card and the page does not scroll', (await p.locator('[data-testid=case-mcp-allowed-key] [data-testid=confirm-gate]').count()) === 1 && Math.abs((await p.evaluate(() => window.scrollY)) - yRun) < 2);
  check('real: confirm gate names the gateway and the k8s origin and nothing was sent yet', (await p.textContent('[data-testid=gate-gateway]')) === new URL(gw.url).origin && gw.requests.length === 0 && k8s.requests.length === 0);
  await p.click('[data-testid=gate-confirm]');
  await p.waitForFunction(() => /Sending|Fetching the log entry/.test(document.querySelector('[data-testid=busy-mcp-allowed-key]')?.textContent || ''));
  await p.waitForFunction(() => /Fetching the log entry\.\.\./.test(document.querySelector('[data-testid=busy-mcp-allowed-key]')?.textContent || ''));
  check('real: the page shows "Fetching the log entry..." with a spinner (role=status, aria-busy)', (await p.getAttribute('[data-testid=busy-mcp-allowed-key]', 'role')) === 'status' && (await p.getAttribute('[data-testid=case-mcp-allowed-key]', 'aria-busy')) === 'true' && (await p.locator('[data-testid=busy-mcp-allowed-key] .spinner').count()) === 1);
  await shot(p, 'real-fetching');
  await p.waitForSelector('[data-testid=open-mcp-allowed-key]', { timeout: 20000 });
  await p.waitForFunction(() => !document.querySelector('[data-testid=busy-mcp-allowed-key]'), null, { timeout: 20000 });
  check('real: after Send and the run, the page is still where it was', Math.abs((await p.evaluate(() => window.scrollY)) - yRun) < 40, `moved ${Math.round((await p.evaluate(() => window.scrollY)) - yRun)} px`);
  check('real: after the entry is fetched the page stays on Run (Open trace is a separate click)', (await p.locator('[data-testid=run-page]').count()) === 1 && (await p.locator('[data-testid=trace-page]').count()) === 0);
  await p.click('[data-testid=open-mcp-allowed-key]');
  await p.waitForSelector('[data-testid=lines-k8s-pod]', { timeout: 20000 });
  const allEntries = await p.locator('[data-testid=lines-k8s-pod] [data-testid=entry-item]').count();
  await p.click('[data-testid=lines-k8s-pod] [data-testid=tag-filter-open]');
  await p.click('[data-testid=lines-k8s-pod] [data-testid=filter-tag][data-tag="match:this call"]');
  const callOnly = await p.locator('[data-testid=lines-k8s-pod] [data-testid=entry-method]').allTextContents();
  check('real: the "this call" tag hides the time-window neighbours', callOnly.length > 0 && callOnly.length < allEntries && callOnly.every((t) => t === 'matched by marker'));
  await p.click('[data-testid=lines-k8s-pod] [data-testid=tag-filter-clear]');
  check('real: the MCP exchange ran (initialize, initialized, tools/call), each with traceparent, and the marker travelled in the tool argument', gw.requests.map((r) => JSON.parse(r.body).method).join(',') === 'initialize,notifications/initialized,tools/call' && gw.requests.every((r) => /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(r.headers.traceparent)) && /^audit-[0-9a-f]{8}$/.test(JSON.parse(gw.requests[2].body).params.arguments.city));
  const marker = (await p.textContent('[data-testid=trace-marker]')).trim();
  check('real: the log entry was found by the run marker, neighbours are labelled inferred', JSON.parse(gw.requests[2].body).params.arguments.city === marker && (await p.locator('[data-testid=entry-method]').allTextContents()).some((t) => t === 'matched by marker') && (await p.locator('[data-testid=entry-method]').allTextContents()).some((t) => /time window: inferred/.test(t)));
  check('real: the kubectl proxy was asked for the pod log with container, sinceSeconds and timestamps', k8s.requests.some((r) => /\/api\/v1\/namespaces\/privilege\/pods\/gateway-abc\/log\?container=log-tailer&sinceSeconds=\d+&timestamps=true/.test(r.url)));
  check('real: the gateway got the agent key; the page never shows it', gw.requests.every((r) => r.headers.authorization === `Bearer ${KEY}`) && !(await p.content()).includes(KEY));
  const marks = await p.$$eval('[data-testid=lines-k8s-pod] mark', (ms) => ms.map((m) => `${m.dataset.field}:${m.textContent}`));
  check('real: user, agent and tool values are marked in the retrieved tree', ['user:u-live', 'agent:lab-agent-key', 'tool:get_weather'].every((m) => marks.includes(m)), marks.join(' | '));
  check('real: raw hops show the key redacted', /authorization: Bearer \*\*\*/.test(await p.evaluate(() => { document.querySelectorAll('details.hop').forEach((d) => { d.open = true; }); return document.body.textContent; })));
  await shot(p, 'real-trace-json', { fullPage: true });
  // the log source goes away: explicit failure with Retry
  ctl.mode = 'empty'; k8s.requests.length = 0;
  await p.click('[data-testid=nav-run]'); await p.click('[data-testid=run-mcp-list-filtered]');
  await p.waitForFunction(() => /No entry found yet after/.test(document.querySelector('[data-testid=busy-mcp-list-filtered]')?.textContent || ''), null, { timeout: 15000 });
  check('real: while nothing is found the page says so and that it is retrying', /retrying until 3 s/.test(await p.textContent('[data-testid=busy-mcp-list-filtered]')));
  await p.waitForFunction(() => /No entry found within 3 s/.test(document.querySelector('[data-testid=busy-mcp-list-filtered]')?.textContent || ''), null, { timeout: 15000 });
  check('real: no entry within the limit is explicit, with Retry and the paste fallback', (await p.locator('[data-testid=retry-mcp-list-filtered]').count()) === 1 && /paste the gateway log lines/.test(await p.textContent('[data-testid=busy-mcp-list-filtered]')));
  await p.locator('[data-testid=case-mcp-list-filtered]').scrollIntoViewIfNeeded(); await shot(p, 'real-timeout');
  const before = gw.requests.length;
  ctl.mode = 'ok'; await p.click('[data-testid=retry-mcp-list-filtered]');
  await p.waitForFunction(() => !document.querySelector('[data-testid=busy-mcp-list-filtered]'), null, { timeout: 15000 });
  check('real: Retry fetches again without sending the call a second time and the score appears', gw.requests.length === before && (await p.locator('[data-testid=case-mcp-list-filtered] [aria-label=score]').count()) === 1);
  // log source unreachable
  await k8s.close();
  await p.click('[data-testid=run-mcp-allowed-user]');
  await p.waitForFunction(() => /Log source not reachable/.test(document.querySelector('[data-testid=busy-mcp-allowed-user]')?.textContent || ''), null, { timeout: 20000 });
  check('real: an unreachable log source is explicit and offers Retry', (await p.getAttribute('[data-testid=busy-mcp-allowed-user]', 'role')) === 'alert' && (await p.locator('[data-testid=retry-mcp-allowed-user]').count()) === 1);
  await p.locator('[data-testid=case-mcp-allowed-user]').scrollIntoViewIfNeeded(); await shot(p, 'real-unreachable');
  // real-only cases in Real: write-only credential
  await p.fill('[data-testid=bearer-input-keys-revoked]', 'owner-bearer-NOT-REAL-5d2e8f10'); await p.click('[data-testid=bearer-set-keys-revoked]'); await p.waitForSelector('[data-testid=bearer-on-keys-revoked]');
  check('real: the case credential field is write-only (password, cleared, never in the page)', (await p.getAttribute('[data-testid=bearer-input-keys-revoked]', 'type')) === 'password' && (await p.inputValue('[data-testid=bearer-input-keys-revoked]')) === '' && !(await p.content()).includes('owner-bearer-NOT-REAL-5d2e8f10'));
  await p.selectOption('[data-testid=mode-select]', 'mock'); await p.waitForFunction(() => document.querySelector('[data-testid=mode-select]').value === 'mock');
  const sent = gw.requests.length;
  await p.click('[data-testid=nav-run]'); await p.click('[data-testid=run-no-credential]');
  await p.click('[data-testid=open-no-credential]', { timeout: 15000 });
  await p.waitForSelector('[data-testid=lines-gateway-log]', { timeout: 15000 });
  check('real->mock: switching back replays offline (the fake gateway saw no new request)', gw.requests.length === sent);
  await p.selectOption('[data-testid=mode-select]', 'real'); await p.waitForFunction(() => document.querySelector('[data-testid=mode-select]').value === 'real');
  check('mock->real: switching again works without a reload', (await p.textContent('[data-testid=banner]')).includes('REAL (owner-run)'));
  check('real: no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
  await new Promise((r) => app.server.close(r)); health.stop(); await gw.close();
}

const browser = await launch();
try {
  if (which === 'mock' || which === 'all') await mockProof(browser);
  if (which === 'real' || which === 'all') await realProof(browser);
} finally { await browser.close(); }
fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, checks: evidence }, null, 2));
console.log(`${evidence.length - failed}/${evidence.length} checks passed`);
process.exit(failed ? 1 : 0);
