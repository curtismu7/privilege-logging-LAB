// The Privilege-hosted logs source: Privilege's own indices, read through the console's elasticlog API (a fake console here).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { realConfig } from '../src/config.js';
import { installNetguard, setAllowedHosts } from '../src/netguard.js';
import { createRealClient } from '../src/realClient.js';
import { scoreLines } from '../src/scorer.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONSOLE_TENANT, KEY, NOENV, consoleEnv, fakeConsole, fakeGateway, get, post, runAndFetch, withServer } from './helpers.js';

let guard;
before(() => { guard = installNetguard(); });
after(() => guard.restore());

const iso = (t) => new Date(t).toISOString();
const confirm = (url, gw) => post(url, '/api/confirm', { gateway: new URL(gw.base).origin });
const noKey = (x) => assert.ok(!JSON.stringify(x).includes(KEY), 'the agent key appears in an answer');
// The shape of a real record (2026-11-07), with placeholder values.
const rec = (at, app, data = {}) => ({ '@timestamp': at, Level: 'INFO', Message: 'AIPolicyDecision', Data: {
  AgentKey: 'lab-test-key', App: app, BaselinePhase: 'learning', Decision: 'deny', Event: 'policy_decision', Flow: 'mcp', Method: 'tools/call',
  PolicyIDs: ['block-generic:1'], Principal: 'User::"u-1111"', PrincipalKind: 'User', Reason: 'blocked outright, no approval path', RequestID: 'req-1',
  Target: 'get_weather', User: 'u-1111', ...data } });

test('scorer: a decision record carries all four fields (user, agent key, tool, decision), and a hold counts as a decision', () => {
  const r = scoreLines([JSON.stringify(rec('2026-11-07T22:15:52Z', 'demo-mcp-app'))]);
  assert.deepEqual(r.score, { user: 'met', agent: 'met', tool: 'met', decision: 'met' });
  assert.equal(scoreLines([JSON.stringify(rec('2026-11-07T22:16:43Z', 'demo-mcp-app', { Decision: 'hitl' }))]).score.decision, 'met');
});

