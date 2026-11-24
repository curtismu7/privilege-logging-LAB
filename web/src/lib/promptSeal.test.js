// Real cryptography, no mocks: every check runs HPKE through @hpke/core. Spec: docs/specs/2026-11-24-prompt-logging-crypto-demo.md
import { createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  generateKeyPair, AAD_FIELDS, parsePublicJwk, parsePrivateJwk, sealRecord, openRecord, siemView, SIEM_FIELDS, truncateUtf8, normalizeMaxBytes,
  fromB64u, toB64u, jwkThumbprint, DEFAULT_MAX_BYTES, MAX_MAX_BYTES, PromptSealError, SUITE,
} from "./promptSeal";

const pub = async (kp) => parsePublicJwk(kp.publicJwk);
const priv = async (kp) => parsePrivateJwk(kp.privateJwk);
const meta = { surface: "llm", kind: "prompt", user: "demo-user-1", agentKey: "lab-bank-key", decision: "allow", requestId: "req-test-1" };
const failsWith = async (p, code) => { const e = await p.then(() => null, (x) => x); expect(e, `expected ${code}`).toBeInstanceOf(PromptSealError); expect(e.code).toBe(code); return e; };

afterEach(() => vi.restoreAllMocks());

describe("1. key pair", () => {
  it("returns OKP/X25519 JWKs with a 32-byte x and d, and the same x in both", async () => {
    const kp = await generateKeyPair();
    expect(kp.publicJwk).toMatchObject({ kty: "OKP", crv: "X25519" });
    expect(fromB64u(kp.publicJwk.x)).toHaveLength(32);
    expect(fromB64u(kp.privateJwk.d)).toHaveLength(32);
    expect(kp.privateJwk.x).toBe(kp.publicJwk.x);
    expect("d" in kp.publicJwk).toBe(false);
  });
  it("defaults kid to the RFC 7638 thumbprint (checked against an independent SHA-256) and uses a given kid as is", async () => {
    const kp = await generateKeyPair();
    const expected = createHash("sha256").update(`{"crv":"X25519","kty":"OKP","x":"${kp.publicJwk.x}"}`).digest("base64url");
    expect(kp.kid).toBe(expected);
    expect(await jwkThumbprint(kp.publicJwk.x)).toBe(expected);
    expect((await generateKeyPair({ kid: "tenant-2026-11" })).kid).toBe("tenant-2026-11");
  });
  it("two generated pairs differ", async () => {
    expect((await generateKeyPair()).publicJwk.x).not.toBe((await generateKeyPair()).publicJwk.x);
  });
  it("refuses a bad kid", async () => {
    await failsWith(generateKeyPair({ kid: "has space" }), "BAD_KID");
    await failsWith(generateKeyPair({ kid: "x".repeat(129) }), "BAD_KID");
  });
});

describe("2. seal and open", () => {
  it("round-trips text, including multi-byte characters and emoji", async () => {
    const kp = await generateKeyPair();
    const text = "Pay café 日本語 😀 — 5,000 EUR to account DE00 0000 0000 0000 0000 00 (sample)";
    const rec = await sealRecord({ publicKey: await pub(kp), content: text, meta });
    expect(rec.kid).toBe(kp.kid);
    expect(rec.suite).toBe(SUITE.id);
    const out = await openRecord({ privateKey: await priv(kp), record: rec });
    expect(out.text).toBe(text);
    expect(out.truncated).toBe(false);
  });
  it("the stored record does not contain the plaintext", async () => {
    const kp = await generateKeyPair();
    const rec = await sealRecord({ publicKey: await pub(kp), content: "super secret sample prompt", meta });
    expect(JSON.stringify(rec)).not.toContain("super secret");
  });
  it("two seals of the same text differ (fresh encapsulation each time) and both open", async () => {
    const kp = await generateKeyPair();
    const a = await sealRecord({ publicKey: await pub(kp), content: "same text", meta });
    const b = await sealRecord({ publicKey: await pub(kp), content: "same text", meta });
    expect(a.enc).not.toBe(b.enc);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect((await openRecord({ privateKey: await priv(kp), record: a })).text).toBe("same text");
    expect((await openRecord({ privateKey: await priv(kp), record: b })).text).toBe("same text");
  });
  it("a lone surrogate comes back as the replacement character (UTF-8 cannot carry it)", async () => {
    const kp = await generateKeyPair();
    const rec = await sealRecord({ publicKey: await pub(kp), content: "a\ud800b", meta });
    expect((await openRecord({ privateKey: await priv(kp), record: rec })).text).toBe("a�b");
  });
});

