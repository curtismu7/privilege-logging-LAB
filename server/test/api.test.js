import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadCapture } from '../src/capture.js';
import { installNetguard } from '../src/netguard.js';
import { KEY, NOENV, fakeGateway, fakeSearch, get, post, rawHttp, realEnv, recorder, withServer } from './helpers.js';

const capture = loadCapture();
let guard;
before(() => { guard = installNetguard(); });
after(() => guard.restore());

const json = async (r) => ({ status: r.status, body: await r.json() });
const nowIso = (offset = 0) => new Date(Date.now() + offset).toISOString();
const EVENTS = () => [
  { '@timestamp': nowIso(-3_600_000), message: 'Access token found for user: u-old, client: old-key' },
  { '@timestamp': nowIso(-100), message: 'Access token found for user: u-live, client: audit-test' },
  { '@timestamp': nowIso(-50), message: 'Principal {User u-live} has policy based capabilities for {Application demo-mcp-app}' },
  { '@timestamp': nowIso(0), message: 'MCP call detected for method tools with target: get_weather' },
];
const realOpts = (gw, search) => ({ env: realEnv(gw, search), sleep: async () => {} });
const confirm = (url, gw, headers) => post(url, '/api/confirm', { gateway: new URL(gw.base).origin }, headers);

test('health: demo-health/1, GET only, runtime follows the mode', async () => {
  await withServer(async (url) => {
    const { status, body } = await json(await get(url, '/api/health'));
    assert.equal(status, 200);
    assert.equal(body.schema, 'demo-health/1');
    assert.equal(body.state, 'ready');
    assert.equal(body.runtime, 'offline');
    assert.deepEqual(Object.keys(body.demo).sort(), ['id', 'name', 'version']);
    assert.equal(body.demo.id, 'privilege-logging-lab');
    assert.equal((await post(url, '/api/health', {})).status, 405);
  });
  const gw = await fakeGateway();
  try {
    await withServer(async (url) => {
      assert.equal((await json(await get(url, '/api/health'))).body.runtime, 'live');
      await post(url, '/api/mode', { source: 'mock' });
      assert.equal((await json(await get(url, '/api/health'))).body.runtime, 'offline');
    }, realOpts(gw));
  } finally { await gw.close(); }
});

test('rule 19: info, mode switch both ways, 409 when Real is not configured, strict body', async () => {
  const gw = await fakeGateway(); const search = await fakeSearch();
  try {
    await withServer(async (url) => {
      let info = (await json(await get(url, '/api/info'))).body;
      assert.equal(info.source, 'mock'); assert.equal(info.realAvailable, false); assert.match(info.realHint, /PRIV_LOG_GATEWAY_URL/);
      const refused = await json(await post(url, '/api/mode', { source: 'real' }));
      assert.equal(refused.status, 409); assert.equal(refused.body.error, 'real_not_configured');
      assert.equal((await json(await get(url, '/api/info'))).body.source, 'mock');
      for (const bad of [{}, { source: 'live' }, { source: 'mock', extra: 1 }, [], 'real', { mode: 'real' }]) assert.equal((await post(url, '/api/mode', bad)).status, 400, JSON.stringify(bad));
    });
    await withServer(async (url) => {
      let info = (await json(await get(url, '/api/info'))).body;
      assert.equal(info.source, 'real', 'default is Real when configured'); assert.equal(info.realAvailable, true); assert.equal(info.keyConfigured, true);
      assert.equal(info.real.gatewayOrigin, new URL(gw.base).origin); assert.equal(info.real.searchOrigin, new URL(search.base).origin); assert.equal(info.real.confirmed, false);
      assert.equal((await json(await post(url, '/api/mode', { source: 'mock' }))).body.source, 'mock');
      assert.equal((await json(await get(url, '/api/info'))).body.source, 'mock');
      assert.equal((await json(await post(url, '/api/mode', { source: 'real' }))).body.source, 'real');
      assert.equal((await json(await get(url, '/api/info'))).body.simulated, false);
    }, realOpts(gw, search));
    await withServer(async (url) => {
      assert.equal((await json(await get(url, '/api/info'))).body.source, 'mock', 'MODE=mock wins (the Docker default)');
    }, { env: { ...realEnv(gw), MODE: 'mock' } });
  } finally { await gw.close(); await search.close(); }
});

