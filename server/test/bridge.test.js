// The Privilege logs bridge against a fake console and a fake Elasticsearch.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { installNetguard } from '../src/netguard.js';
import { BRIDGE_INDICES, bridgeConfig, readState, runOnce, OVERLAP_MS } from '../src/bridge.js';
import { CONSOLE_TENANT, NOENV, fakeConsole } from './helpers.js';

let guard;
before(() => { guard = installNetguard(); });
after(() => guard.restore());

const APIKEY = 'bridge-api-key-NOT-REAL-0123456789abcdef';
async function fakeEs({ status = 201 } = {}) {
  const puts = [];
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { puts.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b }); res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"result":"created"}'); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, puts, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
const envFor = (cons, es, dir, extra = {}) => ({ ...NOENV, PRIV_LOG_CONSOLE_URL: cons.base, PRIV_LOG_CONSOLE_TENANT: CONSOLE_TENANT, PRIV_LOG_BRIDGE_ES_URL: es.base, PRIV_LOG_BRIDGE_ES_APIKEY: APIKEY, PRIV_LOG_BRIDGE_STATE: path.join(dir, 'state.json'), ...extra });
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
const rec = (id, index, minAgo, data = {}) => ({ _id: id, _index: index, '@timestamp': at(minAgo), Message: 'x', Data: { User: 'u-1', ...data } });

