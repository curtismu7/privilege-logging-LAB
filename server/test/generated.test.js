import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadCapture } from '../src/capture.js';
import { installNetguard } from '../src/netguard.js';
import { GENERATED, authFor, badJwt } from '../src/mcpRunner.js';
import { HAPPY_PATH } from '../src/lab.js';
import { KEY, fakeGateway, get, k8sEnv, post, withServer } from './helpers.js';

const capture = loadCapture();
let guard;
before(() => { guard = installNetguard(); });
after(() => guard.restore());
const json = async (r) => ({ status: r.status, body: await r.json() });
const decode = (jwt) => { const [h, p] = jwt.split('.'); return { head: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(p, 'base64url')) }; };
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);

test('badJwt: three parts, each token carries exactly its one defect, nothing real, and no two tokens are alike', () => {
  const t = Math.floor(NOW / 1000);
  const mk = (k) => badJwt(k, { now: () => NOW });
  for (const k of ['fed-wrong-audience', 'fed-wrong-issuer', 'fed-expired-token', 'fed-lifetime-too-long']) {
    const jwt = mk(k); assert.equal(jwt.split('.').length, 3); assert.equal(decode(jwt).head.alg, 'HS256');
    assert.match(JSON.stringify(decode(jwt).claims), /^[^]*$/); assert.ok(!/@|\.(com|net|org)\b/.test(JSON.stringify(decode(jwt).claims)), 'only .invalid hosts');
  }
  assert.match(decode(mk('fed-wrong-audience')).claims.aud, /wrong-audience\.example\.invalid/);
  assert.match(decode(mk('fed-wrong-issuer')).claims.iss, /wrong-issuer\.example\.invalid/);
  assert.ok(decode(mk('fed-expired-token')).claims.exp < t, 'expired');
  const long = decode(mk('fed-lifetime-too-long')).claims; assert.ok(long.exp - long.iat > 86400 * 7, 'lifetime too long');
  assert.notEqual(mk('fed-wrong-issuer'), mk('fed-wrong-issuer'), 'a fresh token every time');
  assert.throws(() => badJwt('fed-valid-token'), /no generated token/);
});

test('authFor: a generated case ignores any pasted bearer and the agent key; keys and the valid federated token still need the owner', () => {
  const c = (id) => ({ id, request: { auth: id.startsWith('fed-') || id.startsWith('keys-') ? 'bearer' : undefined }, needs: [] });
  const a = authFor(c('fed-wrong-audience'), KEY, 'pasted-should-be-ignored');
  assert.match(a, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/); assert.ok(!a.includes('pasted-should-be-ignored') && !a.includes(KEY));
  assert.match(authFor(c('unknown-key'), KEY), /^Bearer lab-unknown-[0-9a-f]{12}$/);
  assert.throws(() => authFor(c('keys-revoked'), KEY), (e) => e.code === 'bearer_needed' || /credential only you have/.test(e.message));
  assert.throws(() => authFor(c('fed-valid-token'), KEY), /credential only you have/);
});

test('the case list: every case is happy path or failure, the happy ones exist, and generated cases need nothing pasted', async () => {
  await withServer(async (url) => {
    const { cases } = (await json(await get(url, '/api/cases'))).body;
    assert.ok(cases.every((c) => c.path === 'happy' || c.path === 'failure'));
    const ids = new Set(cases.map((c) => c.id));
    for (const id of HAPPY_PATH) assert.ok(ids.has(id), `${id} is a case`);
    assert.deepEqual(cases.filter((c) => c.path === 'happy').map((c) => c.id).sort(), [...HAPPY_PATH].sort());
    assert.equal(cases.find((c) => c.id === 'mcp-tool-not-granted').path, 'failure');
    assert.equal(cases.find((c) => c.id === 'fed-valid-token').needsBearer, true);
    for (const id of Object.keys(GENERATED)) { const c = cases.find((x) => x.id === id); assert.equal(c.needsBearer, false, id); assert.equal(typeof c.generatedCredential, 'string', id); }
    for (const id of ['keys-revoked', 'keys-expired', 'keys-rate-limited', 'keys-no-mcp-scope']) assert.equal(cases.find((c) => c.id === id).needsBearer, true, `${id} needs a real key in that state`);
  });
  assert.ok(capture.cases.length + capture.realOnly.length >= 30);
});

test('Real: a generated-token case runs with nothing supplied and sends a JWT-shaped bearer, never the agent key', async () => {
  const gw = await fakeGateway({ key: KEY });
  try {
    await withServer(async (url) => {
      await post(url, '/api/confirm', { gateway: new URL(gw.base).origin });
      const r = await json(await post(url, '/api/run', { caseId: 'fed-wrong-audience' }));
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.ok(gw.requests.length >= 1);
      for (const q of gw.requests) { assert.match(q.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/); assert.ok(!q.headers.authorization.includes(KEY)); }
      assert.ok(!JSON.stringify(r.body).includes(KEY));
    }, { env: k8sEnv(gw, { base: 'http://127.0.0.1:9' }) });
  } finally { await gw.close(); }
});
