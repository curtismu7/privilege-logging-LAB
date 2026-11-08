import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RealError, createRealClient } from '../src/realClient.js';
import { fakeGateway, recorder } from './helpers.js';
import { runMcp } from '../src/mcpRunner.js';
import { textHop } from '../src/lab.js';
import { newTrace } from '../src/trace.js';
import { loadCapture } from '../src/capture.js';

const rejects = (p, code) => assert.rejects(p, (e) => e instanceof RealError && e.code === code, code);

test('only the configured origins can be contacted: another loopback port is refused before any socket opens', async () => {
  const gw = await fakeGateway(); const other = await recorder();
  try {
    const client = createRealClient({ origins: [new URL(gw.base).origin] });
    await rejects(client.request({ url: `${other.base}/x` }), 'origin_not_allowed');
    await rejects(client.request({ url: 'https://elsewhere.example/x' }), 'origin_not_allowed');
    assert.deepEqual(other.requests, []);
    const ok = await client.request({ url: `${gw.base}/anything`, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(ok.status, 401);
  } finally { await gw.close(); await other.close(); }
});

test('a redirect is never followed, even to the other configured origin', async () => {
  const target = await recorder();
  const gw = await fakeGateway({ redirectTo: `${target.base}/stolen` });
  try {
    const client = createRealClient({ origins: [new URL(gw.base).origin, new URL(target.base).origin] });
    const res = await client.request({ url: `${gw.base}/x`, method: 'POST', body: '{}' });
    assert.equal(res.status, 302);
    assert.equal(res.redirect, true);
    assert.deepEqual(target.requests, []);
  } finally { await gw.close(); await target.close(); }
});

test('the body is capped (reading stops, truncated is reported) and the request has a time cap', async () => {
  const big = await fakeGateway({ bigBody: true });
  const slow = await fakeGateway({ hang: true });
  try {
    const c1 = createRealClient({ origins: [new URL(big.base).origin], maxBytes: 10_000 });
    const r = await c1.request({ url: `${big.base}/x`, method: 'POST', body: '{}' });
    assert.equal(r.truncated, true);
    assert.ok(r.text.length <= 10_000);
    const c2 = createRealClient({ origins: [new URL(slow.base).origin], timeoutMs: 150 });
    const t0 = Date.now();
    await rejects(c2.request({ url: `${slow.base}/x`, method: 'POST', body: '{}' }), 'timeout');
    assert.ok(Date.now() - t0 < 2000);
  } finally { await big.close(); await slow.close(); }
});

test('insecure and credentialed URLs are refused', async () => {
  const c = createRealClient({ origins: ['http://gateway.example', 'https://user:pw@gateway.example', 'https://169.254.169.254'] });
  await rejects(c.request({ url: 'http://gateway.example/x' }), 'insecure_origin');
  await rejects(c.request({ url: 'https://user:pw@gateway.example/x' }), 'origin_not_allowed'); // origin has no userinfo, so it does not match
  await rejects(c.request({ url: 'https://169.254.169.254/x' }), 'blocked_address');
  await rejects(c.request({ url: 'not a url' }), 'bad_url');
});

test('SSRF: a host NAME that resolves to a private or metadata address is refused at connect time, and the checked address is the one used', async () => {
  const seen = [];
  const lookupTo = (address) => (host, opts, cb) => { seen.push(host); cb(null, opts.all ? [{ address, family: 4 }] : address, 4); };
  for (const a of ['10.0.0.9', '169.254.169.254', '192.168.1.5', '100.64.1.1']) {
    const c = createRealClient({ origins: ['https://gateway.example'], lookup: lookupTo(a) });
    await rejects(c.request({ url: 'https://gateway.example/x' }), 'blocked_address');
  }
  // one private address among public ones is enough to refuse (rebinding mix)
  const mixed = (host, opts, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], 4);
  await rejects(createRealClient({ origins: ['https://gateway.example'], lookup: mixed }).request({ url: 'https://gateway.example/x' }), 'blocked_address');
  assert.ok(seen.length >= 4);
});

test('the secret is redacted from the response text and from error text', async () => {
  const gw = await fakeGateway({ key: 'a-different-key' });
  try {
    const secret = 'sk-test-secret-value-1234';
    const client = createRealClient({ origins: [new URL(gw.base).origin], secrets: [secret] });
    const res = await client.request({ url: `${gw.base}/x`, method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: '{}' });
    assert.equal(res.status, 401);
    assert.ok(res.text.includes('Bearer ***'), res.text); // the fake echoes the Authorization header; the client masks the key
    assert.ok(!res.text.includes(secret));
    assert.equal(client.redact(`oops ${secret} and ${secret}`), 'oops *** and ***');
  } finally { await gw.close(); }
});

test('an oversized request body is refused before sending', async () => {
  const c = createRealClient({ origins: ['https://gateway.example'] });
  await rejects(c.request({ url: 'https://gateway.example/x', method: 'POST', body: 'x'.repeat(20_000) }), 'request_too_large');
});

test('a gateway that reflects the Authorization value in response headers never hands the key back (headers, audit header, Trace text)', async () => {
  const secret = 'sk-test-reflect-value-5678';
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-echo-auth', auth);
    res.setHeader('x-gw-audit-trail', `caller=${auth}`);
    res.setHeader('mcp-session-id', 'sess-reflect');
    req.resume(); req.on('end', () => res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = createRealClient({ origins: [base], secrets: [secret] });
    const res = await client.request({ url: `${base}/x`, method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: '{}' });
    assert.equal(res.headers['x-echo-auth'], 'Bearer ***');
    assert.equal(res.headers['x-gw-audit-trail'], 'caller=Bearer ***');
    const c = loadCapture().cases.find((x) => x.request.method === 'tools/call' && x.request.auth !== 'bearer');
    assert.ok(c, 'a key-auth tools/call case exists');
    const out = await runMcp({ client, gatewayUrl: `${base}/demo/mcp`, key: secret, c, trace: newTrace(), marker: 'audit-deadbeef' });
    assert.ok(out.hops.length >= 1);
    const text = JSON.stringify({ out, hops: out.hops.map((h, i) => textHop(h, i + 1)) });
    assert.ok(!text.includes(secret), 'the key is absent from the whole run output');
    assert.equal(out.auditHeader, 'caller=Bearer ***');
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
});
