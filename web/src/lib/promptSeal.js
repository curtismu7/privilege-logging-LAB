// Prompt logging, sealed records: the cryptography behind the "Prompt logging" tab.
//
// What this is: HPKE (RFC 9180) base mode with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-128-GCM, one encapsulation per
// record (single-shot seal), through the vetted `@hpke/core` + `@hpke/dhkem-x25519` libraries. Nothing here is hand-written crypto.
// The sample records the tab seals use this lab's own layout (above). Real Privilege records use a different one, which
// openPrivilegeRecord() below reads: it follows the derivation in the Privilege console's own browser code and was proven on real
// records from a live tenant (2026-11-24). It is a reader only; the lab never writes that layout.
//
// Everything runs in the browser tab: no network call, the private key is never stored.

import { CipherSuite, Aes128Gcm, Aes256Gcm, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";

export const SUITE = Object.freeze({
  id: "HPKE-Base-X25519-HKDF-SHA256-AES128GCM",
  kem: "DHKEM(X25519, HKDF-SHA256)",
  kdf: "HKDF-SHA256",
  aead: "AES-128-GCM",
  mode: "base (RFC 9180)",
});
export const DEFAULT_MAX_BYTES = 65536;
export const MAX_MAX_BYTES = 131072;
export const MAX_KID_LENGTH = 128;

export class PromptSealError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PromptSealError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new PromptSealError(code, message); };
const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });

export const cryptoAvailable = () => typeof globalThis.crypto?.subtle?.digest === "function" && typeof globalThis.crypto?.getRandomValues === "function";
const newSuite = () => new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });

export function toB64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(str, what = "value") {
  if (typeof str !== "string" || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) fail("BAD_ENCODING", `${what} is not base64url.`);
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// RFC 7638 thumbprint of an OKP key: SHA-256 over the required members in lexicographic order.
export async function jwkThumbprint(x) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", te.encode(`{"crv":"X25519","kty":"OKP","x":"${x}"}`));
  return toB64u(digest);
}

function checkKid(kid) {
  if (typeof kid !== "string" || kid.length === 0 || kid.length > MAX_KID_LENGTH || /[^\x21-\x7e]/.test(kid)) {
    fail("BAD_KID", `The key id must be 1 to ${MAX_KID_LENGTH} printable characters with no spaces.`);
  }
  return kid;
}

function readJson(input, code, what) {
  if (typeof input === "object" && input !== null) return input;
  if (typeof input !== "string" || !input.trim()) fail(code, `Paste ${what}.`);
  try {
    const v = JSON.parse(input);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v;
  } catch { /* fall through */ }
  return fail(code, `That is not a JSON object. Paste ${what}.`);
}

function checkOkp(jwk, code) {
  if (jwk.kty !== "OKP" || jwk.crv !== "X25519") fail(code, `The key must be kty "OKP" and crv "X25519" (got ${JSON.stringify(jwk.kty)} / ${JSON.stringify(jwk.crv)}).`);
  if (typeof jwk.x !== "string" || fromB64u(jwk.x, "x").length !== 32) fail(code, "x must be a 32-byte X25519 public value in base64url.");
}

/** A public JWK, as typed or pasted. Refuses a private key pasted into the public box. */
export async function parsePublicJwk(input) {
  const jwk = readJson(input, "BAD_PUBLIC_KEY", "the public JWK");
  if ("d" in jwk) fail("PRIVATE_IN_PUBLIC", "That JWK contains a private part (d). Paste only the public JWK (no d) into Privilege. Keep the private one to yourself.");
  checkOkp(jwk, "BAD_PUBLIC_KEY");
  const kid = jwk.kid === undefined || jwk.kid === "" ? await jwkThumbprint(jwk.x) : checkKid(jwk.kid);
  return { kid, x: jwk.x, jwk: { kty: "OKP", crv: "X25519", kid, x: jwk.x } };
}

