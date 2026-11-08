// Requirement 9 (the audit map): pure coverage, picker, links and ledger; GET /api/req9 in Mock (the recorded sample, placeholder
// values) and in Real against a FAKE console (confirm gate, two indices, cache, deep link, key never returned); the diagram data.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installNetguard } from '../src/netguard.js';
import { entriesOf, fieldsOf } from '../src/privilegeExplorer.js';
import { RID, buildReq9, coverageOf, linkedOf, pickerOf, recordOf } from '../src/req9.js';
import { loadDiagram, buildDiagram, DIAGRAM_NAMES } from '../src/diagramData.js';
import { validateDiagram } from '../src/diagramStudioValidate.js';
import { buildReq9Diagram } from '../../scripts/build-diagrams.mjs';
import { KEY, NOENV, consoleEnv, fakeConsole, fakeGateway, get, post, withServer } from './helpers.js';

let guard;
before(() => { guard = installNetguard(); });
after(() => guard.restore());

const iso = (t) => new Date(t).toISOString();
const json = async (url, p) => { const r = await get(url, p); return { status: r.status, body: await r.json() }; };
const dec = (at, data = {}) => ({ _index: 'policy-decision-log', '@timestamp': iso(at), Level: 'INFO', Message: 'AIPolicyDecision', Data: { AgentKey: 'lab-test-key', App: 'demo-mcp-app', Decision: 'hitl', Event: 'policy_decision', Method: 'tools/call', PolicyIDs: ['p:1'], PrincipalKind: 'User', Reason: 'r', RequestID: 'req-1', Target: 'get_weather', User: 'u-1111', ...data } });
const httpRec = (at, data = {}) => ({ _index: 'proxy-audit-log', '@timestamp': iso(at), Message: 'Received HTTP request', Data: { Method: 'POST', Path: '/demo-mcp-app/mcp', User: 'u-1111', ...data } });
const asEntries = (recs) => entriesOf(recs.map(({ _index, ...r }) => ({ _index, _source: r })));
const T = Date.parse('2026-11-07T22:00:00Z');

test('fields: Method, Path and PolicyIDs are parsed (and redacted) for the audit map', () => {
  const f = fieldsOf({ Data: { Method: 'tools/call', Path: '/app/mcp', PolicyIDs: ['a:1', 'b:2', 7] } });
  assert.deepEqual([f.method, f.path, f.policyIds], ['tools/call', '/app/mcp', 'a:1, b:2']);
  assert.equal(fieldsOf({ Data: { PolicyIDs: 'one:1' } }).policyIds, 'one:1');
  assert.equal(fieldsOf({ Data: { Path: `/x?q=${'eyJ'}hbGciOi.payload12.sigsig` } }).path.includes('payload12'), false, 'a JWT in a path is masked');
});

test('RequestID pattern: letters, digits, _ and -, 1 to 64', () => {
  for (const ok of ['a', '0000000000000a01', 'req_1-x', 'x'.repeat(64)]) assert.ok(RID.test(ok), ok);
  for (const bad of ['', 'x'.repeat(65), '<id>', 'a b', 'a/b', 'a.b', '%2e']) assert.ok(!RID.test(bad), bad);
});

test('coverage: a-d counted over every decision record; b partial without an agent key; d partial when only HTTP records show allowed calls', () => {
  const e = asEntries([dec(T), dec(T + 1000, { AgentKey: undefined }), dec(T + 2000, { Decision: 'deny', RequestID: 'req-2' }), httpRec(T + 3000)]);
  const decisions = e.filter((x) => x.index === 'policy-decision-log').map(recordOf);
  const http = e.filter((x) => x.index === 'proxy-audit-log');
  const c = coverageOf(decisions, http);
  assert.deepEqual(Object.fromEntries(Object.entries(c.parts).map(([k, v]) => [k, [v.count, v.total, v.status]])), { a: [3, 3, 'met'], b: [2, 3, 'partial'], c: [3, 3, 'met'], d: [3, 3, 'partial'] });
  assert.deepEqual([c.noAgent, c.http.records, c.byDecision.deny, c.byDecision.hitl], [1, 1, 1, 2]);
  assert.equal(coverageOf(decisions, []).parts.d.status, 'met', 'no HTTP evidence of an allowed call: d is met on the decisions');
  assert.equal(coverageOf([], []).parts.a.status, 'missing');
});

