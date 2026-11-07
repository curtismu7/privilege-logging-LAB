import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { allowedHosts, installNetguard } from '../src/netguard.js';
import { createRealClient, RealError } from '../src/realClient.js';
import { KEY, NOENV, fakeGateway, fakeK8s, gatewayLog, get, k8sEnv, post, recorder, runAndFetch, withServer } from './helpers.js';

let guard;
before(() => { guard = installNetguard(); });
after(() => guard.restore());

const json = async (r) => ({ status: r.status, body: await r.json() });
const confirm = (url, gw) => post(url, '/api/confirm', { gateway: new URL(gw.base).origin });
const opts = (gw, k8s, extra = {}) => ({ env: k8sEnv(gw, k8s, extra) });
const iso = (t) => new Date(t).toISOString();
const noKey = (x) => assert.ok(!JSON.stringify(x).includes(KEY), 'the agent key appears in an answer');

test('marker first: the run marker is found in the pod log, neighbours by window are labelled inferred, the other lines are not shown, tokens are redacted, the key never appears', async () => {
  const gw = await fakeGateway(); let k8s;
  k8s = await fakeK8s({ logText: () => {
    const at = gw.requests.at(-1)?.at ?? Date.now();
    return [`${iso(at - 600_000)} time="x" level=info msg="a much older call: user: u-old, client: old"`, ...gatewayLog(gw, { other: [`${iso(at + 50)} time="x" level=info msg="debug Authorization: Bearer verysecrettoken123456 for u-live"`, `${iso(at + 60_000)} later bystander`] })].join('\n');
  } });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const { run, final, polls } = await runAndFetch(url, 'mcp-allowed-key');
      assert.equal(run.retrieval.state, 'pending'); assert.equal(run.retrieval.phase, 'fetching');
      assert.equal(final.retrieval.state, 'found'); assert.equal(final.retrieval.method, 'marker');
      assert.ok(polls >= 1);
      const sink = final.logged.find((l) => l.source === 'k8s-pod');
      assert.ok(sink.methods.includes('marker'), 'the payload line carries the marker');
      assert.ok(sink.methods.includes('window'), 'neighbours are matched by window');
      assert.ok(sink.lines.some((l) => l.includes(final.marker)));
      assert.ok(!sink.lines.some((l) => /much older|later bystander/.test(l)), 'lines that do not belong to the call are not shown');
      assert.ok(sink.lines.some((l) => l.includes('Authorization: Bearer ***')) && !JSON.stringify(final).includes('verysecrettoken123456'), 'tokens are redacted');
      assert.equal(final.scored, true);
      assert.match(final.retrieval.detail, /Found by the run marker audit-[0-9a-f]{8}/);
      noKey(final);
      // the exact kubectl-proxy request
      const q = k8s.requests[0];
      assert.equal(q.method, 'GET');
      const u = new URL(q.url, 'http://x');
      assert.equal(u.pathname, '/api/v1/namespaces/privilege/pods/gateway-abc/log');
      assert.equal(u.searchParams.get('container'), 'log-tailer');
      assert.ok(Number(u.searchParams.get('sinceSeconds')) >= 5);
      assert.equal(u.searchParams.get('timestamps'), 'true');
      assert.match(q.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      assert.ok(final.hops.some((h) => h.to === 'log-source'));
      assert.deepEqual((await json(await get(url, '/api/info'))).body.retrieval.sources.map((s) => s.id), ['k8s-pod']);
    }, opts(gw, k8s));
  } finally { await gw.close(); await k8s.close(); }
});

