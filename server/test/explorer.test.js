// The Privilege -> Elasticsearch explorer: ranges, filters, paging through the console, caps, related records, field parsing, KQL.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { installNetguard } from '../src/netguard.js';
import { createRealClient } from '../src/realClient.js';
import { newTrace } from '../src/trace.js';
import { CONSOLE_PAGE, KIBANA_HINT, RECORD_CAP, SEARCH_WINDOW, applyFilters, bucketFor, entryOf, fieldsOf, histogramOf, kibanaUrl, kqlOf, limitNote, parseExplorerQuery, parseRelatedQuery, readWindow, relatedOf, summaryOf } from '../src/privilegeExplorer.js';
import { kibanaConfig } from '../src/config.js';
import { CONSOLE_TENANT, KEY, NOENV, consoleEnv, fakeConsole, fakeGateway, get, post, withServer } from './helpers.js';

let guard;
before(() => { guard = installNetguard(); });
after(() => guard.restore());

const iso = (t) => new Date(t).toISOString();
const confirm = (url, gw) => post(url, '/api/confirm', { gateway: new URL(gw.base).origin });
const NOW = Date.parse('2026-11-07T22:20:00Z');
const decision = (at, data = {}) => ({ '@timestamp': iso(at), Level: 'INFO', Message: 'AIPolicyDecision', Data: { AgentKey: 'lab-test-key', App: 'demo-mcp-app', Decision: 'deny', Event: 'policy_decision', PrincipalKind: 'User', Reason: 'r', RequestID: 'req-1', Target: 'get_weather', User: 'u-1111', ...data } });
const json = async (url, p) => { const r = await get(url, p); return { status: r.status, body: await r.json() }; };