describe("3. wrong key", () => {
  it("a key with a different id is named before any decrypting", async () => {
    const a = await generateKeyPair(); const b = await generateKeyPair();
    const rec = await sealRecord({ publicKey: await pub(a), content: "for A", meta });
    const e = await failsWith(openRecord({ privateKey: await priv(b), record: rec }), "KID_MISMATCH");
    expect(e.message).toContain(a.kid);
  });
  it("a wrong key that claims the same id still fails to open, with no plaintext", async () => {
    const a = await generateKeyPair({ kid: "shared-id" }); const b = await generateKeyPair({ kid: "shared-id" });
    const rec = await sealRecord({ publicKey: await pub(a), content: "for A only", meta });
    const e = await failsWith(openRecord({ privateKey: await priv(b), record: rec }), "OPEN_FAILED");
    expect(e.message).not.toContain("for A only");
  });
});

describe("4. tampering", () => {
  const sealed = async () => { const kp = await generateKeyPair(); return { kp, rec: await sealRecord({ publicKey: await pub(kp), content: "do not change me", meta }) }; };
  it("a flipped ciphertext byte fails", async () => {
    const { kp, rec } = await sealed();
    const raw = fromB64u(rec.ciphertext); raw[0] ^= 1;
    await failsWith(openRecord({ privateKey: await priv(kp), record: { ...rec, ciphertext: toB64u(raw) } }), "OPEN_FAILED");
  });
  it("a flipped enc byte fails", async () => {
    const { kp, rec } = await sealed();
    const raw = fromB64u(rec.enc); raw[5] ^= 1;
    await failsWith(openRecord({ privateKey: await priv(kp), record: { ...rec, enc: toB64u(raw) } }), "OPEN_FAILED");
  });
  const mutate = (v) => (typeof v === "boolean" ? !v : typeof v === "number" ? v + 1 : `${v}-changed`);
  it.each(AAD_FIELDS.filter((f) => f !== "kid"))("changing the readable %s (bound as AAD) fails to open", async (field) => {
    const kp = await generateKeyPair();
    const rec = await sealRecord({ publicKey: await pub(kp), content: "0123456789", meta, maxBytes: 4 }); // a truncated record, so every field has a value
    expect(rec[field], `record has ${field}`).not.toBeUndefined();
    await failsWith(openRecord({ privateKey: await priv(kp), record: { ...rec, [field]: mutate(rec[field]) } }), "OPEN_FAILED");
  });
  it("the kid is checked before decrypting, and a changed kid is named rather than failing silently", async () => {
    const { kp, rec } = await sealed();
    await failsWith(openRecord({ privateKey: await priv(kp), record: { ...rec, kid: `${rec.kid}-changed` } }), "KID_MISMATCH");
  });
  it("a cut record cannot be made to look complete: clearing truncated fails to open", async () => {
    const kp = await generateKeyPair();
    const rec = await sealRecord({ publicKey: await pub(kp), content: "0123456789", meta, maxBytes: 4 });
    await failsWith(openRecord({ privateKey: await priv(kp), record: { ...rec, truncated: false, truncatedBytes: 0 } }), "OPEN_FAILED");
  });
  it("fields that are not part of the stored record (a UI flag) do not affect opening", async () => {
    const { kp, rec } = await sealed();
    expect((await openRecord({ privateKey: await priv(kp), record: { ...rec, tampered: true } })).text).toBe("do not change me");
  });
  it("a record that is not a record is refused", async () => {
    const kp = await generateKeyPair();
    await failsWith(openRecord({ privateKey: await priv(kp), record: { hello: 1 } }), "BAD_RECORD");
    await failsWith(openRecord({ privateKey: await priv(kp), record: null }), "BAD_RECORD");
  });
});