test('marker not logged: after the grace period the call window finds the lines, every one labelled "window" and the score flagged inferred', async () => {
  const gw = await fakeGateway();
  const k8s = await fakeK8s({ logText: () => gatewayLog(gw, { payload: false }).join('\n') });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const t0 = Date.now();
      const { final } = await runAndFetch(url, 'mcp-allowed-key');
      assert.equal(final.retrieval.state, 'found'); assert.equal(final.retrieval.method, 'window');
      assert.ok(Date.now() - t0 >= 240, 'it waited for the marker before falling back');
      const sink = final.logged.find((l) => l.source === 'k8s-pod');
      assert.ok(sink.methods.length && sink.methods.every((m) => m === 'window'));
      assert.deepEqual(Object.values(final.scoreInferred), [true, true, true, true].map((_, i) => final.scoreInferred[['user', 'agent', 'tool', 'decision'][i]]));
      assert.equal(final.scoreInferred.user, true); assert.equal(final.scoreInferred.tool, true);
      assert.match(final.retrieval.detail, /marker was not logged; matched by time window.*inferred/);
      const md = (await json(await get(url, '/api/scorecard'))).body.markdown;
      assert.match(md, /\(inferred\)/);
    }, opts(gw, k8s));
  } finally { await gw.close(); await k8s.close(); }
});

test('a Rejected (401) call is matched by the time window and the app path only, immediately, and labelled inferred', async () => {
  const gw = await fakeGateway();
  const k8s = await fakeK8s({ logText: () => {
    const at = gw.requests.at(-1)?.at ?? Date.now();
    return [`${iso(at + 5)} time="x" level=warning msg="[mcpgw] auth rejected: missing/invalid bearer app=demo-mcp-app method=POST path=/demo-mcp-app/mcp remote=<ip>"`,
      `${iso(at + 6)} time="x" level=info msg="Access token found for user: bystander, client: someone"`,
      `${iso(at + 7)} time="x" level=warning msg="[mcpgw] auth rejected: reason=token_not_found app=other-app method=POST path=/other-app/mcp remote=<ip>"`].join('\n');
  } });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const t0 = Date.now();
      const { final } = await runAndFetch(url, 'no-credential');
      assert.equal(final.outcome.http, 401);
      assert.equal(final.retrieval.state, 'found'); assert.equal(final.retrieval.method, 'window');
      assert.ok(Date.now() - t0 < 240, 'no grace wait: a rejected call never logs the payload');
      const sink = final.logged.find((l) => l.source === 'k8s-pod');
      assert.equal(sink.lines.length, 1); assert.match(sink.lines[0], /auth rejected.*demo-mcp-app/);
      assert.deepEqual(sink.methods, ['window']);
      assert.equal(final.scoreInferred.decision, true);
      assert.equal(final.score.user, 'missing');
    }, opts(gw, k8s));
  } finally { await gw.close(); await k8s.close(); }
});

test('a slow source: pending (with attempt and elapsed time) until the entry appears, then found and the polling stops', async () => {
  const gw = await fakeGateway(); let calls = 0;
  const k8s = await fakeK8s({ logText: () => { calls += 1; return calls < 4 ? '' : gatewayLog(gw).join('\n'); } });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const seen = [];
      let r = await (await post(url, '/api/run', { caseId: 'mcp-allowed-key' })).json();
      for (let i = 0; i < 40 && r.retrieval.state === 'pending'; i += 1) {
        await new Promise((x) => setTimeout(x, 25));
        r = await (await post(url, '/api/fetch-log', { caseId: 'mcp-allowed-key' })).json();
        seen.push(`${r.retrieval.state}:${r.retrieval.attempt}`);
      }
      assert.deepEqual(seen.slice(0, 3), ['pending:1', 'pending:2', 'pending:3']);
      assert.match((await (await post(url, '/api/fetch-log', { caseId: 'mcp-allowed-key' })).json()).retrieval.state, /found/);
      assert.equal(r.retrieval.state, 'found');
      assert.equal(r.retrieval.attempt, 4);
    }, opts(gw, k8s));
  } finally { await gw.close(); await k8s.close(); }
});

test('nothing within the limit: timeout with the reason; Retry (restart) starts a fresh retrieval and finds the entry once it exists', async () => {
  const gw = await fakeGateway(); let ready = false;
  const k8s = await fakeK8s({ logText: () => (ready ? gatewayLog(gw).join('\n') : '') });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const { final } = await runAndFetch(url, 'mcp-allowed-key');
      assert.equal(final.retrieval.state, 'timeout'); assert.match(final.retrieval.detail, /No entry found within 1 s/);
      assert.equal(final.scored, false);
      ready = true;
      const retry = await (await post(url, '/api/fetch-log', { caseId: 'mcp-allowed-key', restart: true })).json();
      assert.equal(retry.retrieval.attempt, 1, 'restart resets the attempt count');
      assert.ok(['pending', 'found'].includes(retry.retrieval.state));
      let r = retry;
      for (let i = 0; i < 40 && r.retrieval.state === 'pending'; i += 1) { await new Promise((x) => setTimeout(x, 25)); r = await (await post(url, '/api/fetch-log', { caseId: 'mcp-allowed-key' })).json(); }
      assert.equal(r.retrieval.state, 'found');
    }, opts(gw, k8s));
  } finally { await gw.close(); await k8s.close(); }
});

