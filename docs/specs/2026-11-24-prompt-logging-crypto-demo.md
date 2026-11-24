# Prompt logging: sealed records demo spec

**Status:** built; independent review findings fixed (AAD coverage, server gating, duplicate key ids, tamper once, note scoping, mode hint)   **Owner:** Curtis (decides scope and merge)   **Tier:** Tester (unchanged), one new tab in the existing lab

## Goal
Show what Privilege's **Prompt Logging** setting does, with real cryptography: a prompt or tool call is **sealed to a public key you hold**, the readable details around it stay in the clear, and **only the private key, in the browser, opens it**. A SIEM gets the metadata and the request id, never the content (this is what the Privilege console page itself says; the lab states it as the console's claim and does not verify it, see Out of scope).

## What the console page says (source: the Prompt Logging page, 24 Nov 2026)
Record prompts and tool calls; record responses as well; surfaces (LLM traffic, MCP tool calls, agent-to-agent messages, coding agents); size limit (0 = default 65,536 bytes, maximum 131,072; longer content is cut and the record marked truncated); an X25519 public JWK ("sealed with HPKE (RFC 9180), one encapsulation per record") and a key id (recorded on every row so records written before a rotation still open with the retired key; taken from the JWK's own `kid` when blank). Responses on the LLM and MCP surfaces are only recorded where AI Guard runs.

## Design
- New tab **Prompt logging** in `privilege-logging-LAB` (web only; no server route, nothing sent anywhere; the private key never leaves the page).
- Library: `@hpke/core` + `@hpke/dhkem-x25519` (MIT, pinned, vetted), suite **DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM**, base mode, single-shot seal (one encapsulation per record). Privilege's exact record format and suite are not published here, so the page says it shows the mechanism, not Privilege's wire format.
- Panels: (1) key pair: generate, show the public JWK to paste into Privilege and the key id, show the private JWK once with a "save it now, Privilege has no copy" notice; or paste an existing public JWK. (2) Seal: pick a surface and a sample prompt (or type one), size limit, responses on/off; the record shows clear metadata (record id, request id, surface, user, agent key, decision, key id, size, truncated) and the sealed content (enc + ciphertext, base64url). (3) What a SIEM receives: the same record minus content, side by side. (4) Open: paste a private JWK; wrong key, tampered record and retired-key rotation each show their real failure.
- Layout follows the lab's existing tabs and tokens (banner first, cards, chips, theme tokens, usable at 375 px).

## Acceptance criteria (each a runnable check)
1. `generateKeyPair()` returns a public JWK `{kty:"OKP", crv:"X25519", x, kid}` with a 32-byte `x` and a private JWK with `d`; `kid` defaults to the RFC 7638 thumbprint; a supplied `kid` is used as given.
2. Seal then open with the matching private JWK returns the original text (including multi-byte characters); two seals of the same text differ (fresh encapsulation).
3. Opening with a different private key fails with a named error, not garbage: `KID_MISMATCH` when the key ids differ (checked before decrypting), `OPEN_FAILED` when a wrong key claims the same id (AES-GCM cannot say whether the key or the record is at fault).
4. A record with one flipped ciphertext or `enc` byte, or any changed readable field (every field in `AAD_FIELDS`: id, request id, surface, kind, user, agent key, decision, time, size, truncation flags, suite) fails to open (`OPEN_FAILED`); a changed key id is `KID_MISMATCH`; a cut record cannot be made to look complete.
5. Size limit: content over `maxBytes` is cut at a UTF-8 boundary, `truncated: true`, and `truncatedBytes` says how much; `0` uses 65,536; values above 131,072 are refused; negative or non-integer refused.
6. Rotation: records sealed under key A and key B coexist; each opens only with its own key; the list says which `kid` each needs.
7. The SIEM view contains exactly the metadata fields and the request id, and **no** content, ciphertext or enc (asserted by field list, not by eye).
8. No network call during key generation, sealing or opening (fetch / XHR / sendBeacon spied: 0 calls); the private JWK is not written to storage, URL or console.
9. The tab works with the lab server down; a key id used twice in the tab is refused; "Flip one byte" works once; each Copied note shows only beside its own control; the "Real is unavailable" hint is not shown above this tab's banner.
10. UI: banner first; at 375 px no horizontal scroll; dark and light; keyboard reachable; verified in a real browser with a screenshot.
11. Existing lab tests still pass.

## Unhappy paths (each needs a check)
- Pasted public key is not JSON, wrong `kty`/`crv`, `x` not 32 bytes, or contains `d` (a private key pasted into the public box is refused with a clear message).
- Pasted private key is missing `d`, or `d` and `x` do not match.
- Empty prompt; very long prompt (cut, not crash); lone surrogate / odd Unicode in the text.
- Browser without X25519 support: the library's own JS implementation is used; if `crypto.subtle` is missing entirely, the page says so and disables seal/open.
- Double click on Seal / Open (idempotent, no duplicate records).

## Out of scope
Opening **real** Privilege records (no endpoint or record format is available to the lab); reading or writing the tenant's `tenantprofiles` PromptLog settings; the live check of what the SIEM actually receives (a separate test, needs prompt logging switched on with a key; tracked in the Cribl report); the "unencrypted prompt logs to SIEM" item from the 11/20 release (not on the Prompt Logging page).

## Protected / must not break
Lab rules: loopback bind, one port, mode toggle semantics, no outbound calls in Mock, write-only secrets, pinned vendored files (`*.sha256` pins), existing tabs and tests, theme tokens only (no purple). No AI attribution.

## Verification plan
`vitest` (new lib and component tests) and the lab's full `npm test` on the Air (`air-test`); `npm audit` on the new packages; real-browser run (Playwright or the browser tools) with screenshots at desktop and 375 px, dark and light; `/code-review` on the PR; PR to `curtismu7/privilege-logging-LAB`, then a pin PR in AI-DEMO-Standalone. Merge only after Curtis says go.
