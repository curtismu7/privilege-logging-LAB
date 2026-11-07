import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadCapture } from '../src/capture.js';
import { installNetguard } from '../src/netguard.js';
import { KEY, NOENV, fakeGateway, fakeK8s, gatewayLog, get, k8sEnv, post, runAndFetch, withServer } from './helpers.js';

const capture = loadCapture();
let guard;
before(() => { guard = installNetguard(); });
after(() => guard.restore());
const json = async (r) => ({ status: r.status, body: await r.json() });
const confirm = (url, gw) => post(url, '/api/confirm', { gateway: new URL(gw.base).origin });
const BEARER = 'owner-bearer-NOT-REAL-5d2e8f10';
const noSecrets = (x, ...secrets) => { const t = JSON.stringify(x); for (const s of [KEY, ...secrets]) assert.ok(!t.includes(s), 'a secret appears in an answer'); };

test('Mock lists every unmeasured case, flagged realOnly with the tooltip text; no run API succeeds for them (409); nothing is sent', async () => {
  const gw = await fakeGateway(); guard.attempts.length = 0;
  try {
    await withServer(async (url) => {
      await post(url, '/api/mode', { source: 'mock' });
      const { cases, groups } = (await json(await get(url, '/api/cases'))).body;
      const ro = cases.filter((c) => c.realOnly);
      assert.equal(ro.length, capture.realOnly.length); assert.equal(ro.length, 17);
      assert.ok(groups.slice(-4).join() === 'Keys,Federated identity,Approvals,Registry lifecycle');
      assert.ok(ro.every((c) => c.mockNote === 'No recorded measurement yet. Real mode only.' && c.needs.length));
      assert.ok(cases.filter((c) => !c.realOnly).every((c) => c.mockNote === null));
      for (const c of ro) {
        const r = await json(await post(url, '/api/run', { caseId: c.id }));
        assert.equal(r.status, 409, c.id); assert.equal(r.body.error, 'real_only'); assert.equal(r.body.detail, 'No recorded measurement yet. Real mode only.');
        assert.equal((await post(url, '/api/fetch-log', { caseId: c.id })).status, 409);
      }
      assert.deepEqual((await json(await get(url, '/api/runs'))).body.runs, []);
      const card = (await json(await get(url, '/api/scorecard'))).body;
      const rows = card.rows.filter((r) => r.realOnly);
      assert.equal(rows.length, 17); assert.ok(rows.every((r) => r.notMeasured === true && r.score === null && Object.keys(r.notes).length === 0), 'never a fabricated result');
      assert.match(card.markdown, /\| Revoked agent key \| Keys \| not measured \| not measured \| not measured \| not measured \|/);
    }, { env: { ...k8sEnv(gw, { base: 'http://127.0.0.1:9' }) } });
    assert.deepEqual(gw.requests, []); assert.deepEqual(guard.attempts, []);
  } finally { await gw.close(); }
});

test('Real: a case that needs the owner\'s credential asks for it (409, names the field and the env var) and sends nothing until it is supplied', async () => {
  const gw = await fakeGateway({ key: BEARER });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const cases = (await json(await get(url, '/api/cases'))).body.cases;
      assert.equal(cases.find((c) => c.id === 'keys-revoked').needsBearer, true); assert.equal(cases.find((c) => c.id === 'keys-revoked').bearerConfigured, false);
      assert.equal(cases.find((c) => c.id === 'mcp-allowed-key').needsBearer, false);
      const r = await json(await post(url, '/api/run', { caseId: 'keys-revoked' }));
      assert.equal(r.status, 409); assert.equal(r.body.error, 'bearer_needed'); assert.match(r.body.detail, /PRIV_LOG_BEARER_KEYS_REVOKED/); assert.match(r.body.detail, /revoked agent key/);
      assert.deepEqual(gw.requests, []);
    }, { env: k8sEnv(gw, { base: 'http://127.0.0.1:9' }) });
  } finally { await gw.close(); }
});