test('source unreachable: a 500, a 404, a refused connection and a redirect are each "log source not reachable" with the reason, nothing is scored', async () => {
  const gw = await fakeGateway(); const target = await recorder();
  const cases = [
    [await fakeK8s({ status: 500 }), /HTTP 500/], [await fakeK8s({ status: 404 }), /404: pod gateway-abc or container log-tailer not found in namespace privilege/],
    [await fakeK8s({ redirectTo: 'http://127.0.0.1:1/x' }), /redirect/], [await fakeK8s({ hang: true }), /no answer within/],
  ];
  const down = await fakeK8s(); const downBase = down.base; await down.close();
  try {
    for (const [k8s, re] of cases) {
      await withServer(async (url) => {
        await confirm(url, gw);
        const { final } = await runAndFetch(url, 'mcp-allowed-key');
        assert.equal(final.retrieval.state, 'unreachable', re.source); assert.match(final.retrieval.detail, /^Log source not reachable: /); assert.match(final.retrieval.detail, re);
        assert.equal(final.scored, false); assert.equal(final.score, null);
        noKey(final);
      }, { env: k8sEnv(gw, k8s), realTimeoutMs: 250 });
      await k8s.close();
    }
    await withServer(async (url) => {
      await post(url, '/api/confirm', { gateway: new URL(gw.base).origin });
      const { final } = await runAndFetch(url, 'mcp-allowed-key');
      assert.equal(final.retrieval.state, 'unreachable'); assert.match(final.retrieval.detail, /refused|connect/i);
    }, { env: k8sEnv(gw, { base: downBase }) });
    assert.deepEqual(target.requests, []);
  } finally { await gw.close(); await target.close(); }
});

test('a hostile oversized log response is bounded: the read stops at the cap, the answer stays small, and the page gets no 2 MB line', async () => {
  const gw = await fakeGateway(); const k8s = await fakeK8s({ bigBody: true });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const { final } = await runAndFetch(url, 'mcp-allowed-key');
      assert.equal(final.retrieval.state, 'timeout');
      assert.ok(JSON.stringify(final).length < 200_000, `${JSON.stringify(final).length} bytes`);
      assert.ok(final.retrieval.sources[0].note.includes('size cap'));
    }, opts(gw, k8s));
  } finally { await gw.close(); await k8s.close(); }
});

test('a label selector is resolved by listing pods: Running pods only, newest first, at most three, each log read', async () => {
  const gw = await fakeGateway(); let pending;
  const pod = (name, phase, t) => ({ metadata: { name, creationTimestamp: t }, status: { phase } });
  const k8s = await fakeK8s({ pods: [pod('gw-old', 'Running', '2026-11-01T00:00:00Z'), pod('gw-new', 'Running', '2026-11-07T00:00:00Z'), pod('gw-crash', 'Failed', '2026-11-08T00:00:00Z'), pod('gw-mid', 'Running', '2026-11-05T00:00:00Z'), pod('gw-extra', 'Running', '2026-10-01T00:00:00Z')], logText: () => gatewayLog(gw).join('\n') });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const { final } = await runAndFetch(url, 'mcp-allowed-key');
      assert.equal(final.retrieval.state, 'found');
      const list = k8s.requests.find((r) => /\/pods\?/.test(r.url));
      assert.equal(new URL(list.url, 'http://x').searchParams.get('labelSelector'), 'app=privilege-gateway');
      const logged = [...new Set(k8s.requests.filter((r) => /\/log\?/.test(r.url)).map((r) => /pods\/([^/]+)\/log/.exec(r.url)[1]))];
      assert.deepEqual(logged, ['gw-new', 'gw-mid', 'gw-old']);
    }, { env: k8sEnv(gw, k8s, { PRIV_LOG_K8S_POD: 'app=privilege-gateway' }) });
    pending = await fakeK8s({ pods: [pod('x', 'Pending', '2026-11-07T00:00:00Z')] });
    await withServer(async (url) => {
      await confirm(url, gw);
      const { final } = await runAndFetch(url, 'mcp-allowed-key');
      assert.equal(final.retrieval.state, 'unreachable'); assert.match(final.retrieval.detail, /no Running pod matches/);
    }, { env: k8sEnv(gw, pending, { PRIV_LOG_K8S_POD: 'app=none' }) });
  } finally { await gw.close(); await k8s.close(); await pending?.close(); }
});

