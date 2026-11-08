import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { FED_ISSUER, FED_SUBJECT, FED_TOKEN_LIFE_SEC, signerFrom } from '../src/fedIssuer.js';
import { installNetguard } from '../src/netguard.js';
import { KEY, fakeGateway, get, k8sEnv, post, withServer } from './helpers.js';

// Obviously fake test seed and audience. Tests assert the seed never appears in an API answer.
const SEED = '6c61622d746573742d736565642d4e4f542d5245414c2d3030303030303031aa';
const AUD = 'priv-nhi-test-NOT-REAL';
const parts = (jwt) => jwt.split('.');
const claims = (jwt) => JSON.parse(Buffer.from(parts(jwt)[1], 'base64url').toString());
const header = (jwt) => JSON.parse(Buffer.from(parts(jwt)[0], 'base64url').toString());
const verifies = (jwt, jwks) => {
  const [h, b, s] = parts(jwt);
  const jwk = jwks.keys.find((k) => k.kid === header(jwt).kid);
  if (!jwk) return false;
  return verify('sha256', Buffer.from(`${h}.${b}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
};

let guard;
before(() => { guard = installNetguard(); });
after(() => guard.restore());
const json = async (r) => ({ status: r.status, body: await r.json() });

test('signerFrom: the same seed gives the same key; a token verifies against the published JWKS with the right claims and a 300 s life', () => {
  const a = signerFrom(SEED); const b = signerFrom(SEED);
  assert.deepEqual(a.jwks, b.jwks); assert.equal(a.kid, a.jwks.keys[0].kid);
  assert.ok(!JSON.stringify(a.jwks).includes('"d"'), 'the JWKS carries the public key only');
  const t = 1_800_000_000_000;
  const jwt = a.mint(AUD, { now: () => t });
  assert.deepEqual(header(jwt), { alg: 'ES256', typ: 'JWT', kid: a.kid });
  const c = claims(jwt);
  assert.equal(c.iss, FED_ISSUER); assert.equal(c.sub, FED_SUBJECT); assert.equal(c.aud, AUD);
  assert.equal(c.exp - c.iat, FED_TOKEN_LIFE_SEC); assert.equal(c.iat, t / 1000);
  assert.ok(verifies(jwt, a.jwks));
  const other = signerFrom('11'.repeat(32));
  assert.notEqual(other.kid, a.kid); assert.equal(verifies(jwt, { keys: [{ ...other.jwks.keys[0], kid: a.kid }] }), false, 'another seed does not verify');
  const [h, , s] = parts(jwt); const tampered = `${h}.${Buffer.from(JSON.stringify({ ...c, aud: 'x' })).toString('base64url')}.${s}`;
  assert.equal(verifies(tampered, a.jwks), false);
});

test('signerFrom refuses a seed that is not 64 hex characters or not a P-256 key', () => {
  assert.throws(() => signerFrom('abc'), /64 hex/);
  assert.throws(() => signerFrom('zz'.repeat(32)), /64 hex/);
  assert.throws(() => signerFrom('00'.repeat(32)));
  assert.throws(() => signerFrom('ff'.repeat(32)));
});

test('Real without the issuer settings: setup says what is missing, the case is not ready, and a run asks for a credential (nothing sent)', async () => {
  const gw = await fakeGateway();
  try {
    await withServer(async (url) => {
      await post(url, '/api/confirm', { gateway: new URL(gw.base).origin });
      const s = (await json(await get(url, '/api/fed-setup'))).body;
      assert.equal(s.ready, false); assert.equal(s.keyConfigured, false); assert.equal(s.jwks, null); assert.match(s.problem, /npm run fed-key/);
      assert.equal(s.issuer, FED_ISSUER); assert.equal(s.subject, FED_SUBJECT);
      const c = (await json(await get(url, '/api/cases'))).body.cases.find((x) => x.id === 'fed-valid-token');
      assert.equal(c.mintsToken, true); assert.equal(c.bearerConfigured, false);
      const r = await json(await post(url, '/api/run', { caseId: 'fed-valid-token' }));
      assert.equal(r.body.error, 'bearer_needed'); assert.match(r.body.detail, /PRIV_LOG_FED_SIGNING_SEED/);
      assert.deepEqual(gw.requests, []);
    }, { env: k8sEnv(gw, { base: 'http://127.0.0.1:9' }) });
  } finally { await gw.close(); }
});

test('Real with a seed but no audience: the JWKS is shown (so the identity can be created) but nothing is minted yet', async () => {
  const gw = await fakeGateway();
  try {
    await withServer(async (url) => {
      const s = (await json(await get(url, '/api/fed-setup'))).body;
      assert.equal(s.keyConfigured, true); assert.equal(s.ready, false); assert.match(s.problem, /PRIV_LOG_FED_AUDIENCE/);
      assert.deepEqual(s.jwks, signerFrom(SEED).jwks);
      assert.ok(!JSON.stringify(s).includes(SEED));
    }, { env: k8sEnv(gw, { base: 'http://127.0.0.1:9' }, { PRIV_LOG_FED_SIGNING_SEED: SEED }) });
  } finally { await gw.close(); }
});

test('Real with seed and audience: the case is ready with nothing pasted, each run sends a fresh token that verifies against the shown JWKS, the seed is never in an answer, and a pasted bearer overrides', async () => {
  const gw = await fakeGateway();
  try {
    await withServer(async (url) => {
      await post(url, '/api/confirm', { gateway: new URL(gw.base).origin });
      const s = (await json(await get(url, '/api/fed-setup'))).body;
      assert.equal(s.ready, true); assert.equal(s.problem, null); assert.equal(s.audience, AUD);
      const cases = (await json(await get(url, '/api/cases'))).body;
      assert.equal(cases.cases.find((x) => x.id === 'fed-valid-token').bearerConfigured, true);
      const r1 = await json(await post(url, '/api/run', { caseId: 'fed-valid-token' }));
      const r2 = await json(await post(url, '/api/run', { caseId: 'fed-valid-token' }));
      for (const x of [s, cases, r1, r2]) assert.ok(!JSON.stringify(x).includes(SEED), 'the seed appears in an answer');
      const sent = gw.requests.map((q) => q.headers.authorization).filter((a) => a && a !== `Bearer ${KEY}`);
      assert.ok(sent.length >= 2);
      const tokens = [...new Set(sent.map((a) => a.replace(/^Bearer /, '')))];
      assert.ok(tokens.length >= 2, 'a fresh token per run');
      for (const t of tokens) { assert.ok(verifies(t, s.jwks)); assert.equal(claims(t).aud, AUD); assert.equal(claims(t).iss, FED_ISSUER); }
      gw.requests.length = 0;
      await post(url, '/api/bearer', { caseId: 'fed-valid-token', bearer: 'owner-token-NOT-REAL' });
      await post(url, '/api/run', { caseId: 'fed-valid-token' });
      assert.equal(gw.requests[0].headers.authorization, 'Bearer owner-token-NOT-REAL');
    }, { env: k8sEnv(gw, { base: 'http://127.0.0.1:9' }, { PRIV_LOG_FED_SIGNING_SEED: SEED, PRIV_LOG_FED_AUDIENCE: AUD }) });
  } finally { await gw.close(); }
});
