// The lab as a workload-token issuer for the "Valid workload token" case. The owner registers this issuer once as a Federated
// Identity (API kind NonHumanIdentity) with the public JWKS pasted in (the gateway cannot reach this loopback lab, so no JWKS URI);
// after that the lab mints a fresh short-lived ES256 JWT on every run and nothing is pasted.
// The signing key is derived from PRIV_LOG_FED_SIGNING_SEED (64 hex characters, write-only like the agent key): the same seed always
// gives the same key, so the pasted JWKS keeps working across restarts and in Docker (read-only filesystem, nowhere to store a key).
// EC keys come from createECDH + createPrivateKey, never generateKeyPairSync('ec') (rulebook: SIGABRT on some Node builds).
import { createECDH, createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';

export const MINTED_CASE = 'fed-valid-token';
export const FED_ISSUER = 'https://privilege-logging-lab.invalid/workload';
export const FED_SUBJECT = 'privilege-logging-lab';
export const FED_TOKEN_LIFE_SEC = 300;
export const SEED = /^[0-9a-f]{64}$/i;

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// The signer for a seed, or throws when the seed is not 64 hex characters or is not a valid P-256 private key.
export function signerFrom(seedHex) {
  if (!SEED.test(String(seedHex))) throw new Error('PRIV_LOG_FED_SIGNING_SEED must be 64 hex characters');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(seedHex, 'hex')); // throws on 0 or a value above the curve order
  const pub = ecdh.getPublicKey(); // 0x04 || x || y
  const x = pub.subarray(1, 33).toString('base64url'); const y = pub.subarray(33).toString('base64url');
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x, y, d: Buffer.from(seedHex, 'hex').toString('base64url') }, format: 'jwk' });
  // RFC 7638 thumbprint as the key id: required members in lexicographic order, no spaces.
  const kid = createHash('sha256').update(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`).digest('base64url');
  const jwks = { keys: [{ kty: 'EC', crv: 'P-256', x, y, kid, use: 'sig', alg: 'ES256' }] };
  return {
    kid, jwks,
    mint(audience, { now = Date.now, rand = randomBytes } = {}) {
      const t = Math.floor(now() / 1000);
      const head = b64u({ alg: 'ES256', typ: 'JWT', kid });
      const body = b64u({ iss: FED_ISSUER, sub: FED_SUBJECT, aud: audience, iat: t, nbf: t, exp: t + FED_TOKEN_LIFE_SEC, jti: rand(8).toString('hex') });
      const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      return `${head}.${body}.${sig}`;
    },
  };
}

export const newSeed = (rand = randomBytes) => rand(32).toString('hex');