test('picker hides a hold whose decision is listed; links: same RequestID, then the release by user, tool and time (new RequestID)', () => {
  const recs = [dec(T), dec(T + 900, { Event: 'policy_approval_required' }), dec(T + 30_000, { Event: 'policy_approval_released', Decision: 'allow', RequestID: 'req-9' }),
    dec(T + 11 * 60_000, { Event: 'policy_approval_released', Decision: 'allow', RequestID: 'req-late' }), dec(T + 40_000, { Event: 'policy_approval_released', Decision: 'allow', RequestID: 'req-other', Target: 'other_tool' })];
  const decisions = asEntries(recs).map(recordOf);
  const picker = pickerOf(decisions);
  assert.equal(picker.some((r) => r.event === 'policy_approval_required'), false);
  assert.deepEqual(picker.map((r) => r.requestId), ['req-late', 'req-other', 'req-9', 'req-1'], 'newest first');
  const hold = picker.find((r) => r.requestId === 'req-1');
  assert.deepEqual(linkedOf(hold, decisions, []).map((l) => [l.event, l.requestId, l.via]), [['policy_approval_required', 'req-1', 'same RequestID'], ['policy_approval_released', 'req-9', 'matched by user, tool and time']]);
  const rel = picker.find((r) => r.requestId === 'req-9');
  assert.deepEqual(linkedOf(rel, decisions, []).map((l) => [l.requestId, l.via]), [['req-1', 'matched by user, tool and time']]);
  assert.deepEqual(linkedOf(picker.find((r) => r.requestId === 'req-late'), decisions, []), [], 'more than 10 minutes after the hold is not matched');
  assert.deepEqual(linkedOf(null, decisions, []), []);
});

test('buildReq9: a requested RequestID is selected; an unknown one falls back to the newest with a note; a pattern not seen says so', () => {
  const e = asEntries([dec(T), dec(T + 5000, { RequestID: 'req-2', Decision: 'deny' })]);
  assert.equal(buildReq9(e).selected.record.requestId, 'req-2');
  assert.equal(buildReq9(e).selected.note, null);
  const one = buildReq9(e, { rid: 'req-1' });
  assert.deepEqual([one.selected.record.requestId, one.selected.found, one.selected.note], ['req-1', true, null]);
  const miss = buildReq9(e, { rid: 'nope' });
  assert.deepEqual([miss.selected.record.requestId, miss.selected.found], ['req-2', false]);
  assert.match(miss.selected.note, /not among the decision records read; showing the newest/);
  const rows = Object.fromEntries(miss.ledger.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(rows), ['full-held', 'full-denied', 'non-human', 'no-agent', 'released-new-rid', 'plain-allowed']);
  for (const id of ['non-human', 'no-agent', 'released-new-rid', 'plain-allowed']) assert.equal(rows[id].found, false, id);
  assert.match(buildReq9([]).selected.note, /No policy decision record/);
});

test('Mock API: the recorded sample (placeholder values) gives every pattern, the deep link and the fallback', async () => {
  await withServer(async (url) => {
    const r = (await json(url, '/api/req9')).body;
    assert.equal(r.source, 'mock'); assert.match(r.label, /placeholder/); assert.equal(r.deepLink, '#req9/<RequestID>');
    assert.deepEqual(['a', 'b', 'c', 'd'].map((k) => [r.coverage.parts[k].count, r.coverage.parts[k].status]), [[8, 'met'], [4, 'partial'], [8, 'met'], [8, 'partial']]);
    assert.deepEqual([r.coverage.total, r.coverage.noAgent, r.coverage.nonHuman, r.coverage.http.records], [8, 4, 1, 3]);
    assert.equal(r.records.length, 6); assert.equal(r.recordsTotal, 8);
    assert.equal(r.selected.record.requestId, '0000000000000a01', 'newest by default');
    assert.deepEqual(r.selected.linked.map((l) => [l.event, l.via]), [['policy_approval_required', 'same RequestID']]);
    assert.ok(r.ledger.every((row) => row.found), 'every pattern is in the sample');
    assert.deepEqual(r.ledger.find((x) => x.id === 'plain-allowed').missing, ['b', 'c', 'd']);
    assert.deepEqual(r.ledger.find((x) => x.id === 'no-agent').missing, ['b']);
    assert.equal(r.gaps.length, 3);
    const rel = (await json(url, '/api/req9?rid=0000000000000a05')).body;
    assert.equal(rel.selected.record.event, 'policy_approval_released'); assert.equal(rel.selected.found, true);
    assert.deepEqual(rel.selected.linked.map((l) => [l.requestId, l.via]), [['0000000000000a04', 'matched by user, tool and time']]);
    const unknown = (await json(url, '/api/req9?rid=ffffffffffffffff')).body;
    assert.equal(unknown.selected.record.requestId, '0000000000000a01'); assert.match(unknown.selected.note, /ffffffffffffffff/);
    for (const bad of ['?rid=%3Cx%3E', `?rid=${'x'.repeat(65)}`, '?rid=a%20b', '?rid=a&rid=b', '?rid=', '?range=1h']) assert.equal((await get(url, `/api/req9${bad}`)).status, 400, bad);
    const text = JSON.stringify(r);
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, 'no UUID-shaped value in Mock');
  });
});

