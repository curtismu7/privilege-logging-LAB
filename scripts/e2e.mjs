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
import { KEY, fakeGateway, fakeSearch } from '../server/test/helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'e2e-output');
fs.mkdirSync(OUT, { recursive: true });
const [which = 'all', baseArg] = process.argv.slice(2);
const BASE = (baseArg || 'http://127.0.0.1:7801/').replace(/\/?$/, '/');
const evidence = []; let failed = 0;
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

async function mockProof(browser) {
  const reqs = new Set();
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    p.on('request', (r) => reqs.add(new URL(r.url()).origin));
    await p.goto(BASE); await p.waitForSelector('[data-testid=run-page]');
    await p.selectOption('[data-testid=theme]', theme);
    check(`mock/${theme}: data-theme applied`, await p.evaluate(() => document.documentElement.getAttribute('data-theme')) === theme);
    check(`mock/${theme}: banner says replay and nothing is sent`, /Replay of transactions measured on 2026-11-07; nothing is sent\./.test(await p.textContent('[data-testid=banner]')));
    check(`mock/${theme}: Mock pressed, Real disabled with a how-to tooltip`, (await p.getAttribute('[data-testid=mode-mock]', 'aria-pressed')) === 'true' && await p.isDisabled('[data-testid=mode-real]') && /PRIV_LOG_GATEWAY_URL/.test(await p.getAttribute('[data-testid=mode-real]', 'title')));
    const info = await (await p.request.get(`${BASE}api/info`)).json();
    check(`mock/${theme}: /api/info source=mock realAvailable=false`, info.source === 'mock' && info.realAvailable === false);
    const real409 = await p.evaluate(async () => (await fetch('/api/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"source":"real"}' })).status);
    check(`mock/${theme}: POST /api/mode real answers 409 when not configured`, real409 === 409);
    await p.screenshot({ path: path.join(OUT, `mock-${theme}-run.png`) });
    await p.click('[data-testid=run-all]');
    await p.waitForSelector('[data-testid=open-intent-encoder-unreachable]', { timeout: 15000 });
    check(`mock/${theme}: Run all replayed 17 cases`, (await p.locator('[data-testid^=open-]').count()) === 17);
    const runContrast = (await p.evaluate(CONTRAST)).filter((c) => c.ratio < 3);
    check(`mock/${theme}: run page unselected control borders are 3:1 or more`, runContrast.length === 0, runContrast.slice(0, 3).map((w) => `${w.el} ${w.ratio.toFixed(2)}`).join('; '));
    await p.click('[data-testid=open-mcp-allowed-key]'); await p.waitForSelector('[data-testid=lines-gateway-log]');
    const marks = await p.$$eval('[data-testid=lines-gateway-log] mark', (ms) => ms.map((m) => `${m.dataset.field}:${m.textContent}`));
    check(`mock/${theme}: trace marks user, agent, tool and decision inline`, ['user', 'agent', 'tool', 'decision'].every((f) => marks.some((m) => m.startsWith(`${f}:`))), marks.join(' | '));
    await p.screenshot({ path: path.join(OUT, `mock-${theme}-trace.png`), fullPage: true });
    const contrast = await p.evaluate(CONTRAST);
    const weak = contrast.filter((c) => c.ratio < 3);
    check(`mock/${theme}: every unselected control border is 3:1 or more (${contrast.length} checked)`, weak.length === 0, weak.slice(0, 3).map((w) => `${w.el} ${w.ratio.toFixed(2)}`).join('; '));
    await p.click('[data-testid=nav-scorecard]'); await p.waitForSelector('[data-testid=scorecard-table]');
    check(`mock/${theme}: scorecard has 17 rows`, (await p.locator('[data-testid^=row-]').count()) === 17);
    const md = await p.inputValue('[data-testid=md-preview]');
    check(`mock/${theme}: Markdown export is one row per case`, md.split('\n').filter((l) => l.startsWith('| ')).length === 19);
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
  for (const tab of ['run', 'trace', 'scorecard', 'sinks', 'diagram', 'talk']) {
    await p.goto(`${BASE}#${tab}`); await p.waitForSelector('[data-testid=banner]'); await p.waitForTimeout(300);
    const w = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    check(`375px ${tab}: no horizontal page scroll`, w.sw <= w.iw, `${w.sw} <= ${w.iw}`);
    if (tab === 'run' || tab === 'scorecard') await p.screenshot({ path: path.join(OUT, `mock-375-${tab}.png`) });
  }
  await ctx.close();
  const outside = [...reqs].filter((o) => o !== new URL(BASE).origin);
  check('mock: the browser only talked to the app origin', outside.length === 0, outside.join(', '));
}