async function toPublicCryptoKey(suite, x) { return suite.kem.deserializePublicKey(fromB64u(x, "x")); }

/** A private JWK. Needs d and x; checks that they belong together by a probe seal/open, so a mixed-up pair is caught here. */
export async function parsePrivateJwk(input) {
  const jwk = readJson(input, "BAD_PRIVATE_KEY", "the private JWK");
  if (typeof jwk.d !== "string") fail("BAD_PRIVATE_KEY", "A private JWK needs d. This looks like a public key.");
  checkOkp(jwk, "BAD_PRIVATE_KEY");
  const d = fromB64u(jwk.d, "d");
  if (d.length !== 32) fail("BAD_PRIVATE_KEY", "d must be a 32-byte X25519 private value in base64url.");
  const kid = jwk.kid === undefined || jwk.kid === "" ? await jwkThumbprint(jwk.x) : checkKid(jwk.kid);
  const suite = newSuite();
  let sk; let pk;
  try {
    sk = await suite.kem.deserializePrivateKey(d);
    pk = await toPublicCryptoKey(suite, jwk.x);
    const probe = te.encode("pair-check");
    const sealed = await suite.seal({ recipientPublicKey: pk }, probe);
    const back = new Uint8Array(await suite.open({ recipientKey: sk, enc: sealed.enc }, sealed.ct));
    if (back.length !== probe.length || back.some((v, i) => v !== probe[i])) throw new Error("mismatch");
  } catch {
    fail("KEY_MISMATCH", "d and x are not a matching pair. Use the private JWK exactly as it was generated.");
  }
  return { kid, x: jwk.x, d: jwk.d, jwk: { kty: "OKP", crv: "X25519", kid, x: jwk.x, d: jwk.d } };
}

/** A new X25519 key pair as JWKs. `kid` defaults to the RFC 7638 thumbprint, as Privilege does when the key id is left blank. */
export async function generateKeyPair({ kid } = {}) {
  if (!cryptoAvailable()) fail("NO_CRYPTO", "This browser has no Web Crypto (crypto.subtle). Open the page over https or on localhost.");
  const suite = newSuite();
  const kp = await suite.kem.generateKeyPair();
  const x = toB64u(await suite.kem.serializePublicKey(kp.publicKey));
  const d = toB64u(await suite.kem.serializePrivateKey(kp.privateKey));
  const id = kid === undefined || kid === "" ? await jwkThumbprint(x) : checkKid(kid);
  return {
    kid: id,
    publicJwk: { kty: "OKP", crv: "X25519", kid: id, x },
    privateJwk: { kty: "OKP", crv: "X25519", kid: id, x, d },
  };
}

/** 0 or unset uses the default; otherwise a whole number from 1 to 131,072. */
export function normalizeMaxBytes(n) {
  if (n === undefined || n === null || n === "" || Number(n) === 0) return DEFAULT_MAX_BYTES;
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0) fail("BAD_SIZE", "The size limit must be a whole number of bytes, 0 or more.");
  if (v > MAX_MAX_BYTES) fail("BAD_SIZE", `The size limit cannot be above ${MAX_MAX_BYTES.toLocaleString("en-US")} bytes.`);
  return v;
}

/** Cut at a UTF-8 character boundary so a multi-byte character is never split. */
export function truncateUtf8(text, maxBytes) {
  const bytes = te.encode(text);
  if (bytes.length <= maxBytes) return { bytes, truncated: false, originalBytes: bytes.length, truncatedBytes: 0 };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { bytes: bytes.subarray(0, end), truncated: true, originalBytes: bytes.length, truncatedBytes: bytes.length - end };
}