test('Real: the run reads the decision log for the call window; only this app\'s record is shown, labelled window (inferred) and live, and it is scored', async () => {
  const gw = await fakeGateway();
  const cons = await fakeConsole({ records: () => {
    const at = gw.requests.at(-1)?.at ?? Date.now();
    return [rec(iso(at + 100), 'demo-mcp-app'), rec(iso(at + 150), 'some-other-app', { Target: 'other_tool' }), rec(iso(at - 600_000), 'demo-mcp-app', { RequestID: 'old' })];
  } });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const { final } = await runAndFetch(url, 'mcp-allowed-key');
      assert.equal(final.retrieval.state, 'found');
      const d = final.logged.find((l) => l.source === 'privilege-hosted');
      assert.ok(d, 'the Privilege-logs entry group is there');
      assert.equal(d.lines.length, 1, 'only the call window and only this app');
      assert.ok(d.lines[0].includes('"App":"demo-mcp-app"') && !d.lines[0].includes('"RequestID":"old"'));
      assert.deepEqual(d.methods, ['window']);
      assert.equal(d.origin.live, true); assert.match(d.origin.system, /Privilege logs/); assert.match(d.origin.where, /read through the Privilege console http:\/\/127\.0\.0\.1:\d+ \(elasticlog\)/);
      assert.deepEqual(final.score, { user: 'met', agent: 'met', tool: 'met', decision: 'met' });
      // the exact console request
      const q = cons.requests[0];
      assert.equal(q.method, 'POST'); assert.equal(q.url, `/api/${CONSOLE_TENANT}/v1/elasticlog`);
      assert.match(q.headers['x-procyon-session-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const body = JSON.parse(q.body);
      assert.deepEqual(body.Indices.Elems.slice().sort(), ['agent-approval-log', 'aiguard-log', 'audit-log', 'event-log', 'policy-decision-log', 'proxy-audit-log', 'proxy-event-log']); assert.equal(body.ObjectMeta.Tenant, CONSOLE_TENANT);
      assert.ok(Date.parse(body.StartTime) < Date.parse(body.EndTime));
      assert.ok(!q.headers.authorization, 'the agent key is never sent to the console');
      assert.ok(final.hops.some((h) => /Privilege\'s logs through the console/.test(h.label)));
      noKey(final);
    }, { env: consoleEnv(gw, cons) });
  } finally { await gw.close(); await cons.close(); }
});

test('Real: a console that refuses (403) or answers another shape is "log source not reachable" with the reason; nothing is scored', async () => {
  for (const [opts, re] of [[{ status: 403, raw: '{"error":"forbidden"}' }, /HTTP 403 \(is the PingOne Privilege desktop app running and signed in\?\)/], [{ raw: '{"Response":"%%%not base64 json%%%"}' }, /holds no log records/]]) {
    const gw = await fakeGateway(); const cons = await fakeConsole(opts);
    try {
      await withServer(async (url) => {
        await confirm(url, gw);
        const { final } = await runAndFetch(url, 'mcp-allowed-key');
        assert.equal(final.retrieval.state, 'unreachable'); assert.match(final.retrieval.detail, re); assert.equal(final.scored, false);
      }, { env: consoleEnv(gw, cons) });
    } finally { await gw.close(); await cons.close(); }
  }
});

test('config: the console source needs both settings, a UUID tenant and https (http only on loopback)', () => {
  const base = { ...NOENV, PRIV_LOG_GATEWAY_URL: 'https://gw.example.invalid/demo-mcp-app/mcp', PRIV_LOG_AGENT_KEY: KEY };
  const cfg = (extra) => realConfig({ ...base, ...extra }, { file: false });
  assert.match(cfg({ PRIV_LOG_CONSOLE_URL: 'https://console.example.invalid' }).problem, /needs both PRIV_LOG_CONSOLE_URL and PRIV_LOG_CONSOLE_TENANT/);
  assert.match(cfg({ PRIV_LOG_CONSOLE_URL: 'https://console.example.invalid', PRIV_LOG_CONSOLE_TENANT: 'not-a-uuid' }).problem, /must be the tenant id/);
  assert.match(cfg({ PRIV_LOG_CONSOLE_URL: 'http://console.example.invalid', PRIV_LOG_CONSOLE_TENANT: CONSOLE_TENANT }).problem, /must be https unless it is on loopback/);
  assert.match(cfg({ PRIV_LOG_CONSOLE_URL: 'https://console.example.invalid/api', PRIV_LOG_CONSOLE_TENANT: CONSOLE_TENANT }).problem, /origin with no path/);
  const ok = cfg({ PRIV_LOG_CONSOLE_URL: 'https://console.example.invalid:8643', PRIV_LOG_CONSOLE_TENANT: CONSOLE_TENANT.toUpperCase() });
  assert.equal(ok.ok, true); assert.equal(ok.decisions.origin, 'https://console.example.invalid:8643'); assert.equal(ok.decisions.tenant, CONSOLE_TENANT);
});

test('client: a configured console name may resolve to loopback; every other name, and any other private answer, is still refused', async () => {
  setAllowedHosts(['console.example.invalid']);
  try {
    const at = (address) => (h, o, cb) => (typeof o === 'function' ? o : cb)(null, [{ address, family: 4 }]);
    const req = (client) => client.request({ url: 'https://console.example.invalid:9/x' }).then(() => null, (e) => e.code);
    assert.equal(await req(createRealClient({ origins: ['https://console.example.invalid:9'], lookup: at('127.0.0.1') })), 'blocked_address', 'not listed: loopback answer refused');
    assert.notEqual(await req(createRealClient({ origins: ['https://console.example.invalid:9'], lookup: at('127.0.0.1'), loopbackNames: ['console.example.invalid'] })), 'blocked_address', 'listed: loopback allowed');
    assert.equal(await req(createRealClient({ origins: ['https://console.example.invalid:9'], lookup: at('10.0.0.5'), loopbackNames: ['console.example.invalid'] })), 'blocked_address', 'listed: a private non-loopback answer is still refused');
  } finally { setAllowedHosts([]); }
});

test('Real: every Privilege entry says which index it came from and whether it is a console or a runtime event', async () => {
  const gw = await fakeGateway();
  const cons = await fakeConsole({ records: () => {
    const at = gw.requests.at(-1)?.at ?? Date.now();
    return [
      rec(iso(at + 100), 'demo-mcp-app', { Decision: 'hitl' }),
      { _index: 'proxy-audit-log', '@timestamp': iso(at + 120), Level: 'INFO', Message: 'Received HTTP request', Data: { Path: '/demo-mcp-app/mcp', Method: 'POST', User: 'u-1111' } },
      { _index: 'proxy-audit-log', '@timestamp': iso(at + 130), Level: 'INFO', Message: 'Received HTTP request', Data: { Path: '/some-other-app/mcp', Method: 'POST' } },
      { _index: 'audit-log', '@timestamp': iso(at + 140), Level: 'INFO', Module: 'apigw', Message: 'HTTP PUT Request console.example.invalid/api/x', Data: 'agent key updated', User: { Name: 'admin@example.invalid' } },
      { _index: 'not-a-privilege-index', '@timestamp': iso(at + 150), Message: 'stray', Data: { x: 1 } },
    ];
  } });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const { final } = await runAndFetch(url, 'mcp-allowed-key');
      const d = final.logged.find((l) => l.source === 'privilege-hosted');
      const rows = d.lines.map((t, i) => [d.indices[i], d.kinds[i], t]);
      assert.ok(!rows.some(([, , t]) => t.includes('some-other-app')), 'a record for another app (by Data.Path) is not shown');
      const by = Object.fromEntries(rows.map(([ix, k]) => [ix, k]));
      assert.equal(by['policy-decision-log'], 'runtime');
      assert.equal(by['proxy-audit-log'], 'runtime');
      assert.equal(by['audit-log'], 'console');
      assert.ok(rows.some(([ix, k]) => ix === null && k === 'runtime'), 'an index the lab does not know is kept unnamed and classified by its shape');
      assert.equal(d.kinds.length, d.lines.length); assert.equal(d.indices.length, d.lines.length);
    }, { env: consoleEnv(gw, cons) });
  } finally { await gw.close(); await cons.close(); }
});