async function realProof(browser) {
  const gw = await fakeGateway({ audit: '{"user":"u-live","agent":"audit-test","tool":"get_weather","decision":"allow"}' });
  // The fake search serves these events whatever the time range asked for (the page runs the case at an unpredictable moment).
  const stamp = () => new Date().toISOString();
  const search = await fakeSearch({ ignoreRange: true, events: [
    { '@timestamp': stamp(), message: 'Access token found for user: u-live, client: audit-test' },
    { '@timestamp': stamp(), message: 'Principal {User u-live} has policy based capabilities for {Application demo-mcp-app}' },
    { '@timestamp': stamp(), message: 'MCP call detected for method tools with target: get_weather' },
  ] });
  const health = createHealth({ intervalMs: 3_600_000 }); await health.ready;
  const env = { STANDALONE_ENV: '/nonexistent', PRIV_LOG_GATEWAY_URL: gw.url, PRIV_LOG_AGENT_KEY: KEY, PRIV_LOG_SEARCH_URL: search.base, PRIV_LOG_SEARCH_INDEX: 'gateway-events' };
  const app = await startHttpServer({ port: 0, host: '127.0.0.1', app: createApp({ health, env, useSettingsFile: false, sleep: async () => {} }) });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(app.url); await p.waitForSelector('[data-testid=run-page]');
  check('real: default mode is Real when configured, banner is live and says owner-run', (await p.getAttribute('[data-testid=mode-real]', 'aria-pressed')) === 'true' && /REAL \(owner-run\)/.test(await p.textContent('[data-testid=banner]')) && (await p.getAttribute('[data-testid=banner]', 'data-state')) === 'live');
  await p.screenshot({ path: path.join(OUT, 'real-run.png') });
  await p.click('[data-testid=run-mcp-allowed-key]'); await p.waitForSelector('[data-testid=confirm-gate]');
  check('real: confirm gate names the gateway origin and nothing was sent yet', (await p.textContent('[data-testid=gate-gateway]')) === new URL(gw.url).origin && gw.requests.length === 0);
  await p.screenshot({ path: path.join(OUT, 'real-confirm-gate.png') });
  await p.click('[data-testid=gate-confirm]'); await p.waitForSelector('[data-testid=open-mcp-allowed-key]');
  check('real: after confirming, the MCP exchange ran: initialize, initialized, tools/call, each with traceparent', gw.requests.map((r) => JSON.parse(r.body).method).join(',') === 'initialize,notifications/initialized,tools/call' && gw.requests.every((r) => /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(r.headers.traceparent)));
  check('real: the gateway got the agent key; the page never shows it', gw.requests.every((r) => r.headers.authorization === `Bearer ${KEY}`) && !(await p.content()).includes(KEY));
  await p.click('[data-testid=open-mcp-allowed-key]'); await p.waitForSelector('[data-testid=lines-search]');
  const marks = await p.$$eval('[data-testid=lines-search] mark', (ms) => ms.map((m) => `${m.dataset.field}:${m.textContent}`));
  check('real: log events read back from the search endpoint are marked inline', marks.some((m) => m === 'user:u-live') && marks.some((m) => m === 'tool:get_weather'), marks.join(' | '));
  check('real: the score comes from the returned lines', (await p.textContent('[data-testid=score]')).split('met').length - 1 >= 3);
  check('real: raw hops show the key redacted', /authorization: Bearer \*\*\*/.test(await p.evaluate(() => { document.querySelectorAll('details.hop').forEach((d) => { d.open = true; }); return document.body.textContent; })));
  await p.screenshot({ path: path.join(OUT, 'real-trace.png'), fullPage: true });
  await p.click('[data-testid=mode-mock]'); await p.waitForFunction(() => document.querySelector('[data-testid=mode-mock]').getAttribute('aria-pressed') === 'true');
  const before = gw.requests.length;
  await p.click('[data-testid=nav-run]'); await p.click('[data-testid=run-all]'); await p.waitForSelector('[data-testid=open-intent-encoder-unreachable]', { timeout: 15000 });
  check('real->mock: switching back replays offline (the fake gateway saw no new request)', gw.requests.length === before);
  await p.click('[data-testid=mode-real]'); await p.waitForFunction(() => document.querySelector('[data-testid=mode-real]').getAttribute('aria-pressed') === 'true');
  check('mock->real: switching again works without a reload', (await p.textContent('[data-testid=banner]')).includes('REAL (owner-run)'));
  check('real: no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
  await new Promise((r) => app.server.close(r)); health.stop(); await gw.close(); await search.close();
}

const browser = await launch();
try {
  if (which === 'mock' || which === 'all') await mockProof(browser);
  if (which === 'real' || which === 'all') await realProof(browser);
} finally { await browser.close(); }
fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, checks: evidence }, null, 2));
console.log(`${evidence.length - failed}/${evidence.length} checks passed`);
process.exit(failed ? 1 : 0);