const hex = (n) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
// Every readable detail on the record is bound to the ciphertext as AAD, so changing any of them (who, which agent, the decision, the
// time, the size, the truncation flags, the suite) stops the record opening. Only enc and ciphertext themselves are not bound (they are the sealed part).
export const AAD_FIELDS = Object.freeze(["id", "requestId", "surface", "kind", "user", "agentKey", "decision", "createdAt", "kid", "bytes", "truncated", "truncatedBytes", "suite"]);
const aadFor = (r) => te.encode(JSON.stringify({ v: 1, ...Object.fromEntries(AAD_FIELDS.map((k) => [k, r[k]])) }));

/**
 * Seal one record to a public key. `publicKey` comes from parsePublicJwk. `meta` is the readable detail (surface, kind, user,
 * agentKey, decision, requestId). Returns the stored record: readable metadata plus `enc` and `ciphertext`.
 */
export async function sealRecord({ publicKey, content, meta = {}, maxBytes }) {
  if (!cryptoAvailable()) fail("NO_CRYPTO", "This browser has no Web Crypto (crypto.subtle).");
  if (typeof content !== "string" || content.length === 0) fail("EMPTY", "There is nothing to record: the prompt is empty.");
  if (!publicKey?.x || !publicKey?.kid) fail("BAD_PUBLIC_KEY", "Add a public key first.");
  const limit = normalizeMaxBytes(maxBytes);
  const cut = truncateUtf8(content, limit);
  const record = {
    v: 1,
    id: `rec-${hex(6)}`,
    requestId: meta.requestId || `req-${hex(6)}`,
    surface: meta.surface || "llm",
    kind: meta.kind || "prompt",
    user: meta.user || "",
    agentKey: meta.agentKey || "",
    decision: meta.decision || "",
    createdAt: new Date().toISOString(),
    kid: publicKey.kid,
    bytes: cut.bytes.length,
    truncated: cut.truncated,
    truncatedBytes: cut.truncatedBytes,
    suite: SUITE.id,
  };
  const suite = newSuite();
  const pk = await toPublicCryptoKey(suite, publicKey.x);
  const sealed = await suite.seal({ recipientPublicKey: pk }, cut.bytes, aadFor(record));
  record.enc = toB64u(sealed.enc);
  record.ciphertext = toB64u(sealed.ct);
  return record;
}

/** Open a record with a private key from parsePrivateJwk. A different key id is named before any decrypting; otherwise a failure means the key is wrong or the record was changed. */
export async function openRecord({ privateKey, record }) {
  if (!record || typeof record.enc !== "string" || typeof record.ciphertext !== "string" || !record.kid) fail("BAD_RECORD", "That is not a sealed record.");
  if (privateKey.kid !== record.kid) {
    fail("KID_MISMATCH", `This record was sealed to key id "${record.kid}". The key you gave is "${privateKey.kid}". Find the key with the matching id (a retired key still opens its old records).`);
  }
  const suite = newSuite();
  let plain;
  try {
    const sk = await suite.kem.deserializePrivateKey(fromB64u(privateKey.d, "d"));
    plain = await suite.open({ recipientKey: sk, enc: fromB64u(record.enc, "enc") }, fromB64u(record.ciphertext, "ciphertext"), aadFor(record));
  } catch {
    return fail("OPEN_FAILED", "The record did not open. Either this is not the right private key for it, or the record or its readable details were changed after it was sealed. AES-GCM cannot tell the two apart, and says nothing about which.");
  }
  let text;
  try { text = td.decode(new Uint8Array(plain)); } catch { fail("OPEN_FAILED", "The record opened but is not valid UTF-8 text."); }
  return { text, truncated: !!record.truncated, truncatedBytes: record.truncatedBytes || 0 };
}

// What a SIEM receives, by the console's own statement: the metadata and the request id, never the content.
// An allowlist: a new field on a record is NOT sent on until it is added here.
export const SIEM_FIELDS = Object.freeze(["requestId", "id", "surface", "kind", "user", "agentKey", "decision", "createdAt", "kid", "bytes", "truncated"]);
export function siemView(record) {
  return Object.fromEntries(SIEM_FIELDS.filter((k) => k in record).map((k) => [k, record[k]]));
}