test('Mock: each recorded entry carries its sink\'s kind (gateway log = runtime, Elasticsearch ping-siem-events = console)', async () => {
  await withServer(async (url) => {
    const { final: r } = await runAndFetch(url, 'mcp-allowed-key');
    const g = r.logged.find((l) => l.source === 'gateway-log');
    assert.ok(g.kinds.length === g.lines.length && g.kinds.every((k) => k === 'runtime'));
    const e = r.logged.find((l) => l.source === 'elasticsearch');
    if (e) assert.ok(e.kinds.every((k) => k === 'console'));
  });
});

test('Privilege -> Elasticsearch page API: Mock is the recorded sample; Real reads the console for the last N minutes, needs the confirm, labels every entry', async () => {
  await withServer(async (url) => {
    const m = await (await get(url, '/api/privilege-logs?minutes=60')).json();
    assert.equal(m.source, 'mock'); assert.equal(m.entries.length, 5); assert.ok(m.entries.every((e) => e.index === 'policy-decision-log' && e.kind === 'runtime'));
    assert.ok(!JSON.stringify(m).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/), 'the sample carries placeholders, not ids');
    assert.equal((await get(url, '/api/privilege-logs?minutes=0')).status, 400);
  });
  const gw = await fakeGateway();
  const cons = await fakeConsole({ records: () => [rec(iso(Date.now() - 60_000), 'demo-mcp-app'), { _index: 'audit-log', '@timestamp': iso(Date.now() - 30_000), Module: 'apigw', Message: 'HTTP PUT Request', Data: 'changed' }, rec(iso(Date.now() - 7_200_000), 'demo-mcp-app')] });
  try {
    await withServer(async (url) => {
      assert.equal((await get(url, '/api/privilege-logs?minutes=60')).status, 412, 'not before the origins are confirmed');
      await confirm(url, gw);
      const r = await (await get(url, '/api/privilege-logs?minutes=60')).json();
      assert.equal(r.source, 'real'); assert.equal(r.entries.length, 2, 'only the asked time range');
      assert.deepEqual(r.entries.map((e) => [e.index, e.kind]).sort(), [['audit-log', 'console'], ['policy-decision-log', 'runtime']]);
      assert.match(r.channel, /Privilege -> Elasticsearch/); noKey(r);
    }, { env: consoleEnv(gw, cons) });
  } finally { await gw.close(); await cons.close(); }
});