describe("5. size limit", () => {
  it("normalizes: 0 or unset is the default; whole numbers up to the maximum", () => {
    expect(normalizeMaxBytes(0)).toBe(DEFAULT_MAX_BYTES);
    expect(normalizeMaxBytes(undefined)).toBe(DEFAULT_MAX_BYTES);
    expect(normalizeMaxBytes("")).toBe(DEFAULT_MAX_BYTES);
    expect(normalizeMaxBytes(1)).toBe(1);
    expect(normalizeMaxBytes(MAX_MAX_BYTES)).toBe(131072);
    for (const bad of [131073, -1, 1.5, "abc", NaN]) expect(() => normalizeMaxBytes(bad), String(bad)).toThrow(PromptSealError);
  });
  it("cuts at a UTF-8 boundary and reports how much was cut", () => {
    const r = truncateUtf8("ab😀cd", 4); // a b + 4-byte emoji = 6 bytes before c; limit 4 would split the emoji
    expect(new TextDecoder().decode(r.bytes)).toBe("ab");
    expect(r).toMatchObject({ truncated: true, originalBytes: 8, truncatedBytes: 6 });
    expect(truncateUtf8("abc", 3)).toMatchObject({ truncated: false, truncatedBytes: 0 });
  });
  it("a sealed record carries truncated + truncatedBytes and opens to the cut text", async () => {
    const kp = await generateKeyPair();
    const rec = await sealRecord({ publicKey: await pub(kp), content: "0123456789", meta, maxBytes: 4 });
    expect(rec).toMatchObject({ bytes: 4, truncated: true, truncatedBytes: 6 });
    const out = await openRecord({ privateKey: await priv(kp), record: rec });
    expect(out).toMatchObject({ text: "0123", truncated: true, truncatedBytes: 6 });
  });
  it("a very long prompt is cut at the default, not a crash", async () => {
    const kp = await generateKeyPair();
    const rec = await sealRecord({ publicKey: await pub(kp), content: "x".repeat(200000), meta });
    expect(rec).toMatchObject({ bytes: DEFAULT_MAX_BYTES, truncated: true, truncatedBytes: 200000 - DEFAULT_MAX_BYTES });
    expect((await openRecord({ privateKey: await priv(kp), record: rec })).text).toHaveLength(DEFAULT_MAX_BYTES);
  });
  it("refuses a limit above the maximum", async () => {
    const kp = await generateKeyPair();
    await failsWith(sealRecord({ publicKey: await pub(kp), content: "x", meta, maxBytes: 131073 }), "BAD_SIZE");
  });
  it("refuses an empty prompt", async () => {
    const kp = await generateKeyPair();
    await failsWith(sealRecord({ publicKey: await pub(kp), content: "", meta }), "EMPTY");
  });
});

describe("6. key rotation", () => {
  it("records under key A and key B coexist; each opens only with its own key", async () => {
    const a = await generateKeyPair({ kid: "key-a" }); const b = await generateKeyPair({ kid: "key-b" });
    const ra = await sealRecord({ publicKey: await pub(a), content: "old record", meta });
    const rb = await sealRecord({ publicKey: await pub(b), content: "new record", meta });
    expect([ra.kid, rb.kid]).toEqual(["key-a", "key-b"]);
    expect((await openRecord({ privateKey: await priv(a), record: ra })).text).toBe("old record");
    expect((await openRecord({ privateKey: await priv(b), record: rb })).text).toBe("new record");
    await failsWith(openRecord({ privateKey: await priv(b), record: ra }), "KID_MISMATCH");
    await failsWith(openRecord({ privateKey: await priv(a), record: rb }), "KID_MISMATCH");
  });
});