// ---- Real Privilege prompt-log records (read only) -------------------------------------------------------------------------------
// The layout, as the Privilege console's own decryption code does it:
//   HPKE RFC 9180 base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM suite id, info "privilege/prompt-log/v1".
//   The record's `Enc` is the encapsulated key (base64). A 44-byte secret is exported with the context "<RequestID>|<Direction>":
//   the first 32 bytes are the AES-256-GCM key, the last 12 the nonce, and the same context string is the AAD.
//   `Content` (base64) is the ciphertext; its plaintext is JSON {"units":[{"role","text"}]}.
export const PRIVILEGE_ALG = "HPKE-X25519-SHA256-AES256GCM-EXPORT";
export const PRIVILEGE_INFO = "privilege/prompt-log/v1";

function fromB64(str, what) {
  if (typeof str !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(str) || str.length === 0) fail("BAD_RECORD", `${what} is missing or is not base64.`);
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

/** Finds the prompt-log fields in what was pasted: the bare record, a SIEM event ({Data:{...}}) or an Elasticsearch hit ({_source:{Data}}). */
export function readPrivilegeRecord(input) {
  const v = readJson(input, "BAD_RECORD", "the prompt-log record (the JSON of one SIEM event)");
  const d = v._source?.Data || v.Data || v;
  if (typeof d.Content !== "string" || typeof d.Enc !== "string") fail("BAD_RECORD", "That has no Content and Enc. Paste one prompt-log event from the SIEM (its Data object, or the whole event).");
  return { Content: d.Content, Enc: d.Enc, KeyID: d.KeyID || "", Alg: d.Alg || "", RequestID: d.RequestID || "", Direction: d.Direction || "" };
}

/** Open a real Privilege prompt-log record with a private key from parsePrivateJwk. Returns the readable units. */
export async function openPrivilegeRecord({ privateKey, record }) {
  if (!cryptoAvailable()) fail("NO_CRYPTO", "This browser has no Web Crypto (crypto.subtle).");
  const r = readPrivilegeRecord(record);
  if (r.Alg && r.Alg !== PRIVILEGE_ALG) fail("UNSUPPORTED_ALG", `This record says its format is "${r.Alg}". This reader handles "${PRIVILEGE_ALG}" only.`);
  if (r.KeyID && privateKey.kid !== r.KeyID) {
    fail("KID_MISMATCH", `This record was sealed to key id "${r.KeyID}". The key you gave is "${privateKey.kid}". Find the key with the matching id.`);
  }
  const aad = te.encode(`${r.RequestID}|${r.Direction}`);
  let plain;
  try {
    const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
    const sk = await suite.kem.deserializePrivateKey(fromB64u(privateKey.d, "d"));
    const ctx = await suite.createRecipientContext({ recipientKey: sk, enc: fromB64(r.Enc, "Enc"), info: te.encode(PRIVILEGE_INFO) });
    const ek = new Uint8Array(await ctx.export(aad, 44));
    const key = await globalThis.crypto.subtle.importKey("raw", ek.slice(0, 32), "AES-GCM", false, ["decrypt"]);
    plain = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: ek.slice(32), additionalData: aad, tagLength: 128 }, key, fromB64(r.Content, "Content"));
  } catch (e) {
    if (e instanceof PromptSealError) throw e;
    return fail("OPEN_FAILED", "The record did not open. Either this is not the right private key for it (the key id can match while the public key the gateway used is a different one), or the RequestID, Direction or content was changed.");
  }
  let parsed;
  try { parsed = JSON.parse(td.decode(new Uint8Array(plain))); } catch { fail("OPEN_FAILED", "The record opened but is not the expected JSON."); }
  const units = Array.isArray(parsed?.units) ? parsed.units : [];
  return { units, text: JSON.stringify(parsed, null, 2), direction: r.Direction, requestId: r.RequestID };
}