test('netguard: while Real is on only the gateway and the log source hosts are allowed; Mock closes the door; another origin is refused by the client', async () => {
  const gw = await fakeGateway(); const k8s = await fakeK8s(); const other = await recorder();
  try {
    await withServer(async (url) => {
      assert.ok(allowedHosts().includes('127.0.0.1'));
      await post(url, '/api/mode', { source: 'mock' });
      assert.deepEqual(allowedHosts(), []);
      await post(url, '/api/mode', { source: 'real' });
      assert.ok(allowedHosts().length >= 1);
    }, opts(gw, k8s));
    const client = createRealClient({ origins: [gw.base, k8s.base] });
    await assert.rejects(client.request({ url: `${other.base}/api/v1/namespaces/x/pods/p/log` }), (e) => e instanceof RealError && e.code === 'origin_not_allowed');
    assert.deepEqual(other.requests, []);
    const n = k8s.requests.length;
    await client.request({ url: `${k8s.base}/api/v1/namespaces/x/pods/p/log` });
    assert.equal(k8s.requests.length, n + 1);
  } finally { await gw.close(); await k8s.close(); await other.close(); }
});

test('Mock makes no k8s request even when a log source is configured, and Real runs of both sources show each source separately', async () => {
  const gw = await fakeGateway(); const k8s = await fakeK8s({ logText: () => gatewayLog(gw).join('\n') });
  guard.attempts.length = 0;
  try {
    await withServer(async (url) => {
      await post(url, '/api/mode', { source: 'mock' });
      const { final } = await runAndFetch(url, 'mcp-allowed-key');
      assert.equal(final.source, 'mock'); assert.equal(final.retrieval.method, 'recorded');
      assert.deepEqual(k8s.requests, []); assert.deepEqual(gw.requests, []); assert.deepEqual(guard.attempts, []);
    }, opts(gw, k8s));
  } finally { await gw.close(); await k8s.close(); }
});

test('console action cases send nothing: "Look for entries since" reads the source for the span and shows every line, labelled window', async () => {
  const gw = await fakeGateway();
  const base = Date.now();
  const k8s = await fakeK8s({ logText: () => [`${iso(base - 3 * 3600_000)} too old`, `${iso(base - 60_000)} time="x" level=info msg="agent key created id=k-1"`, `${iso(base - 30_000)} time="x" level=info msg="agent key revoked id=k-1"`].join('\n') });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const since = iso(base - 5 * 60_000);
      const { run, final } = await runAndFetch(url, 'reg-key-created', { body: { since } });
      assert.deepEqual(gw.requests, [], 'nothing was sent');
      assert.equal(run.outcome.note, 'console action: nothing was sent');
      assert.equal(final.retrieval.state, 'found'); assert.equal(final.retrieval.method, 'window');
      const sink = final.logged.find((l) => l.source === 'k8s-pod');
      assert.equal(sink.lines.length, 2); assert.ok(sink.methods.every((m) => m === 'window'));
      assert.ok(Number(new URL(k8s.requests[0].url, 'http://x').searchParams.get('sinceSeconds')) >= 300);
      assert.equal((await post(url, '/api/run', { caseId: 'reg-key-created', since: 'yesterday' })).status, 400);
      assert.equal((await post(url, '/api/run', { caseId: 'reg-key-created', since: iso(base - 3 * 86_400_000) })).status, 400);
    }, opts(gw, k8s));
  } finally { await gw.close(); await k8s.close(); }
});