test('the key is write-only: no route returns it, and info shows presence only', async () => {
  const gw = await fakeGateway({ key: 'a-different-key' }); const search = await fakeSearch();
  try {
    await withServer(async (url) => {
      const seen = [];
      const grab = async (r) => { const t = await r.text(); seen.push(t); return t; };
      for (const p of ['/api/info', '/api/cases', '/api/sinks', '/api/story', '/api/scorecard', '/api/runs', '/api/diagram', '/api/health', '/api/shelf']) await grab(await get(url, p));
      await grab(await post(url, '/api/confirm', { gateway: new URL(gw.base).origin }));
      // the fake gateway echoes the Authorization header on a 401 (the key does not match), so a leak would show up here
      for (const id of ['mcp-allowed-key', 'mcp-tool-not-granted', 'no-credential']) await grab(await post(url, '/api/run', { caseId: id, waitMs: 0 }));
      await grab(await get(url, '/api/runs')); await grab(await get(url, '/api/scorecard'));
      const all = seen.join('\n');
      assert.ok(!all.includes(KEY), 'the key appears in an API answer');
      assert.ok(all.includes('Bearer ***'), 'the raw request is shown with the key masked');
    }, realOpts(gw, search));
  } finally { await gw.close(); await search.close(); }
});

test('Mock replays all 17 cases with the recorded response, lines and score, and makes ZERO outbound attempts (configured Real servers see nothing)', async () => {
  const gw = await fakeGateway(); const search = await fakeSearch();
  guard.attempts.length = 0;
  try {
    await withServer(async (url) => {
      await post(url, '/api/mode', { source: 'mock' });
      const cases = (await json(await get(url, '/api/cases'))).body.cases;
      assert.equal(cases.length, 17);
      for (const c of capture.cases) {
        const { status, body } = await json(await post(url, '/api/run', { caseId: c.id }));
        assert.equal(status, 200, c.id);
        assert.equal(body.source, 'mock');
        assert.deepEqual(body.score, c.score);
        assert.deepEqual(body.outcome, c.outcome);
        assert.deepEqual(body.logged, c.logged);
        assert.ok(body.hops.length === 2 && body.hops.every((h) => /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(h.traceparent)));
        assert.match(body.hops[1].request, /NOT sent/);
      }
      const card = (await json(await get(url, '/api/scorecard'))).body;
      assert.equal(card.rows.length, 17);
      assert.deepEqual(card.rows.map((r) => r.score), capture.cases.map((c) => c.score));
    }, realOpts(gw, search));
    assert.deepEqual(gw.requests, [], 'the configured gateway received nothing');
    assert.deepEqual(search.requests, [], 'the configured search endpoint received nothing');
    assert.deepEqual(guard.attempts, [], 'netguard recorded no outbound attempt');
  } finally { await gw.close(); await search.close(); }
});