test('a pass copies only decision, AI Guard and approval records, under their own ids, with the API key; nothing else and no key in the state file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-bridge-'));
  const recs = [rec('d1', 'policy-decision-log', 30, { Decision: 'deny' }), rec('g1', 'aiguard-log', 20, { VirtualKeyID: 'sk-orion-' + 'f'.repeat(40) }), rec('a1', 'agent-approval-log', 10), rec('x1', 'audit-log', 5), rec('p1', 'proxy-audit-log', 4)];
  const cons = await fakeConsole({ records: () => recs.map(({ _id, ...r }) => ({ ...r, _id })) });
  const es = await fakeEs();
  try {
    const r = await runOnce({ env: envFor(cons, es, dir), now: () => NOW, log: () => {} });
    assert.equal(r.copied, 3);
    assert.deepEqual(es.puts.map((p) => p.url).sort(), ['/ping-siem-events-v2/_doc/a1', '/ping-siem-events-v2/_doc/d1', '/ping-siem-events-v2/_doc/g1']);
    assert.ok(es.puts.every((p) => p.method === 'PUT' && p.auth === `ApiKey ${APIKEY}`));
    const d1 = JSON.parse(es.puts.find((p) => p.url.endsWith('/d1')).body);
    assert.equal(d1.Index, 'policy-decision-log'); assert.equal(d1.privilege_bridge, true); assert.equal(d1.Data.Decision, 'deny');
    const q = JSON.parse(cons.requests[0].body);
    assert.deepEqual(q.Indices.Elems, BRIDGE_INDICES, 'only the three unexported indices are asked for');
    const st = readState(path.join(dir, 'state.json'));
    assert.equal(st.lastTs, Date.parse(at(10))); assert.equal(st.lastError, null); assert.equal(st.totalCopied, 3);
    assert.ok(!fs.readFileSync(path.join(dir, 'state.json'), 'utf8').includes(APIKEY));
    assert.equal((fs.statSync(path.join(dir, 'state.json')).mode & 0o777), 0o600);
  } finally { await cons.close(); await es.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the next pass overlaps the last copied record by 10 minutes (late records are not lost) and re-writes, never duplicates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-bridge-'));
  const recs = [rec('d1', 'policy-decision-log', 30)];
  const cons = await fakeConsole({ records: () => recs });
  const es = await fakeEs();
  try {
    await runOnce({ env: envFor(cons, es, dir), now: () => NOW, log: () => {} });
    recs.push(rec('late', 'policy-decision-log', 35)); // reached Privilege's store late: older than the last copied record
    cons.requests.length = 0;
    await runOnce({ env: envFor(cons, es, dir), now: () => NOW + 60_000, log: () => {} });
    const q = JSON.parse(cons.requests[0].body);
    assert.equal(Date.parse(q.StartTime), Date.parse(at(30)) - OVERLAP_MS);
    assert.ok(es.puts.some((p) => p.url.endsWith('/late')), 'the late record is copied');
    assert.equal(new Set(es.puts.map((p) => p.url)).size, 2, 'the same ids, so the store holds each record once');
  } finally { await cons.close(); await es.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pages through a busy window (Size/From) and copies every record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-bridge-'));
  const recs = Array.from({ length: 450 }, (_, i) => rec(`r${i}`, 'aiguard-log', 60 + (i % 50)));
  const cons = await fakeConsole({ records: () => recs });
  const es = await fakeEs();
  try {
    const r = await runOnce({ env: envFor(cons, es, dir), now: () => NOW, log: () => {} });
    assert.equal(r.copied, 450); assert.equal(new Set(es.puts.map((p) => p.url)).size, 450);
  } finally { await cons.close(); await es.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed pass (console down, or Elasticsearch refuses) records the error and keeps the saved position, so the next pass catches up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-bridge-'));
  const good = await fakeConsole({ records: () => [rec('d1', 'policy-decision-log', 30)] });
  const es = await fakeEs();
  try {
    await runOnce({ env: envFor(good, es, dir), now: () => NOW, log: () => {} });
    const before1 = readState(path.join(dir, 'state.json')).lastTs;
    const down = await fakeConsole({ status: 503, raw: '{}' });
    await assert.rejects(runOnce({ env: envFor(down, es, dir), now: () => NOW + 60_000, log: () => {} }));
    let st = readState(path.join(dir, 'state.json'));
    assert.equal(st.lastTs, before1); assert.match(st.lastError, /HTTP 503/);
    await down.close();
    const refuse = await fakeEs({ status: 403 });
    await assert.rejects(runOnce({ env: envFor(good, refuse, dir), now: () => NOW + 120_000, log: () => {} }), /HTTP 403/);
    st = readState(path.join(dir, 'state.json')); assert.equal(st.lastTs, before1);
    await refuse.close();
  } finally { await good.close(); await es.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a record without a string _id is skipped, never written under a made-up id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plab-bridge-'));
  const cons = await fakeConsole({ records: () => [{ _index: 'policy-decision-log', '@timestamp': at(5), Data: {} }, rec('ok1', 'policy-decision-log', 4)] });
  const es = await fakeEs();
  try {
    const r = await runOnce({ env: envFor(cons, es, dir), now: () => NOW, log: () => {} });
    assert.equal(r.copied, 1); assert.deepEqual(es.puts.map((p) => p.url), ['/ping-siem-events-v2/_doc/ok1']);
  } finally { await cons.close(); await es.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('config: the bridge needs the console settings, an https (or loopback) Elasticsearch origin and a key', () => {
  const c = { PRIV_LOG_CONSOLE_URL: 'https://console.example.invalid', PRIV_LOG_CONSOLE_TENANT: CONSOLE_TENANT };
  assert.match(bridgeConfig({ ...NOENV }, { file: false }).problem, /PRIV_LOG_CONSOLE_URL/);
  assert.match(bridgeConfig({ ...NOENV, ...c }, { file: false }).problem, /PRIV_LOG_BRIDGE_ES_URL is not set/);
  assert.match(bridgeConfig({ ...NOENV, ...c, PRIV_LOG_BRIDGE_ES_URL: 'http://es.example.invalid' }, { file: false }).problem, /https unless it is on loopback/);
  assert.match(bridgeConfig({ ...NOENV, ...c, PRIV_LOG_BRIDGE_ES_URL: 'https://es.example.invalid' }, { file: false }).problem, /APIKEY/);
  assert.equal(bridgeConfig({ ...NOENV, ...c, PRIV_LOG_BRIDGE_ES_URL: 'https://es.example.invalid', PRIV_LOG_BRIDGE_ES_APIKEY: APIKEY }, { file: false }).ok, true);
});