test('config: PRIV_LOG_CONSOLE_CA must be a readable PEM file; it is kept for the console origin only', () => {
  const base = { ...NOENV, PRIV_LOG_GATEWAY_URL: 'https://gw.example.invalid/demo-mcp-app/mcp', PRIV_LOG_AGENT_KEY: KEY, PRIV_LOG_CONSOLE_URL: 'https://console.example.invalid:8643', PRIV_LOG_CONSOLE_TENANT: CONSOLE_TENANT };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-ca-'));
  try {
    const good = path.join(dir, 'ca.pem'); fs.writeFileSync(good, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    const bad = path.join(dir, 'x.txt'); fs.writeFileSync(bad, 'not a cert');
    assert.match(realConfig({ ...base, PRIV_LOG_CONSOLE_CA: path.join(dir, 'missing.pem') }, { file: false }).problem, /not a readable file/);
    assert.match(realConfig({ ...base, PRIV_LOG_CONSOLE_CA: bad }, { file: false }).problem, /must be a PEM certificate/);
    assert.match(realConfig({ ...base, PRIV_LOG_CONSOLE_CA: good }, { file: false }).decisions.ca, /BEGIN CERTIFICATE/);
    assert.equal(realConfig(base, { file: false }).decisions.ca, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Privilege logs carry keys in full (aiguard VirtualKeyID, an agent save\'s RealKey): none reaches the page or the raw hop', async () => {
  const VK = 'sk-orion-' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4'; const RK = 'sk-ant-api03-' + 'Z'.repeat(80) + 'QwEr';
  const gw = await fakeGateway();
  const cons = await fakeConsole({ records: () => {
    const at = gw.requests.at(-1)?.at ?? Date.now();
    return [{ _index: 'aiguard-log', '@timestamp': iso(at + 50), Message: 'AIGuard', Data: { App: 'demo-mcp-app', Client: 'lab-test-key', VirtualKeyID: VK } },
      { _index: 'audit-log', '@timestamp': iso(at + 60), Module: 'apigw', Message: 'HTTP PUT Request', Data: JSON.stringify({ Spec: { RealKey: RK, RPMLimit: 60 } }) }];
  } });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const { final } = await runAndFetch(url, 'mcp-allowed-key');
      const page = await (await get(url, '/api/privilege-logs?minutes=5')).json();
      for (const x of [final, page]) { const t = JSON.stringify(x); assert.ok(!t.includes(VK) && !t.includes(RK), 'a key reached an answer'); assert.ok(!t.includes(Buffer.from(VK).toString('base64').slice(0, 20))); }
      assert.ok(final.logged.find((l) => l.source === 'privilege-hosted').lines.some((l) => l.includes('sk-orion***') && l.includes(VK.slice(-4))), 'masked to prefix and last four');
      assert.ok(final.hops.some((h) => typeof h.response === 'string' ? /not shown here/.test(h.response) : /not shown here/.test(JSON.stringify(h))), 'the raw hop shows the size of the base64 answer, not the answer');
    }, { env: consoleEnv(gw, cons) });
  } finally { await gw.close(); await cons.close(); }
});