test('run validation: unknown case 404, strict body 400, waitMs bounds, cross-origin and bad-host writes refused', async () => {
  await withServer(async (url) => {
    assert.equal((await post(url, '/api/run', { caseId: 'nope' })).status, 404);
    for (const bad of [{}, { caseId: 5 }, { caseId: 'mcp-allowed-key', extra: 1 }, { caseId: 'mcp-allowed-key', waitMs: -1 }, { caseId: 'mcp-allowed-key', waitMs: 99999 }, { caseId: 'mcp-allowed-key', waitMs: 1.5 }, []]) assert.equal((await post(url, '/api/run', bad)).status, 400, JSON.stringify(bad));
    assert.equal((await post(url, '/api/run', { caseId: 'mcp-allowed-key' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(url, '/api/run', { caseId: 'mcp-allowed-key' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
    const bad = await rawHttp(`${url}/api/info`, { headers: { host: 'evil.example' } });
    assert.equal(bad.status, 403);
    assert.equal((await post(url, '/api/run', { caseId: 'x' }, { 'x-workspace': 'Bad Space!' })).status, 400);
    assert.equal((await rawHttp(`${url}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, host: new URL(url).host }, body: '{"a":' + '1'.repeat(400_000) + '}' })).status, 413);
  });
});

test('Real: nothing is sent before the origins are confirmed (412), a wrong confirmation is refused, then the full MCP exchange runs', async () => {
  const gw = await fakeGateway({ audit: '{"user":"u-live","agent":"audit-test","tool":"get_weather","decision":"allow"}' });
  const search = await fakeSearch({ events: EVENTS() });
  try {
    await withServer(async (url) => {
      const early = await json(await post(url, '/api/run', { caseId: 'mcp-allowed-key', waitMs: 0 }));
      assert.equal(early.status, 412); assert.equal(early.body.error, 'confirm_required');
      assert.equal(early.body.gatewayOrigin, new URL(gw.base).origin);
      assert.deepEqual(gw.requests, []); assert.deepEqual(search.requests, []);
      assert.equal((await post(url, '/api/confirm', { gateway: 'https://other.example' })).status, 400);
      assert.equal((await post(url, '/api/confirm', {})).status, 400);
      assert.equal((await confirm(url, gw)).status, 200);
      assert.equal((await json(await get(url, '/api/info'))).body.real.confirmed, true);

      const { status, body } = await json(await post(url, '/api/run', { caseId: 'mcp-allowed-key', waitMs: 0 }));
      assert.equal(status, 200);
      assert.equal(body.source, 'real');
      // three MCP hops then the search hop, every one with traceparent and the same trace id
      assert.deepEqual(gw.requests.map((r) => JSON.parse(r.body).method), ['initialize', 'notifications/initialized', 'tools/call']);
      assert.equal(gw.requests[0].url, '/demo-mcp-app/mcp');
      const traces = [...gw.requests, ...search.requests].map((r) => /^00-([0-9a-f]{32})-[0-9a-f]{16}-01$/.exec(r.headers.traceparent)?.[1]);
      assert.ok(traces.every(Boolean) && new Set(traces).size === 1, 'traceparent with one trace id on every hop');
      assert.equal(new Set([...gw.requests, ...search.requests].map((r) => r.headers.traceparent)).size, 4, 'a fresh span per hop');
      assert.equal(body.traceId, traces[0]);
      assert.equal(gw.requests[0].headers['mcp-session-id'], undefined);
      assert.equal(gw.requests[1].headers['mcp-session-id'], 'sess-fake-1');
      assert.equal(gw.requests[2].headers['mcp-session-id'], 'sess-fake-1');
      assert.ok(gw.requests.every((r) => r.headers.authorization === `Bearer ${KEY}`));
      assert.deepEqual(JSON.parse(gw.requests[2].body).params, { name: 'get_weather', arguments: { city: 'audit-K01' } });
      // the search read back the window and excluded the old event
      assert.equal(search.requests.length, 1);
      assert.equal(search.requests[0].method, 'POST'); assert.equal(search.requests[0].url, '/gateway-events/_search');
      const sink = body.logged.find((l) => l.source === 'search');
      assert.equal(sink.lines.length, 3);
      assert.ok(!sink.lines.some((l) => l.includes('u-old')));
      assert.deepEqual(body.logged.find((l) => l.source === 'response').lines, ['{"user":"u-live","agent":"audit-test","tool":"get_weather","decision":"allow"}']);
      // scored from what came back, with the key redacted in the raw hops
      assert.equal(body.scored, true); assert.equal(body.needsPaste, false);
      assert.deepEqual(body.score, { user: 'met', agent: 'met', tool: 'met', decision: 'met' }, 'the response header adds a decision');
      assert.equal(body.hops.length, 4);
      assert.ok(body.hops[0].request.includes('authorization: Bearer ***'));
      assert.ok(!JSON.stringify(body).includes(KEY));
      assert.equal(body.outcome.http, 200); assert.equal(body.outcome.isError, false);
      assert.ok(body.marks['gateway-log'] === undefined && body.marks.search['0'].some((m) => m.field === 'user'));
      // the next case needs no second confirmation; reset forgets it
      assert.equal((await post(url, '/api/run', { caseId: 'mcp-allowed-key', waitMs: 0 })).status, 200);
      await post(url, '/api/reset', {});
      assert.equal((await post(url, '/api/run', { caseId: 'mcp-allowed-key', waitMs: 0 })).status, 412);
    }, realOpts(gw, search));
  } finally { await gw.close(); await search.close(); }
});

test('Real without a search URL: the run shows the exchange, is NOT scored, and asks for pasted lines; pasting scores with the same scorer', async () => {
  const gw = await fakeGateway();
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const run = (await json(await post(url, '/api/run', { caseId: 'mcp-allowed-key', waitMs: 0 }))).body;
      assert.equal(run.needsPaste, true); assert.equal(run.scored, false); assert.equal(run.score, null);
      assert.equal((await json(await get(url, '/api/scorecard'))).body.rows.find((r) => r.id === 'mcp-allowed-key').needsPaste, true);
      const text = capture.cases.find((c) => c.id === 'mcp-allowed-key').logged[0].lines.join('\n');
      const scored = (await json(await post(url, '/api/score', { text, caseId: 'mcp-allowed-key' }))).body;
      assert.deepEqual(scored.score, { user: 'met', agent: 'met', tool: 'met', decision: 'partial' });
      assert.equal(scored.attached, true);
      const after = (await json(await get(url, '/api/runs'))).body.runs[0];
      assert.equal(after.scored, true); assert.deepEqual(after.score, scored.score);
      assert.ok(after.logged.some((l) => l.source === 'pasted'));
      // pasting again replaces, not stacks
      await post(url, '/api/score', { text: 'unrelated', caseId: 'mcp-allowed-key' });
      const again = (await json(await get(url, '/api/runs'))).body.runs[0];
      assert.equal(again.logged.filter((l) => l.source === 'pasted').length, 1);
      assert.equal(again.score.user, 'missing');
      const md = (await json(await get(url, '/api/scorecard'))).body.markdown;
      assert.match(md, /Real run, scored from the log lines actually returned/);
      assert.match(md, /\| Tool call refused \(tool not in grant\) \| MCP \| not run \| not run \|/);
    }, realOpts(gw));
  } finally { await gw.close(); }
});

test('Real: refusals arrive as JSON-RPC isError on HTTP 200, a rejected credential stops after one hop, tools/list answers over SSE', async () => {
  const gw = await fakeGateway(); const search = await fakeSearch();
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const refused = (await json(await post(url, '/api/run', { caseId: 'mcp-tool-not-granted', waitMs: 0 }))).body;
      assert.equal(refused.outcome.http, 200); assert.equal(refused.outcome.isError, true); assert.match(refused.outcome.note, /isError/);
      const n0 = gw.requests.length;
      const noCred = (await json(await post(url, '/api/run', { caseId: 'no-credential', waitMs: 0 }))).body;
      assert.equal(noCred.outcome.http, 401); assert.equal(noCred.hops.length, 2, 'one gateway hop and the search hop');
      assert.equal(gw.requests.length - n0, 1);
      assert.equal(gw.requests.at(-1).headers.authorization, undefined);
      const unknown = (await json(await post(url, '/api/run', { caseId: 'unknown-key', waitMs: 0 }))).body;
      assert.equal(unknown.outcome.http, 401);
      assert.match(gw.requests.at(-1).headers.authorization, /^Bearer lab-unknown-[0-9a-f]{12}$/);
      assert.notEqual(gw.requests.at(-1).headers.authorization, `Bearer ${KEY}`);
      const list = (await json(await post(url, '/api/run', { caseId: 'mcp-list-filtered', waitMs: 0 }))).body;
      assert.equal(list.outcome.http, 200); assert.equal(list.outcome.isError, false);
      const agg = (await json(await post(url, '/api/run', { caseId: 'aggregate-allowed', waitMs: 0 }))).body;
      assert.equal(gw.requests.at(-1).url, '/aggregate-door/mcp', 'a case with an app uses that app segment');
      assert.equal(agg.outcome.http, 200);
    }, realOpts(gw, search));
  } finally { await gw.close(); await search.close(); }
});

test('Real: A2A, LLM and intent cases are not runnable (409 with the reason) and nothing is sent; Mock still replays them', async () => {
  const gw = await fakeGateway();
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const cases = (await json(await get(url, '/api/cases'))).body.cases;
      assert.deepEqual(cases.filter((c) => !c.realRunnable).map((c) => c.id).sort(), ['a2a-call', 'intent-encoder-unreachable', 'llm-allowed', 'llm-injection', 'llm-model-denied']);
      for (const id of ['a2a-call', 'llm-allowed', 'intent-encoder-unreachable']) {
        const r = await json(await post(url, '/api/run', { caseId: id, waitMs: 0 }));
        assert.equal(r.status, 409); assert.equal(r.body.error, 'not_runnable'); assert.match(r.body.detail, /Paste|UNVERIFIED/);
      }
      assert.deepEqual(gw.requests, []);
      await post(url, '/api/mode', { source: 'mock' });
      assert.equal((await post(url, '/api/run', { caseId: 'llm-allowed' })).status, 200);
    }, realOpts(gw));
  } finally { await gw.close(); }
});

test('Real: a gateway redirect is not followed, not even to another host; a hanging gateway times out with JSON; a down gateway is a clear error', async () => {
  const target = await recorder();
  const redir = await fakeGateway({ redirectTo: `${target.base}/stolen` });
  const hang = await fakeGateway({ hang: true });
  const down = await fakeGateway(); const downUrl = down.url; await down.close();
  try {
    await withServer(async (url) => {
      await confirm(url, redir);
      const r = await json(await post(url, '/api/run', { caseId: 'mcp-allowed-key', waitMs: 0 }));
      assert.equal(r.status, 200); assert.equal(r.body.outcome.http, 302); assert.match(r.body.outcome.note, /redirect not followed/);
      assert.deepEqual(target.requests, []);
    }, realOpts(redir));
    await withServer(async (url) => {
      await confirm(url, hang);
      const r = await json(await post(url, '/api/run', { caseId: 'mcp-allowed-key', waitMs: 0 }));
      assert.equal(r.status, 504); assert.equal(r.body.error, 'timeout'); assert.equal(r.body.hops.length, 0);
    }, { ...realOpts(hang), realTimeoutMs: 200 });
    await withServer(async (url) => {
      await post(url, '/api/confirm', { gateway: new URL(downUrl).origin });
      const r = await json(await post(url, '/api/run', { caseId: 'mcp-allowed-key', waitMs: 0 }));
      assert.equal(r.status, 502); assert.equal(r.body.error, 'connect_refused');
    }, { env: { ...NOENV, PRIV_LOG_GATEWAY_URL: downUrl, PRIV_LOG_AGENT_KEY: KEY }, sleep: async () => {} });
  } finally { await target.close(); await redir.close(); await hang.close(); }
});

test('Real: a failing or malformed search endpoint leaves the run unscored with the reason (no invented score)', async () => {
  const gw = await fakeGateway();
  for (const search of [await fakeSearch({ status: 500, raw: '{"error":"boom"}' }), await fakeSearch({ raw: '{"nothing":true}' }), await fakeSearch({ raw: 'not json at all' })]) {
    try {
      await withServer(async (url) => {
        await confirm(url, gw);
        const r = (await json(await post(url, '/api/run', { caseId: 'mcp-allowed-key', waitMs: 0 }))).body;
        assert.equal(r.scored, false); assert.equal(r.score, null); assert.equal(r.needsPaste, true);
        assert.match(r.searchProblem, /search/);
      }, realOpts(gw, search));
    } finally { await search.close(); }
  }
  await gw.close();
});

test('Real contacts ONLY the two configured origins: a search answer cannot send it anywhere else', async () => {
  const gw = await fakeGateway(); const other = await recorder();
  const search = await fakeSearch({ events: [{ '@timestamp': nowIso(1000), message: `see ${other.base}/evil`, url: `${other.base}/evil` }] });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      await post(url, '/api/run', { caseId: 'mcp-allowed-key', waitMs: 0 });
      assert.deepEqual(other.requests, []);
    }, realOpts(gw, search));
  } finally { await gw.close(); await search.close(); await other.close(); }
});

test('workspaces are separate: one tab confirming or running does not affect another; reset clears only its own', async () => {
  await withServer(async (url) => {
    await post(url, '/api/run', { caseId: 'mcp-allowed-key' }, { 'x-workspace': 'tab-a' });
    assert.equal((await json(await get(url, '/api/runs', { 'x-workspace': 'tab-a' }))).body.runs.length, 1);
    assert.equal((await json(await get(url, '/api/runs', { 'x-workspace': 'tab-b' }))).body.runs.length, 0);
    await post(url, '/api/reset', {}, { 'x-workspace': 'tab-b' });
    assert.equal((await json(await get(url, '/api/runs', { 'x-workspace': 'tab-a' }))).body.runs.length, 1);
    await post(url, '/api/reset', {}, { 'x-workspace': 'tab-a' });
    assert.equal((await json(await get(url, '/api/runs', { 'x-workspace': 'tab-a' }))).body.runs.length, 0);
  });
});

test('scorecard Markdown: one row per case, the four fields, escaped pipes, the honest footer', async () => {
  await withServer(async (url) => {
    const md = (await json(await get(url, '/api/scorecard'))).body.markdown;
    const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Use case') && !l.startsWith('| ---'));
    assert.equal(rows.length, 17);
    assert.match(md, /Measured on 2026-11-07 \(replay of recorded transactions, not a live test\)/);
    assert.match(md, /\| Allowed tool call, signed-in user \| MCP \| met \| partial \| met \| partial \|/);
    assert.match(md, /\| Intent encoder not reachable from the gateway \| Intent \| n\/a \| n\/a \| n\/a \| partial \|/);
    assert.match(md, /met = a log line names it/);
    for (const r of rows) assert.equal(r.replace(/\\\|/g, '').split('|').length, 9, r); // 7 columns => 8 pipes => 9 parts
  });
});

test('/api/score: scores pasted text in either mode, inert JSON out, bounded in, strict body', async () => {
  await withServer(async (url) => {
    const r = (await json(await post(url, '/api/score', { text: 'Access token found for user: <img src=x onerror=alert(1)>, client: audit-test\nMCP call detected for method tools with target: t' }))).body;
    assert.deepEqual([r.score.user, r.score.agent, r.score.tool, r.score.decision], ['met', 'met', 'met', 'missing']);
    assert.equal(r.attached, false);
    assert.equal((await post(url, '/api/score', { text: 'x'.repeat(250_000) })).status, 413);
    for (const bad of [{}, { text: 5 }, { text: 'x', extra: 1 }, { text: 'x', caseId: 'nope' }]) assert.ok([400, 404].includes((await post(url, '/api/score', bad)).status), JSON.stringify(bad));
  });
});

test('story, sinks, cases, diagram endpoints serve the labelled data', async () => {
  await withServer(async (url) => {
    const story = (await json(await get(url, '/api/story'))).body;
    assert.match(story.banner, /Replay of transactions measured on 2026-11-07; nothing is sent\./);
    assert.ok(story.facts.every((f) => ['measured', 'inferred', 'UNVERIFIED'].includes(f.status)));
    const sinks = (await json(await get(url, '/api/sinks'))).body;
    assert.equal(sinks.sinks.length, 5); assert.equal(sinks.requirement.length, 4);
    const d = (await json(await get(url, '/api/diagram?name=llm'))).body;
    assert.equal(d.name, 'llm'); assert.ok(d.steps.length >= 7); assert.ok(d.names.includes('mcp'));
    assert.equal((await json(await get(url, '/api/diagram?name=../../etc/passwd'))).body.name, 'mcp');
    assert.equal((await get(url, '/api/nope')).status, 404);
  });
});
