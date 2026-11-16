// "What Privilege did" (Rule 25): the traces this lab builds, for Mock (a replay) and Real (the lab's own hop to a FAKE gateway).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadCapture } from '../src/capture.js';
import { installNetguard } from '../src/netguard.js';
import { assertTrace } from '../src/gatewayTrace.js';
import { mockExchanges, realExchanges, shortSession } from '../src/privilegeTrace.js';
import { notRunnable } from '../src/mcpRunner.js';
import { KEY, fakeGateway, get, post, realEnv, withServer } from './helpers.js';

const capture = loadCapture();
let guard;
before(() => { guard = installNetguard(); });
after(() => guard.restore());
const json = async (r) => ({ status: r.status, body: await r.json() });
const confirm = (url, gw) => post(url, '/api/confirm', { gateway: new URL(gw.base).origin });
const BEARER = 'owner-bearer-NOT-REAL-5d2e8f10';
const allDecisions = (ex) => ex.flatMap((e) => e.trace.decisions);

test('Mock: every case the lab could send in Real has one replay exchange, and every other case has none (nothing is invented)', async () => {
  await withServer(async (url) => {
    await post(url, '/api/mode', { source: 'mock' });
    for (const c of capture.cases) {
      const r = await json(await post(url, '/api/run', { caseId: c.id }));
      assert.equal(r.status, 200, c.id);
      assert.ok(Array.isArray(r.body.exchanges), `${c.id}: exchanges is an array`);
      const sendable = notRunnable(c) === null;
      assert.equal(r.body.exchanges.length, sendable ? 1 : 0, c.id);
      for (const ex of r.body.exchanges) {
        assert.deepEqual(assertTrace(ex.trace), [], c.id);
        assert.equal(ex.trace.source, 'mock');
        assert.equal(ex.status, c.outcome.http);
        assert.equal(ex.trace.response.status, c.outcome.http);
        assert.match(ex.trace.request.url, /^https:\/\/[a-z.-]+\.invalid\//, 'a replay never names a real host');
        assert.deepEqual(ex.trace.request.body, r.body.wire, 'the request is the call Real would send');
        assert.match(ex.title, /^Replay: /);
        assert.ok(ex.trace.decisions.length >= 1);
      }
    }
  });
});

test('Mock: the lab has no gateway to run checks, so no decision says "checked"; they are read from the recorded outcome', () => {
  for (const c of capture.cases.filter((x) => notRunnable(x) === null)) {
    const ex = mockExchanges(c, { recordedOn: capture.capturedOn });
    for (const d of allDecisions(ex)) assert.ok(d.basis === 'inferred' || d.basis === 'observed', `${c.id}/${d.id} is ${d.basis}`);
  }
});

test('Mock: the recorded outcome decides the shown decisions (200 pass, 401 key refused, 403 grant refused, a guard block is a fail, other statuses are information)', () => {
  const by = (id) => mockExchanges(capture.cases.find((c) => c.id === id), { recordedOn: capture.capturedOn })[0].trace.decisions;
  assert.deepEqual(by('mcp-allowed-key').map((d) => [d.id, d.outcome]), [['authenticated', 'pass'], ['grant', 'pass']]);
  assert.deepEqual(by('no-credential').map((d) => [d.id, d.outcome]), [['authenticated', 'fail'], ['grant', 'skipped']]);
  assert.deepEqual(by('mcp-tool-not-granted').map((d) => [d.id, d.outcome]), [['authenticated', 'pass'], ['grant', 'fail']]);
  assert.deepEqual(by('mcp-list-guard-blocked').map((d) => [d.id, d.outcome]), [['authenticated', 'pass'], ['guard', 'fail']]);
  assert.deepEqual(by('aggregate-none').map((d) => [d.id, d.outcome]), [['status', 'info']]);
  // the credential header is absent for the no-credential case, present (masked) for the others
  const h = (id) => mockExchanges(capture.cases.find((c) => c.id === id), { recordedOn: capture.capturedOn })[0].trace.request.headers;
  assert.equal('authorization' in h('no-credential'), false);
  assert.match(h('mcp-allowed-key').authorization, /^Bearer \*\*\*/);
});

test('Mock: nothing is sent while a trace is built', async () => {
  const gw = await fakeGateway(); guard.attempts.length = 0;
  try {
    await withServer(async (url) => {
      await post(url, '/api/mode', { source: 'mock' });
      const r = await json(await post(url, '/api/run', { caseId: 'mcp-allowed-key' }));
      assert.equal(r.body.exchanges.length, 1);
    }, { env: realEnv(gw) });
    assert.deepEqual(gw.requests, []); assert.deepEqual(guard.attempts, []);
  } finally { await gw.close(); }
});

const runReal = async (url, gw, caseId, bearer) => {
  await confirm(url, gw);
  if (bearer) await post(url, '/api/bearer', { caseId, bearer });
  return json(await post(url, '/api/run', { caseId }));
};

test('Real: a tools/call exchange is the call itself, with the session calls around it as one line, and no decision says "checked"', async () => {
  const gw = await fakeGateway();
  try {
    await withServer(async (url) => {
      const r = await runReal(url, gw, 'mcp-allowed-key');
      assert.equal(r.status, 200);
      assert.equal(r.body.exchanges.length, 1);
      const [ex] = r.body.exchanges;
      assert.deepEqual(assertTrace(ex.trace), []);
      assert.equal(ex.trace.source, 'real'); assert.equal(ex.step, 1); assert.equal(ex.status, 200);
      assert.match(ex.title, /^Gateway call: tools\/call get_weather$/);
      assert.equal(ex.trace.request.body.method, 'tools/call');
      assert.match(JSON.stringify(ex.trace.request.body), /audit-[0-9a-f]{8}/, 'the exact request carries the run marker');
      assert.equal(ex.trace.request.headers.authorization, 'Bearer ***');
      assert.match(ex.trace.request.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      assert.deepEqual(ex.trace.response.body.result.content, [{ type: 'text', text: 'sunny' }]);
      assert.deepEqual(ex.trace.setup, [{ label: 'initialize', status: 200 }, { label: 'notifications/initialized', status: 200 }].map((s, i) => (i === 1 ? { ...s, status: 202 } : s)));
      assert.deepEqual(ex.trace.decisions.map((d) => [d.id, d.outcome, d.basis]), [['authenticated', 'pass', 'inferred'], ['grant', 'pass', 'inferred']]);
      assert.ok(!allDecisions(r.body.exchanges).some((d) => d.basis === 'checked'));
    }, { env: realEnv(gw) });
  } finally { await gw.close(); }
});

test('Real: the answer of a tools/list that came as an event stream is shown as the gateway sent it, and its decisions are read from the parsed message', async () => {
  const gw = await fakeGateway();
  try {
    await withServer(async (url) => {
      const r = await runReal(url, gw, 'mcp-list-filtered');
      const [ex] = r.body.exchanges;
      assert.deepEqual(assertTrace(ex.trace), []);
      assert.equal(typeof ex.trace.response.body, 'string');
      assert.match(ex.trace.response.body, /^event: message\ndata: \{.*get_weather.*\}/);
      assert.equal(ex.trace.decisions.find((d) => d.id === 'grant').outcome, 'pass');
      assert.match(ex.trace.decisions.find((d) => d.id === 'grant').evidence, /get_weather/);
    }, { env: realEnv(gw) });
  } finally { await gw.close(); }
});

test('Real: a tool the gateway flags isError is a failed decision (observed), not a pass', async () => {
  const gw = await fakeGateway();
  try {
    await withServer(async (url) => {
      const r = await runReal(url, gw, 'mcp-tool-not-granted');
      const [ex] = r.body.exchanges;
      assert.deepEqual(assertTrace(ex.trace), []);
      assert.deepEqual(ex.trace.decisions.map((d) => [d.id, d.outcome, d.basis]), [['authenticated', 'pass', 'inferred'], ['result', 'fail', 'observed']]);
    }, { env: realEnv(gw) });
  } finally { await gw.close(); }
});

test('Real: a refusal at the handshake shows the refused request, the answer, and a failed key decision (inferred), with no secret in it', async () => {
  const gw = await fakeGateway();
  try {
    await withServer(async (url) => {
      const r = await runReal(url, gw, 'unknown-key');
      const [ex] = r.body.exchanges;
      assert.deepEqual(assertTrace(ex.trace), []);
      assert.equal(ex.status, 401);
      assert.match(ex.title, /^Gateway session: initialize/);
      assert.deepEqual(ex.trace.decisions.map((d) => [d.id, d.outcome, d.basis]), [['authenticated', 'fail', 'inferred'], ['grant', 'skipped', 'inferred']]);
      assert.equal(ex.trace.request.body.method, 'initialize');
      assert.deepEqual(ex.trace.setup, []);
    }, { env: realEnv(gw) });
  } finally { await gw.close(); }
});

test('Real: a call with no credential sends no authorization header, and the trace does not show one', async () => {
  const gw = await fakeGateway();
  try {
    await withServer(async (url) => {
      const r = await runReal(url, gw, 'no-credential');
      const [ex] = r.body.exchanges;
      assert.deepEqual(assertTrace(ex.trace), []);
      assert.equal('authorization' in ex.trace.request.headers, false);
    }, { env: realEnv(gw) });
  } finally { await gw.close(); }
});

test('Real: a call held for approval has a request and no answer; it is information, never a pass', async () => {
  const gw = await fakeGateway({ holdCalls: true });
  try {
    await withServer(async (url) => {
      const r = await runReal(url, gw, 'approval-held');
      assert.equal(r.status, 200);
      const [ex] = r.body.exchanges;
      assert.deepEqual(assertTrace(ex.trace), []);
      assert.equal(ex.trace.response, null); assert.equal(ex.status, null);
      assert.equal(ex.trace.request.body.method, 'tools/call');
      assert.match(ex.trace.request.headers.traceparent, /^00-/);
      assert.deepEqual(ex.trace.decisions.map((d) => [d.id, d.outcome, d.basis]), [['held', 'info', 'observed']]);
      assert.deepEqual(ex.trace.setup.map((s) => s.label), ['initialize', 'notifications/initialized']);
    }, { env: realEnv(gw), realTimeoutMs: 400 });
  } finally { await gw.close(); }
});

test('Real: no secret is in any trace: not the agent key, not a pasted bearer, not the whole session id, not a generated token', async () => {
  const gw = await fakeGateway({ key: BEARER });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const seen = [];
      for (const [caseId, bearer] of [['keys-revoked', BEARER], ['mcp-allowed-key'], ['fed-wrong-audience'], ['unknown-key']]) {
        if (bearer) await post(url, '/api/bearer', { caseId, bearer });
        const r = await json(await post(url, '/api/run', { caseId }));
        assert.equal(r.status, 200, caseId);
        for (const ex of r.body.exchanges) assert.deepEqual(assertTrace(ex.trace), [], caseId);
        seen.push(JSON.stringify(r.body.exchanges));
      }
      const text = seen.join('\n');
      for (const secret of [KEY, BEARER, 'sess-fake-1']) assert.ok(!text.includes(secret), `a secret appears in a trace: ${secret.slice(0, 8)}`);
      // the generated token shows only its start
      assert.doesNotMatch(text, /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/);
    }, { env: realEnv(gw) });
  } finally { await gw.close(); }
});