test('query: quick ranges, custom ISO ranges within 90 days, and every bad parameter is a 400 reason', () => {
  const ok = parseExplorerQuery({ range: '24h', kind: 'runtime', decision: 'hitl', user: 'u-1', page: '2' }, { now: NOW });
  assert.equal(ok.to - ok.from, 86_400_000); assert.deepEqual(ok.filters, { kind: 'runtime', decision: 'hitl', user: 'u-1' }); assert.equal(ok.page, 2);
  const c = parseExplorerQuery({ from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00.000+01:00' }, { now: NOW });
  assert.equal(c.from, Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(parseExplorerQuery({}, { now: NOW }).to - parseExplorerQuery({}, { now: NOW }).from, 3_600_000, 'default: the last hour');
  const bad = [
    { range: '2h' }, { range: '1h', from: '2026-11-07T00:00:00Z', to: '2026-11-07T01:00:00Z' }, { from: '2026-11-07T00:00:00Z' },
    { from: '2026-11-07T00:00:00', to: '2026-11-07T01:00:00' }, { from: 'yesterday', to: 'today' },
    { from: '2026-11-07T02:00:00Z', to: '2026-11-07T01:00:00Z' }, { from: '2026-11-07T01:00:00Z', to: '2026-11-07T01:00:00Z' },
    { from: '2026-08-01T00:00:00Z', to: '2026-08-02T00:00:00Z' }, { from: '2026-11-07T00:00:00Z', to: '2026-11-09T00:00:00Z' },
    { kind: 'admin' }, { index: 'secrets-log' }, { decision: 'maybe' }, { user: 'x'.repeat(201) }, { tool: '' }, { app: 'a\u0000b' },
    { q: 'y'.repeat(201) }, { page: '-1' }, { page: '1000' }, { page: '1.5' }, { all: 'yes' }, { minutes: '60' }, { user: ['a', 'b'] }, { tool: { $ne: 1 } },
  ];
  for (const q of bad) assert.ok(parseExplorerQuery(q, { now: NOW }).error, `accepted ${JSON.stringify(q)}`);
});

test('query: impossible calendar times are refused, not rolled over', () => {
  for (const [from, to] of [['2026-09-31T00:00:00Z', '2026-10-02T00:00:00Z'], ['2026-11-06T24:00Z', '2026-11-07T01:00Z'], ['2026-02-29T00:00:00Z', '2026-03-01T00:00:00Z'],
    ['2026-13-01T00:00:00Z', '2026-11-07T00:00:00Z'], ['2026-11-00T00:00:00Z', '2026-11-07T00:00:00Z'], ['2026-11-06T10:60:00Z', '2026-11-07T00:00:00Z'],
    ['2026-11-06T10:00:60Z', '2026-11-07T00:00:00Z'], ['2026-11-06T10:00:00+24:00', '2026-11-07T00:00:00Z'], ['2026-11-06T10:00:00+01:60', '2026-11-07T00:00:00Z']]) {
    assert.equal(parseExplorerQuery({ from, to }, { now: NOW }).error, 'bad_range', `accepted ${from}`);
  }
  assert.equal(parseExplorerQuery({ from: '2026-09-30T23:59:59.999Z', to: '2026-11-06T23:59:59-05:00' }, { now: NOW }).from, Date.parse('2026-09-30T23:59:59.999Z'), 'real edge times still pass');
  assert.equal(parseRelatedQuery({ request_id: 'r', at: '2026-10-32T00:00:00Z' }, { now: NOW }).error, 'bad_at');
});

test('query: a field filter takes every value a facet can offer (fields keep 200 characters)', () => {
  const long = 'u'.repeat(250);
  const facet = fieldsOf({ Data: { User: long, Target: 't'.repeat(250), App: 'a'.repeat(250) } });
  for (const [k, v] of [['user', facet.user], ['tool', facet.tool], ['app', facet.app]]) {
    assert.equal(v.length, 200);
    assert.equal(parseExplorerQuery({ [k]: v }, { now: NOW }).filters[k], v, `${k} facet value refused`);
  }
  assert.equal(parseExplorerQuery({ user: 'u'.repeat(201) }, { now: NOW }).error, 'bad_user');
});

test('related query: needs at and an id; ids are bounded; the window is +/-10 minutes', () => {
  const r = parseRelatedQuery({ request_id: 'req-1', at: '2026-11-07T22:16:54.933Z' }, { now: NOW });
  assert.equal(r.to - r.from, 20 * 60_000); assert.equal(r.traceId, null);
  assert.equal(parseRelatedQuery({ request_id: 'r', at: iso(NOW + 30_000) }, { now: NOW }).at, NOW + 30_000, 'a little clock skew is allowed');
  for (const q of [{ at: '2026-11-07T22:00:00Z' }, { request_id: 'r' }, { request_id: 'a b', at: '2026-11-07T22:00:00Z' }, { trace_id: 'x'.repeat(129), at: '2026-11-07T22:00:00Z' }, { request_id: 'r', at: '2025-01-01T00:00:00Z' }, { request_id: 'r', at: iso(NOW + 2 * 60_000) }, { request_id: 'r', at: '2026-11-09T00:00:00Z' }, { request_id: 'r', at: '2026-11-07T22:00:00Z', extra: '1' }]) {
    assert.ok(parseRelatedQuery(q, { now: NOW }).error, `accepted ${JSON.stringify(q)}`);
  }
});

test('fields: decision, AI Guard (client), HTTP (trace id from Traceparent) and console (User.Name) records; every field redacted', () => {
  const d = fieldsOf(decision(NOW).valueOf());
  assert.deepEqual([d.user, d.agent, d.agentFrom, d.principalKind, d.tool, d.decision, d.app, d.event, d.requestId, d.traceId], ['u-1111', 'lab-test-key', 'agent key', 'User', 'get_weather', 'deny', 'demo-mcp-app', 'policy_decision', 'req-1', null]);
  const g = fieldsOf({ Message: 'AIGuard', Data: { Client: 'sk-orion-' + 'a'.repeat(40), RequestID: 'req-1', TraceID: 'f'.repeat(32), Event: 'mcp_response_blocked', User: 'u-1111' } });
  assert.equal(g.agentFrom, 'client'); assert.match(g.agent, /^sk-orion\*\*\*a{4}$/, 'a key in a field is masked'); assert.equal(g.traceId, 'f'.repeat(32));
  const h = fieldsOf({ Message: 'Received HTTP request', Data: { Headers: { Traceparent: ['00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01'] } } });
  assert.equal(h.traceId, 'a'.repeat(32));
  assert.equal(fieldsOf({ Data: { Headers: { Traceparent: ['not-a-traceparent'] } } }).traceId, null);
  assert.equal(fieldsOf({ Module: 'apigw', Data: 'changed', User: { Name: 'admin@example.invalid' } }).user, 'admin@example.invalid');
  assert.deepEqual(Object.values(fieldsOf(null)).filter(Boolean), []);
  const e = entryOf({ _index: 'audit-log', _source: { '@timestamp': '2026-11-07T22:00:00Z', Module: 'apigw', Data: 'x' } });
  assert.equal(e.kind, 'console'); assert.equal(e.at, '2026-11-07T22:00:00.000Z');
});

test('filters, related lookup (one hop) and the histogram', () => {
  const es = [
    entryOf({ _index: 'policy-decision-log', _source: decision(NOW - 60_000, { Decision: 'hitl', RequestID: 'req-9' }) }),
    entryOf({ _index: 'aiguard-log', _source: { '@timestamp': iso(NOW - 50_000), Message: 'AIGuard', Data: { RequestID: 'req-9', TraceID: 'c'.repeat(32), Event: 'mcp_response_blocked', Client: 'cli' } } }),
    entryOf({ _index: 'proxy-audit-log', _source: { '@timestamp': iso(NOW - 70_000), Message: 'Received HTTP request', Data: { Headers: { Traceparent: [`00-${'c'.repeat(32)}-${'1'.repeat(16)}-01`] } } } }),
    entryOf({ _index: 'policy-decision-log', _source: decision(NOW - 30_000, { RequestID: 'req-other' }) }),
  ];
  assert.equal(applyFilters(es, { decision: 'hitl' }).length, 1);
  assert.equal(applyFilters(es, { agent: 'cli' })[0].index, 'aiguard-log');
  assert.equal(applyFilters(es, { q: 'RECEIVED http' }).length, 1, 'free text is case-insensitive over the redacted record');
  assert.equal(applyFilters(es, { kind: 'console' }).length, 0);
  const rel = relatedOf(es, { requestId: 'req-9', traceId: null });
  assert.deepEqual(rel.map((e) => [e.index, e.via]), [['proxy-audit-log', 'linked through another related record'], ['policy-decision-log', 'request id'], ['aiguard-log', 'request id']]);
  assert.ok(!rel.some((e) => e.fields.requestId === 'req-other'));
  const h = histogramOf(es, NOW - 15 * 60_000, NOW);
  assert.equal(h.bucketMs, 60_000); assert.equal(h.buckets.length, 15); assert.equal(h.buckets.reduce((n, b) => n + b.count, 0), 4);
  const edge = [entryOf({ _index: 'aiguard-log', _source: { '@timestamp': iso(NOW), Message: 'AIGuard', Data: {} } }), entryOf({ _index: 'aiguard-log', _source: { '@timestamp': iso(NOW - 15 * 60_000), Message: 'AIGuard', Data: {} } }),
    entryOf({ _index: 'aiguard-log', _source: { '@timestamp': iso(NOW + 1), Message: 'AIGuard', Data: {} } }), entryOf({ _index: 'aiguard-log', _source: { '@timestamp': iso(NOW - 15 * 60_000 - 1), Message: 'AIGuard', Data: {} } })];
  const he = histogramOf(edge, NOW - 15 * 60_000, NOW);
  assert.equal(he.buckets.length, 15, 'a whole number of buckets: no extra bucket for a record exactly at to');
  assert.deepEqual([he.buckets[0].count, he.buckets[14].count, he.buckets.reduce((n, b) => n + b.count, 0)], [1, 1, 2], 'from and to are inside; records outside the range are not counted');
  const sum = summaryOf([...es, entryOf({ _index: 'aiguard-log', _source: { '@timestamp': iso(NOW), Message: 'AIGuard', Data: { Decision: 'deny', Event: 'e' } } })]);
  assert.deepEqual(sum.decisions, { allow: 0, deny: 1, hitl: 1 }, 'only policy-decision-log records count as decisions');
  assert.equal(bucketFor(90 * 86_400_000), 2 * 86_400_000); assert.ok(Math.ceil((7 * 86_400_000) / bucketFor(7 * 86_400_000)) <= 60);
});

test('KQL and the Discover link: every filter maps to its field; quotes are escaped; the time range rides along', () => {
  assert.equal(kqlOf({}), '');
  assert.equal(kqlOf({ kind: 'unknown', index: 'unknown' }), '', 'unknown kind or index has no KQL field to match');
  assert.equal(kqlOf({ tool: 'a\\' }), 'privilege.tool : "a\\\\"', 'a trailing backslash is escaped, so it cannot close the quoted string');
  assert.equal(kqlOf({ tool: 'a\\" or *' }), 'privilege.tool : "a\\\\\\" or *"');
  assert.equal(kqlOf({ kind: 'runtime', index: 'aiguard-log', user: 'u-1', agent: 'k', tool: 't', decision: 'deny', app: 'a', event: 'e', q: 'say "hi"' }),
    'privilege_event_kind : "runtime" and Index : "aiguard-log" and (privilege.user : "u-1" or User.Name : "u-1") and (privilege.agent_key : "k" or privilege.client : "k") and privilege.tool : "t" and privilege.decision : "deny" and privilege.app : "a" and privilege.event : "e" and "say \\"hi\\""');
  const u = kibanaUrl('http://localhost:5601', { fromMs: NOW - 3_600_000, toMs: NOW, kql: "privilege.tool : \"it's!\"" });
  assert.ok(u.startsWith('http://localhost:5601/app/discover#/?_g='));
  const g = decodeURIComponent(/_g=([^&]+)/.exec(u)[1]); const a = decodeURIComponent(/_a=(.+)$/.exec(u)[1]);
  assert.equal(g, "(time:(from:'2026-11-07T21:20:00.000Z',to:'2026-11-07T22:20:00.000Z'))");
  assert.equal(a, "(index:'privilege-logs',query:(language:kuery,query:'privilege.tool : \"it!'s!!\"'))", 'rison escapes ! and \'');
  const raw = kibanaUrl('http://localhost:5601', { fromMs: NOW - 3_600_000, toMs: NOW, kql: 'privilege.tool : "a&_a=(x)#y %27 b"' });
  const tail = raw.slice('http://localhost:5601/app/discover#'.length);
  assert.equal(raw.split('#').length, 2, 'a # in a value is encoded'); assert.equal(tail.split('&').length, 2, 'an & in a value is encoded');
  assert.ok(!/[ ":]/.test(tail.split('&')[1].slice(3)), '_a is percent-encoded'); assert.ok(!/:/.test(tail.split('&')[0].slice(4)), '_g is percent-encoded');
  assert.ok(tail.includes('%2527'), 'a % in a value is encoded once more');
  assert.equal(decodeURIComponent(/&_a=(.+)$/.exec(raw)[1]), "(index:'privilege-logs',query:(language:kuery,query:'privilege.tool : \"a&_a=(x)#y %27 b\"'))");
  assert.match(KIBANA_HINT, /port-forward svc\/kibana-siem 5601:5601/);
  assert.match(KIBANA_HINT, /--context <your-context> -n <your-namespace> /, 'the hint names no real context or namespace');
  assert.equal(kibanaConfig(NOENV, { file: false }).origin, 'http://localhost:5601');
  assert.equal(kibanaConfig({ ...NOENV, PRIVILEGE_KIBANA_URL: 'https://kibana.example.invalid' }, { file: false }).origin, 'https://kibana.example.invalid');
  assert.match(kibanaConfig({ ...NOENV, PRIVILEGE_KIBANA_URL: 'http://kibana.example.invalid' }, { file: false }).problem, /https/);
});

test('readWindow pages with Size and From until the records run out, the cap or the search window, and says which', async () => {
  const at = Date.now() - 60_000;
  const recs = Array.from({ length: 23 }, (_, i) => ({ ...decision(at + i, { RequestID: `r${i}` }) }));
  const cons = await fakeConsole({ records: recs });
  const client = createRealClient({ origins: [cons.base] });
  const decisions = { url: new URL(cons.base), origin: cons.base, tenant: CONSOLE_TENANT };
  const span = { client, decisions, fromMs: at - 1000, toMs: at + 60_000, trace: newTrace() };
  try {
    const all = await readWindow({ ...span, pageSize: 5 });
    assert.equal(all.hits.length, 23); assert.equal(all.stop, 'end'); assert.equal(all.requests, 5);
    const sent = cons.requests.map((r) => JSON.parse(r.body)).map((b) => [b.Size, b.From]);
    assert.deepEqual(sent, [[5, 0], [5, 5], [5, 10], [5, 15], [5, 20]]);
    const capped = await readWindow({ ...span, pageSize: 5, cap: 12 });
    assert.equal(capped.hits.length, 12); assert.equal(capped.stop, 'cap'); assert.equal(capped.total, 23);
    assert.match(limitNote({ stop: 'cap', read: 12, total: 23, cap: 12 }), /reports 23 records.*at most 12 per query.*only 12 were read.*capped sample/);
    const win = await readWindow({ ...span, pageSize: 5, window: 10 });
    assert.equal(win.hits.length, 10); assert.equal(win.stop, 'window');
    assert.match(limitNote({ stop: 'window', read: 10, total: 23, window: 10 }), /search stops at 10 records \(From \+ Size\)/);
    assert.equal((await readWindow({ ...span, pageSize: 5, cap: 23 })).stop, 'end', 'exactly the total is not cut off');
    assert.equal(limitNote({ stop: 'end', read: 3, total: 3 }), null);
    assert.deepEqual([CONSOLE_PAGE, RECORD_CAP, SEARCH_WINDOW], [200, 5_000, 10_000]);
    assert.match(limitNote({ stop: 'cap', read: 5_000, total: null }), /may hold more.*at most 5,000 per query/);
  } finally { await cons.close(); }
});

test('readWindow keeps at most Size hits per answer, so a console that ignores Size cannot push it past the cap', async () => {
  const at = Date.now() - 60_000;
  const hits = Array.from({ length: 7 }, (_, i) => ({ _index: 'policy-decision-log', _source: decision(at + i, { RequestID: `r${i}` }) }));
  const cons = await fakeConsole({ raw: JSON.stringify({ Response: Buffer.from(JSON.stringify({ hits: { total: { value: 100 }, hits } })).toString('base64') }) });
  const client = createRealClient({ origins: [cons.base] });
  try {
    const r = await readWindow({ client, decisions: { url: new URL(cons.base), origin: cons.base, tenant: CONSOLE_TENANT }, fromMs: at - 1000, toMs: at + 60_000, trace: newTrace(), pageSize: 5, cap: 12 });
    assert.equal(r.hits.length, 12); assert.equal(r.stop, 'cap');
    assert.deepEqual(cons.requests.map((q) => JSON.parse(q.body)).map((b) => [b.Size, b.From]), [[5, 0], [5, 5], [2, 10]]);
  } finally { await cons.close(); }
});

test('Mock API: ranges count back from the end of the recording, filters narrow, Related follows request id then trace id', async () => {
  await withServer(async (url) => {
    const m15 = (await json(url, '/api/privilege-logs?range=15m')).body;
    assert.equal(m15.clock.mock, true); assert.equal(m15.clock.now, '2026-11-07T22:20:00.000Z');
    assert.equal(m15.read, 7, 'the 21:48 and 2026-11-04 console records are outside 15 minutes');
    assert.equal((await json(url, '/api/privilege-logs?range=1h')).body.read, 8);
    const all = (await json(url, '/api/privilege-logs?range=7d')).body;
    assert.equal(all.read, 9);
    assert.deepEqual(all.summary.kinds, { runtime: 7, console: 2, unknown: 0 });
    assert.deepEqual(all.summary.decisions, { allow: 0, deny: 1, hitl: 4 });
    assert.deepEqual(all.summary.aiguard, { mcp_response_blocked: 1 });
    assert.ok(all.facets.tool.some((f) => f.value === 'SearchIndexTool'));
    assert.equal(all.histogram.buckets.reduce((n, b) => n + b.count, 0), 9);
    const deny = (await json(url, '/api/privilege-logs?range=7d&decision=deny')).body;
    assert.equal(deny.entries.length, 1); assert.equal(deny.entries[0].fields.tool, 'GenericOpenSearchApiTool');
    assert.equal(deny.kibana.kql, 'privilege.decision : "deny"'); assert.match(deny.kibana.url, /^http:\/\/localhost:5601\/app\/discover#\/\?_g=/);
    assert.equal((await json(url, '/api/privilege-logs?range=7d&kind=console')).body.entries.length, 2);
    assert.equal((await json(url, '/api/privilege-logs?range=7d&q=mcp_response_blocked')).body.entries[0].index, 'aiguard-log');
    const custom = (await json(url, `/api/privilege-logs?from=${encodeURIComponent('2026-11-04T15:00:00Z')}&to=${encodeURIComponent('2026-11-04T16:00:00Z')}`)).body;
    assert.deepEqual(custom.entries.map((e) => e.index), ['audit-log']);
    assert.equal((await get(url, '/api/privilege-logs?from=2026-07-01T00:00:00Z&to=2026-07-02T00:00:00Z')).status, 400, 'more than 90 days before the recording ends');
    const anchor = all.entries.find((e) => e.fields.event === 'policy_approval_required' && e.at === '2026-11-07T22:16:54.933Z');
    const rel = (await json(url, `/api/privilege-logs/related?request_id=${encodeURIComponent(anchor.fields.requestId)}&at=${anchor.at}`)).body;
    assert.deepEqual(rel.entries.map((e) => e.index), ['proxy-audit-log', 'policy-decision-log', 'aiguard-log']);
    assert.equal(rel.entries.find((e) => e.index === 'proxy-audit-log').via, 'linked through another related record');
    assert.equal((await get(url, '/api/privilege-logs/related?at=2026-11-07T22:16:54.933Z')).status, 400);
    const past = (await json(url, '/api/privilege-logs?range=7d&page=999')).body;
    assert.deepEqual([past.paging.page, past.paging.pages, past.paging.newer, past.paging.older, past.entries.length], [0, 1, false, false, 9], 'a page past the end shows the last page');
  });
});

test('Real API: pages through the console, pages the filtered set (older/newer), notes the cap, caches the read, needs the confirm, never leaks the key', async () => {
  const gw = await fakeGateway();
  const at = Date.now() - 30 * 60_000;
  const recs = Array.from({ length: 260 }, (_, i) => ({ _index: i % 2 ? 'policy-decision-log' : 'aiguard-log', ...decision(at + i * 1000, { RequestID: `r${i}`, Decision: i % 4 === 1 ? 'hitl' : 'deny', ...(i === 7 ? { Client: KEY } : {}) }) }));
  const cons = await fakeConsole({ records: recs });
  try {
    await withServer(async (url) => {
      assert.equal((await get(url, '/api/privilege-logs?range=1h')).status, 412);
      assert.equal((await get(url, '/api/privilege-logs/related?request_id=r1&at=' + iso(at))).status, 412);
      await confirm(url, gw);
      const p0 = (await json(url, '/api/privilege-logs?range=1h&index=policy-decision-log')).body;
      assert.equal(p0.read, 260, 'more than one console page of 200 is read'); assert.equal(p0.reported, 260); assert.equal(p0.limit, null);
      const sizes = cons.requests.map((r) => JSON.parse(r.body)).map((b) => [b.Size, b.From]);
      assert.deepEqual(sizes, [[200, 0], [200, 200]]);
      assert.deepEqual([p0.paging.total, p0.paging.pages, p0.paging.newer, p0.paging.older, p0.entries.length], [130, 3, false, true, 50]);
      const p2 = (await json(url, `/api/privilege-logs?from=${p0.from}&to=${p0.to}&index=policy-decision-log&page=2`)).body;
      assert.deepEqual([p2.entries.length, p2.paging.newer, p2.paging.older], [30, true, false]);
      assert.ok(p2.entries[0].at < p0.entries.at(-1).at, 'older pages hold older records');
      assert.equal(cons.requests.length, 2, 'paging the same window reuses the read');
      const allHitl = (await json(url, `/api/privilege-logs?from=${p0.from}&to=${p0.to}&decision=hitl&all=1`)).body;
      assert.equal(allHitl.entries.length, 65); assert.equal(allHitl.paging.all, true);
      const rel = (await json(url, `/api/privilege-logs/related?request_id=r9&at=${iso(at + 9000)}`)).body;
      assert.deepEqual(rel.entries.map((e) => e.fields.requestId), ['r9']);
      for (const b of [p0, p2, allHitl, rel]) assert.ok(!JSON.stringify(b).includes(KEY), 'the agent key reached an answer');
      assert.equal((await get(url, '/api/privilege-logs?range=1h&nope=1')).status, 400);
    }, { env: consoleEnv(gw, cons) });
  } finally { await gw.close(); await cons.close(); }
});

test('Real API: the cached read is keyed by the range and expires after a minute', async () => {
  const gw = await fakeGateway();
  let clock = Date.now();
  const at = clock - 30 * 60_000;
  const cons = await fakeConsole({ records: Array.from({ length: 5 }, (_, i) => decision(at + i * 60_000, { RequestID: `r${i}` })) });
  const w = (a, b) => `/api/privilege-logs?from=${encodeURIComponent(iso(a))}&to=${encodeURIComponent(iso(b))}`;
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const one = w(at - 60_000, at + 10 * 60_000); const other = w(at - 60_000, at + 2.5 * 60_000);
      assert.equal((await json(url, one)).body.read, 5); assert.equal(cons.requests.length, 1);
      await json(url, `${one}&decision=deny`); assert.equal(cons.requests.length, 1, 'same range, other filter: cached');
      const narrow = (await json(url, other)).body;
      assert.equal(narrow.read, 3, 'another range is read again, not served from the cache'); assert.equal(cons.requests.length, 2);
      const rel = (await json(url, `/api/privilege-logs/related?request_id=r0&at=${iso(at)}`)).body;
      assert.deepEqual(rel.entries.map((e) => e.fields.requestId), ['r0']); assert.equal(cons.requests.length, 3, 'Related reads its own +/-10 min window');
      assert.equal((await json(url, other)).body.read, 3); assert.equal(cons.requests.length, 4, 'only the last range is kept');
      clock += 59_000; await json(url, other); assert.equal(cons.requests.length, 4, 'within a minute: cached');
      clock += 2_000; await json(url, other); assert.equal(cons.requests.length, 5, 'after a minute: read again');
    }, { env: consoleEnv(gw, cons), now: () => clock });
  } finally { await gw.close(); await cons.close(); }
});

test('Real API: more records than the cap -> a plain capped-sample note (the cap is lowered here to keep the test light)', async () => {
  const gw = await fakeGateway();
  const at = Date.now() - 30 * 60_000;
  const cons = await fakeConsole({ records: Array.from({ length: 450 }, (_, i) => decision(at + i * 100, { RequestID: `r${i}` })) });
  try {
    await withServer(async (url) => {
      await confirm(url, gw);
      const r = (await json(url, '/api/privilege-logs?range=1h')).body;
      assert.equal(r.read, 400); assert.equal(r.reported, 450);
      assert.match(r.limit, /reports 450 records in this range; the lab reads at most 400 per query, so only 400 were read/);
      assert.equal(r.summary.total, 400); assert.equal(cons.requests.length, 2);
    }, { env: consoleEnv(gw, cons), privilegeCap: 400 });
  } finally { await gw.close(); await cons.close(); }
});