describe("7. what a SIEM receives", () => {
  it("is exactly the allowlisted metadata plus the request id: no content, enc or ciphertext", async () => {
    const kp = await generateKeyPair();
    const rec = await sealRecord({ publicKey: await pub(kp), content: "TOP-SECRET-PROMPT-TEXT", meta });
    const siem = siemView(rec);
    expect(Object.keys(siem).sort()).toEqual([...SIEM_FIELDS].sort());
    expect(siem.requestId).toBe("req-test-1");
    for (const forbidden of ["enc", "ciphertext", "content", "text"]) expect(forbidden in siem).toBe(false);
    expect(JSON.stringify(siem)).not.toContain("TOP-SECRET");
    expect(JSON.stringify(siem)).not.toContain(rec.ciphertext);
  });
  it("a field added to a record later is NOT sent on until the allowlist names it", async () => {
    const kp = await generateKeyPair();
    const rec = { ...(await sealRecord({ publicKey: await pub(kp), content: "x", meta })), newField: "hello" };
    expect("newField" in siemView(rec)).toBe(false);
  });
});

describe("key parsing (unhappy paths)", () => {
  it("public: not JSON, wrong type, wrong curve, short x, and a private key pasted into the public box", async () => {
    const kp = await generateKeyPair();
    await failsWith(parsePublicJwk("not json"), "BAD_PUBLIC_KEY");
    await failsWith(parsePublicJwk(""), "BAD_PUBLIC_KEY");
    await failsWith(parsePublicJwk("[1,2]"), "BAD_PUBLIC_KEY");
    await failsWith(parsePublicJwk({ ...kp.publicJwk, kty: "EC" }), "BAD_PUBLIC_KEY");
    await failsWith(parsePublicJwk({ ...kp.publicJwk, crv: "P-256" }), "BAD_PUBLIC_KEY");
    await failsWith(parsePublicJwk({ ...kp.publicJwk, x: "AAAA" }), "BAD_PUBLIC_KEY");
    await failsWith(parsePublicJwk(kp.privateJwk), "PRIVATE_IN_PUBLIC");
  });
  it("public without a kid gets the thumbprint", async () => {
    const kp = await generateKeyPair();
    const { kid, jwk } = await parsePublicJwk({ kty: "OKP", crv: "X25519", x: kp.publicJwk.x });
    expect(kid).toBe(kp.kid); expect(jwk.kid).toBe(kp.kid);
  });
  it("private: missing d (a public key), short d, and a d that does not belong to x", async () => {
    const a = await generateKeyPair(); const b = await generateKeyPair();
    await failsWith(parsePrivateJwk(a.publicJwk), "BAD_PRIVATE_KEY");
    await failsWith(parsePrivateJwk({ ...a.privateJwk, d: "AAAA" }), "BAD_PRIVATE_KEY");
    await failsWith(parsePrivateJwk({ ...a.privateJwk, d: b.privateJwk.d }), "KEY_MISMATCH");
    await failsWith(parsePrivateJwk("nope"), "BAD_PRIVATE_KEY");
  });
  it("base64url helpers refuse junk", () => {
    expect(() => fromB64u("a b")).toThrow(PromptSealError);
    expect(() => fromB64u("a")).toThrow(PromptSealError);
    expect(toB64u(fromB64u("AQID"))).toBe("AQID");
  });
});

describe("8. nothing leaves the page", () => {
  it("no fetch, XHR or beacon during key generation, sealing and opening", async () => {
    const f = vi.fn(); const x = vi.fn(); const bcn = vi.fn();
    vi.stubGlobal("fetch", f); vi.stubGlobal("XMLHttpRequest", x); vi.stubGlobal("navigator", { ...globalThis.navigator, sendBeacon: bcn });
    const kp = await generateKeyPair();
    const rec = await sealRecord({ publicKey: await pub(kp), content: "private", meta });
    await openRecord({ privateKey: await priv(kp), record: rec });
    expect(f).not.toHaveBeenCalled(); expect(x).not.toHaveBeenCalled(); expect(bcn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("never logs a key or the plaintext to the console", async () => {
    const spies = ["log", "info", "warn", "error", "debug"].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const kp = await generateKeyPair();
    const rec = await sealRecord({ publicKey: await pub(kp), content: "plain text", meta });
    await openRecord({ privateKey: await priv(kp), record: rec });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