test('Real: the bearer is a write-only field per case: sent as the credential instead of the agent key, never returned, redacted in the raw hops; clearing it works', async () => {
  const gw = await fakeGateway({ key: BEARER }); const k8s = await fakeK8s({ logText: () => gatewayLog(gw).join('\n') });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const set = await json(await post(url, '/api/bearer', { caseId: 'fed-valid-token', bearer: BEARER }));
      assert.deepEqual(set.body, { caseId: 'fed-valid-token', configured: true }); noSecrets(set.body, BEARER);
      const cases = await json(await get(url, '/api/cases'));
      assert.equal(cases.body.cases.find((c) => c.id === 'fed-valid-token').bearerConfigured, true); noSecrets(cases.body, BEARER);
      const { final } = await runAndFetch(url, 'fed-valid-token');
      assert.ok(gw.requests.length === 3 && gw.requests.every((r) => r.headers.authorization === `Bearer ${BEARER}`), 'the owner bearer is the credential, not the agent key');
      assert.equal(final.outcome.http, 200); assert.equal(final.retrieval.state, 'found'); assert.equal(final.realOnly, true); assert.equal(final.scored, true);
      noSecrets(final, BEARER);
      assert.ok(final.hops[0].request.includes('authorization: Bearer ***'));
      const info = await json(await get(url, '/api/info')); noSecrets(info.body, BEARER);
      const card = (await json(await get(url, '/api/scorecard'))).body;
      const row = card.rows.find((r) => r.id === 'fed-valid-token'); assert.equal(row.notMeasured, false); assert.ok(row.score);
      assert.equal(card.rows.find((r) => r.id === 'fed-expired-token').notMeasured, true, 'the others are still not measured');
      noSecrets(card, BEARER);
      assert.equal((await json(await post(url, '/api/bearer', { caseId: 'fed-valid-token', bearer: '' }))).body.configured, false);
      assert.equal((await json(await post(url, '/api/run', { caseId: 'fed-valid-token' }))).body.error, 'bearer_needed');
      // validation
      assert.equal((await post(url, '/api/bearer', { caseId: 'mcp-allowed-key', bearer: 'x' })).status, 404, 'a case with no bearer slot');
      assert.equal((await post(url, '/api/bearer', { caseId: 'nope', bearer: 'x' })).status, 404);
      assert.equal((await post(url, '/api/bearer', { caseId: 'fed-valid-token', bearer: 'has space' })).status, 400);
      assert.equal((await post(url, '/api/bearer', { caseId: 'fed-valid-token', bearer: 'x'.repeat(3000) })).status, 400);
      assert.equal((await post(url, '/api/bearer', { caseId: 'fed-valid-token' })).status, 400);
      assert.equal((await post(url, '/api/bearer', { caseId: 'fed-valid-token', bearer: 'x', extra: 1 })).status, 400);
      // another tab does not see it; reset forgets it
      await post(url, '/api/bearer', { caseId: 'fed-valid-token', bearer: BEARER });
      assert.equal((await json(await get(url, '/api/cases', { 'x-workspace': 'tab-b' }))).body.cases.find((c) => c.id === 'fed-valid-token').bearerConfigured, false);
      await post(url, '/api/reset', {});
      assert.equal((await json(await get(url, '/api/cases'))).body.cases.find((c) => c.id === 'fed-valid-token').bearerConfigured, false);
    }, { env: k8sEnv(gw, k8s) });
  } finally { await gw.close(); await k8s.close(); }
});

test('Real: PRIV_LOG_BEARER_<CASEID> in the environment supplies the credential; a refused credential is a recorded result (401), not an error', async () => {
  const gw = await fakeGateway({ key: 'the-gateway-accepts-only-this' }); const k8s = await fakeK8s({ logText: () => '' });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      assert.equal((await json(await get(url, '/api/cases'))).body.cases.find((c) => c.id === 'keys-expired').bearerConfigured, true);
      const { run } = await runAndFetch(url, 'keys-expired', { max: 0 });
      assert.equal(run.outcome.http, 401);
      assert.equal(gw.requests.at(-1).headers.authorization, `Bearer ${BEARER}`);
      noSecrets(run, BEARER);
    }, { env: k8sEnv(gw, k8s, { PRIV_LOG_BEARER_KEYS_EXPIRED: BEARER }) });
  } finally { await gw.close(); await k8s.close(); }
});

test('Real: a call held for approval that does not answer is a result (no HTTP answer, note says so) and the log is still read', async () => {
  const gw = await fakeGateway({ holdCalls: true }); const k8s = await fakeK8s({ logText: () => gatewayLog(gw).join('\n') });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const { run, final } = await runAndFetch(url, 'approval-held');
      assert.equal(run.outcome.http, null); assert.match(run.outcome.note, /held for approval waits for the approver/);
      assert.equal(final.retrieval.state, 'found');
      assert.equal(JSON.parse(gw.requests.at(-1).body).params.arguments.memo.startsWith('audit-'), true, 'the marker replaces the memo');
      // a non-held case still errors on a timeout
    }, { env: k8sEnv(gw, k8s), realTimeoutMs: 250 });
  } finally { await gw.close(); await k8s.close(); }
});

test('Real: the unmeasured Keys cases that send use the marker too, and they run through the same two-phase path (send, then fetch the log entry)', async () => {
  const gw = await fakeGateway({ key: BEARER }); const k8s = await fakeK8s({ logText: () => gatewayLog(gw).join('\n') });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      for (const id of ['keys-revoked', 'keys-expired', 'keys-rate-limited', 'keys-no-mcp-scope', 'fed-wrong-audience', 'fed-wrong-issuer', 'fed-expired-token', 'fed-lifetime-too-long']) await post(url, '/api/bearer', { caseId: id, bearer: BEARER });
      for (const id of ['keys-revoked', 'keys-rate-limited', 'fed-wrong-issuer', 'approval-cedar-decision']) {
        const { final } = await runAndFetch(url, id);
        assert.equal(final.retrieval.state, 'found', id); assert.match(final.marker, /^audit-[0-9a-f]{8}$/);
      }
    }, { env: k8sEnv(gw, k8s) });
  } finally { await gw.close(); await k8s.close(); }
});