test('Real: a console-action case sends nothing and so has no exchange', async () => {
  const gw = await fakeGateway();
  try {
    await withServer(async (url) => {
      const cases = (await json(await get(url, '/api/cases'))).body.cases;
      const c = cases.find((x) => x.consoleAction);
      await confirm(url, gw);
      const r = await json(await post(url, '/api/run', { caseId: c.id }));
      if (r.status === 200) assert.deepEqual(r.body.exchanges, []);
      assert.deepEqual(gw.requests, []);
    }, { env: realEnv(gw) });
  } finally { await gw.close(); }
});

test('the exchanges survive the log fetch (the stored run keeps them)', async () => {
  const gw = await fakeGateway();
  try {
    await withServer(async (url) => {
      await runReal(url, gw, 'mcp-allowed-key');
      await post(url, '/api/fetch-log', { caseId: 'mcp-allowed-key' });
      const runs = (await json(await get(url, '/api/runs'))).body.runs;
      assert.equal(runs.find((x) => x.caseId === 'mcp-allowed-key').exchanges.length, 1);
    }, { env: realEnv(gw) });
  } finally { await gw.close(); }
});

// ---- the builder on its own --------------------------------------------------------------------------------------------------
const hop = (label, body, res) => ({ label, request: { method: 'POST', url: 'https://gw.example.invalid/app/mcp', headers: { 'content-type': 'application/json', authorization: 'Bearer ***', traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` }, body: JSON.stringify(body) }, response: res });
const c = { request: { method: 'tools/call', tool: 'get_weather' } };

test('builder: cookies and the session id are not shown whole, a long authorization is shortened, other headers stay', () => {
  const rpc = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_weather', arguments: {} } };
  const h = hop('tools/call', rpc, { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abcdef123456', 'mcp-session-id': 'session-0123456789abcdef', 'x-request-id': 'req-7' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [] } }) });
  h.request.headers['mcp-session-id'] = 'session-0123456789abcdef'; h.request.headers.cookie = 'sid=abcdef123456';
  h.request.headers.authorization = `Bearer eyJhbGciOiJIUzI1NiJ9.${'xQ'.repeat(15)}.${'yR'.repeat(15)}`;
  const [ex] = realExchanges({ hops: [h] }, c, { at: '2026-11-16T00:00:00.000Z' });
  assert.deepEqual(assertTrace(ex.trace), []);
  const text = JSON.stringify(ex.trace);
  for (const leak of ['sid=abcdef123456', 'session-0123456789abcdef', 'xQ'.repeat(15), 'yR'.repeat(15)]) assert.ok(!text.includes(leak), leak);
  assert.equal(ex.trace.response.headers['x-request-id'], 'req-7'); assert.equal(ex.trace.requestId, 'req-7');
  assert.equal(ex.trace.at, '2026-11-16T00:00:00.000Z');
  assert.equal(shortSession('session-0123456789abcdef'), 'sessio… (24 characters, shortened)');
});

test('builder: a truncated answer is said to be cut, as information', () => {
  const h = hop('tools/call', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x' } }, { status: 200, headers: {}, body: '{"jsonrpc":"2.0","result":{"content":[{"type":"te', truncated: true });
  const [ex] = realExchanges({ hops: [h] }, c, {});
  assert.deepEqual(assertTrace(ex.trace), []);
  const t = ex.trace.decisions.find((d) => d.id === 'truncated');
  assert.equal(t.outcome, 'info'); assert.match(t.evidence, /cut/);
  assert.ok(!ex.trace.decisions.some((d) => d.outcome === 'pass' && d.id === 'grant'), 'a cut answer never counts as a granted call');
});

test('builder: a gateway that echoes the credential back does not put it in the trace', () => {
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${'xQ'.repeat(15)}.${'yR'.repeat(15)}`;
  const h = hop('initialize', { jsonrpc: '2.0', id: 1, method: 'initialize' }, { status: 401, headers: { 'www-authenticate': `Bearer realm="x" got=${jwt}` }, body: JSON.stringify({ error: 'unauthorized', echo: `Bearer ${jwt}` }) });
  const [ex] = realExchanges({ hops: [h] }, { request: { method: 'tools/call' } }, {});
  assert.deepEqual(assertTrace(ex.trace), []);
  assert.ok(!JSON.stringify(ex.trace).includes('xQ'.repeat(15)));
});

test('builder: no hops at all is no exchange', () => {
  assert.deepEqual(realExchanges({ hops: [] }, c, {}), []);
});