test('Real API: 409 without a console, 412 until confirmed, then the two indices over 90 days, cached a minute, deep link, key never returned', async () => {
  const gw = await fakeGateway();
  const at = Date.now() - 2 * 86_400_000;
  const recs = [dec(at), dec(at + 900, { Event: 'policy_approval_required' }), dec(at + 30_000, { Event: 'policy_approval_released', Decision: 'allow', RequestID: 'req-rel', AgentKey: undefined }),
    dec(at + 60_000, { RequestID: 'req-nk', AgentKey: undefined, Decision: 'deny' }), dec(at + 90_000, { RequestID: 'req-key', AgentKey: KEY, Decision: 'deny' }), httpRec(at + 120_000)];
  const cons = await fakeConsole({ records: recs });
  let clock = Date.now();
  try {
    await withServer(async (url) => {
      await post(url, '/api/mode', { source: 'real' });
      const r = await json(url, '/api/req9');
      assert.equal(r.status, 409); assert.equal(r.body.error, 'console_not_configured');
    }, { env: { ...NOENV, PRIV_LOG_GATEWAY_URL: gw.url, PRIV_LOG_AGENT_KEY: KEY } });
    await withServer(async (url) => {
      await post(url, '/api/mode', { source: 'real' });
      const gate = await json(url, '/api/req9');
      assert.equal(gate.status, 412); assert.equal(gate.body.error, 'confirm_required'); assert.equal(cons.requests.length, 0, 'nothing read before the confirm');
      await post(url, '/api/confirm', { gateway: new URL(gw.base).origin });
      const r = (await json(url, '/api/req9')).body;
      assert.equal(r.source, 'real'); assert.equal(r.label, undefined);
      const sent = JSON.parse(cons.requests[0].body);
      assert.deepEqual(sent.Indices.Elems, ['policy-decision-log', 'proxy-audit-log']);
      assert.ok(Date.parse(sent.EndTime) - Date.parse(sent.StartTime) >= 89 * 86_400_000, 'about 90 days');
      assert.deepEqual(['a', 'b', 'c', 'd'].map((k) => r.coverage.parts[k].count), [5, 3, 5, 5]);
      assert.equal(r.coverage.http.records, 1);
      assert.equal(r.selected.record.requestId, 'req-key');
      const n = cons.requests.length;
      const deep = (await json(url, '/api/req9?rid=req-rel')).body;
      assert.equal(cons.requests.length, n, 'a picked record reuses the read');
      assert.deepEqual(deep.selected.linked.map((l) => [l.requestId, l.via]), [['req-1', 'matched by user, tool and time']]);
      for (const b of [r, deep]) assert.ok(!JSON.stringify(b).includes(KEY), 'the agent key reached an answer');
      clock += 61_000; await json(url, '/api/req9'); assert.ok(cons.requests.length > n, 'after a minute: read again');
      assert.equal((await get(url, '/api/req9?rid=..%2F..')).status, 400);
    }, { env: consoleEnv(gw, cons), now: () => clock });
  } finally { await gw.close(); await cons.close(); }
});

test('Real API: a console failure is a 502 with the reason, not a crash', async () => {
  const gw = await fakeGateway();
  const cons = await fakeConsole({ status: 500, raw: '{}' });
  try {
    await withServer(async (url) => {
      await post(url, '/api/mode', { source: 'real' });
      await post(url, '/api/confirm', { gateway: new URL(gw.base).origin });
      const r = await json(url, '/api/req9');
      assert.equal(r.status, 502); assert.match(r.body.detail, /HTTP 500/);
    }, { env: consoleEnv(gw, cons) });
  } finally { await gw.close(); await cons.close(); }
});

test('diagram: req9 is diagram-studio/1 data loaded by name, equal to the builder, with field-name sub lines; not a Diagram tab flow', async () => {
  const d = buildReq9Diagram();
  assert.deepEqual(validateDiagram(d), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(new URL('../diagrams/req9.json', import.meta.url), 'utf8')), d, 'req9 drifted: run npm run diagrams');
  assert.deepEqual(loadDiagram('req9'), d);
  assert.equal(DIAGRAM_NAMES.includes('req9'), false);
  const b = buildDiagram('req9');
  assert.deepEqual(b.nodes.map((n) => n.id), ['user', 'agent', 'tool', 'decision', 'approval']);
  assert.deepEqual(b.nodes[0].sub, ['Data.User', 'Data.PrincipalKind']);
  assert.equal(b.steps.at(-1).dashed, true);
  await withServer(async (url) => {
    const r = (await json(url, '/api/diagram?name=req9')).body;
    assert.equal(r.name, 'req9'); assert.deepEqual(r.names, DIAGRAM_NAMES);
  });
});
