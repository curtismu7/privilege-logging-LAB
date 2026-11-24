import { useMemo, useRef, useState } from "react";
import { Chip } from "./Chips";
import { SAMPLES, SURFACES, sampleById } from "../lib/promptSamples";
import {
  generateKeyPair, parsePublicJwk, parsePrivateJwk, sealRecord, openRecord, siemView, fromB64u, toB64u,
  SUITE, DEFAULT_MAX_BYTES, MAX_MAX_BYTES, PromptSealError, cryptoAvailable,
} from "../lib/promptSeal";
import "./PromptLoggingPage.css";

// Prompt logging: sealed to a key you hold. The Privilege console's Prompt Logging page says every recorded prompt, tool call and result is
// encrypted to a public key (X25519 JWK, HPKE RFC 9180, one encapsulation per record), that Privilege cannot read the records, that only the
// private key opens them, in the browser, and that a SIEM receives the metadata and the request id, never the content.
// This page does the cryptography for real (the @hpke libraries) on SAMPLE prompts, entirely in this tab. It is the mechanism, not Privilege's
// wire format, and it does not read real Privilege records. The private key is held in this tab's memory only.

export const BANNER_PROMPTS = "REAL CRYPTOGRAPHY, SAMPLE PROMPTS. Keys are made in this browser tab and records are sealed and opened here. Nothing is sent to Privilege or anywhere else, and the private key is never stored.";

const SURFACE_LABEL = Object.fromEntries(SURFACES.map((s) => [s.id, s.label]));
const DECISION_KIND = { allow: "ok", block: "danger", sanitize: "warn", hitl: "warn" };
const pretty = (o) => JSON.stringify(o, null, 2);
const abbreviate = (record) => ({ ...record, enc: `${record.enc.slice(0, 12)}… (${fromB64u(record.enc).length} bytes)`, ciphertext: `${record.ciphertext.slice(0, 16)}… (${fromB64u(record.ciphertext).length} bytes)` });
const message = (e) => (e instanceof PromptSealError ? { code: e.code, text: e.message } : { code: "ERROR", text: "Something went wrong. Reload the page and try again." });

async function copy(text, setNote) {
  try { await navigator.clipboard.writeText(text); setNote("Copied."); } catch { setNote("Copy is blocked here: select the text and copy it yourself."); }
}

export default function PromptLoggingPage() {
  const ready = cryptoAvailable();
  const [keys, setKeys] = useState([]); // key pairs made in this tab, newest last (memory only)
  const [kidInput, setKidInput] = useState("");
  const [publicText, setPublicText] = useState("");
  const [fresh, setFresh] = useState(null); // the pair just made, so its private half can be shown once
  const [sampleId, setSampleId] = useState(SAMPLES[0].id);
  const [content, setContent] = useState(SAMPLES[0].text);
  const [maxBytes, setMaxBytes] = useState("");
  const [records, setRecords] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [privateText, setPrivateText] = useState("");
  const [opened, setOpened] = useState(null); // { text, truncated, truncatedBytes } for the selected record
  const [err, setErr] = useState({ keys: null, seal: null, open: null });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const busyRef = useRef(false); // a ref, not state: two clicks in the same instant must not both pass

  const selected = useMemo(() => records.find((r) => r.id === selectedId) || null, [records, selectedId]);
  const setE = (k, v) => setErr((e) => ({ ...e, [k]: v }));

  const run = async (name, fn) => { // one action at a time: a double click does nothing the second time
    if (busyRef.current) return;
    busyRef.current = true; setBusy(name);
    try { await fn(); } finally { busyRef.current = false; setBusy(""); }
  };

  const onGenerate = () => run("generate", async () => {
    setE("keys", null); setNote("");
    try {
      const kp = await generateKeyPair({ kid: kidInput.trim() });
      setKeys((k) => [...k, kp]); setFresh(kp); setPublicText(pretty(kp.publicJwk)); setKidInput("");
    } catch (e) { setE("keys", message(e)); }
  });

  const onSample = (id) => { const s = sampleById(id); setSampleId(id); setContent(s.text); setE("seal", null); };

  const onSeal = () => run("seal", async () => {
    setE("seal", null); setOpened(null); setE("open", null);
    try {
      const publicKey = await parsePublicJwk(publicText);
      const s = sampleById(sampleId);
      const record = await sealRecord({ publicKey, content, meta: { surface: s.surface, kind: s.kind, user: s.user, agentKey: s.agentKey, decision: s.decision }, maxBytes: maxBytes === "" ? undefined : Number(maxBytes) });
      setRecords((r) => [record, ...r]); setSelectedId(record.id);
    } catch (e) { setE("seal", message(e)); }
  });

  const onTamper = () => {
    if (!selected) return;
    const raw = fromB64u(selected.ciphertext); raw[0] ^= 1;
    setRecords((r) => r.map((x) => (x.id === selected.id ? { ...x, ciphertext: toB64u(raw), tampered: true } : x)));
    setOpened(null); setE("open", null);
  };

  const onUseMatching = () => {
    const kp = selected && keys.find((k) => k.kid === selected.kid);
    if (kp) { setPrivateText(pretty(kp.privateJwk)); setE("open", null); } else setE("open", { code: "NO_KEY", text: `No key with id "${selected?.kid}" was made in this tab. Paste its private JWK.` });
  };

  const onOpen = () => run("open", async () => {
    setE("open", null); setOpened(null);
    try {
      const privateKey = await parsePrivateJwk(privateText);
      setOpened(await openRecord({ privateKey, record: selected }));
    } catch (e) { setE("open", message(e)); }
  });

  const onForget = () => { setPrivateText(""); setOpened(null); setE("open", null); setFresh(null); setKeys([]); setNote("Keys forgotten. Records stay sealed."); };

  if (!ready) {
    return <div className="notice" role="alert" data-testid="pl-nocrypto">This browser has no Web Crypto (crypto.subtle), which is needed to seal and open records. Open the lab over https or on localhost.</div>;
  }

  return (
    <div className="pl" data-testid="pl-page">
      <p className="muted pl-lede">
        The Privilege Prompt Logging page seals every recorded prompt, tool call and result to a public key you hold. Privilege keeps the sealed records and cannot read them. A SIEM receives the details around the record and its request id, never the content.
        This tab does the sealing for real on sample prompts, so you can see each state. It shows the mechanism ({SUITE.kem}, {SUITE.kdf}, {SUITE.aead}, one encapsulation per record), not Privilege's exact wire format, and it does not read real Privilege records.
      </p>

      <section className="card pl-card" aria-labelledby="pl-h-key">
        <h2 id="pl-h-key" className="card__title">1. Your key pair</h2>
        <p className="muted">Privilege asks for the public half (an X25519 JWK) and a key id. Keep the private half yourself: it is the only way to read the records, and Privilege holds no copy.</p>
        <div className="pl-row">
          <label htmlFor="pl-kid">Key id (optional)</label>
          <input id="pl-kid" value={kidInput} onChange={(e) => setKidInput(e.target.value)} placeholder="blank = the key's own thumbprint" maxLength={128} data-testid="pl-kid" />
          <button type="button" className="primary" onClick={onGenerate} disabled={!!busy} data-testid="pl-generate">{keys.length ? "Rotate: make a new key pair" : "Generate key pair"}</button>
        </div>
        {err.keys && <p className="field-error" role="alert" data-testid="pl-err-keys"><strong>{err.keys.code}</strong> {err.keys.text}</p>}
        <label htmlFor="pl-public">Public key: records are sealed to this one. Paste your own, or use the one just made</label>
        <textarea id="pl-public" rows={6} value={publicText} onChange={(e) => setPublicText(e.target.value)} spellCheck={false} placeholder='{"kty":"OKP","crv":"X25519","kid":"...","x":"..."}' data-testid="pl-public" />
        <div className="pl-actions"><button type="button" onClick={() => copy(publicText, setNote)} disabled={!publicText}>Copy public key</button><span className="muted" role="status">{note}</span></div>
        {fresh && (
          <div className="pl-fresh" data-testid="pl-fresh">
            <p><Chip kind="warn">DEMO KEY</Chip> <strong>Private key.</strong> Save it now if you will use this key anywhere that matters (a password manager). This page keeps it in memory only and forgets it on reload; Privilege never sees it.</p>
            <pre className="pl-json mono" tabIndex={0} data-testid="pl-private-shown">{pretty(fresh.privateJwk)}</pre>
            <div className="pl-actions"><button type="button" onClick={() => copy(pretty(fresh.privateJwk), setNote)}>Copy private key</button><button type="button" onClick={() => setFresh(null)}>Hide it</button></div>
          </div>
        )}
        {keys.length > 1 && <p className="muted" data-testid="pl-rotation">{keys.length} keys made in this tab (ids: {keys.map((k) => k.kid.slice(0, 10)).join(", ")}). New records use whatever is in the public key box; older records still need their own key.</p>}
      </section>

      <section className="card pl-card" aria-labelledby="pl-h-rec">
        <h2 id="pl-h-rec" className="card__title">2. Record a prompt</h2>
        <div className="pl-row">
          <label htmlFor="pl-sample">Sample</label>
          <select id="pl-sample" value={sampleId} onChange={(e) => onSample(e.target.value)} data-testid="pl-sample">
            {SAMPLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <label htmlFor="pl-content">What was said (edit it: this is the content that gets sealed)</label>
        <textarea id="pl-content" rows={4} value={content} onChange={(e) => setContent(e.target.value)} data-testid="pl-content" />
        <div className="pl-row">
          <label htmlFor="pl-max">Size limit in bytes</label>
          <input id="pl-max" inputMode="numeric" value={maxBytes} onChange={(e) => setMaxBytes(e.target.value.replace(/[^0-9]/g, ""))} placeholder={`0 = default ${DEFAULT_MAX_BYTES.toLocaleString("en-US")}`} data-testid="pl-max" />
          <span className="muted">Longer content is cut at the limit and the record is marked truncated. The most is {MAX_MAX_BYTES.toLocaleString("en-US")}.</span>
        </div>
        <div className="pl-actions"><button type="button" className="primary" onClick={onSeal} disabled={!!busy} data-testid="pl-seal">Seal this record</button></div>
        {err.seal && <p className="field-error" role="alert" data-testid="pl-err-seal"><strong>{err.seal.code}</strong> {err.seal.text}</p>}

        {records.length > 0 && (
          <ul className="pl-list" aria-label="Sealed records" data-testid="pl-records">
            {records.map((r) => (
              <li key={r.id}>
                <button type="button" className="pl-rec" aria-pressed={r.id === selectedId} onClick={() => { setSelectedId(r.id); setOpened(null); setE("open", null); }} data-testid={`pl-rec-${r.id}`}>
                  <span className="mono">{r.id}</span>
                  <span>{SURFACE_LABEL[r.surface] || r.surface} · {r.kind.replace("_", " ")}</span>
                  <span className="muted">{r.user} · {r.agentKey}</span>
                  <span className="pl-chips"><Chip kind={DECISION_KIND[r.decision] || "info"}>{r.decision || "no decision"}</Chip><Chip kind="info">SEALED</Chip>{r.truncated && <Chip kind="warn">TRUNCATED</Chip>}{r.tampered && <Chip kind="danger">TAMPERED</Chip>}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && (
        <>
          <section className="card pl-card" aria-labelledby="pl-h-siem">
            <h2 id="pl-h-siem" className="card__title">3. Who sees what</h2>
            <p className="muted">Left: the prompt log, where Privilege holds the record (sealed). Right: what a SIEM receives, by the console's own statement (the metadata and the request id). This page shows that rule applied to the record; it does not measure a real SIEM.</p>
            <div className="pl-two">
              <div>
                <h3>Prompt log (sealed)</h3>
                <pre className="pl-json mono" tabIndex={0} data-testid="pl-sealed">{pretty(abbreviate(selected))}</pre>
              </div>
              <div>
                <h3>SIEM receives</h3>
                <pre className="pl-json mono" tabIndex={0} data-testid="pl-siem">{pretty(siemView(selected))}</pre>
                <p className="muted" data-testid="pl-siem-note">No content, no ciphertext, no encapsulated key. The request id ties it back to the record.</p>
              </div>
            </div>
          </section>

          <section className="card pl-card" aria-labelledby="pl-h-open">
            <h2 id="pl-h-open" className="card__title">4. Open it</h2>
            <p className="muted">This record needs the private key with id <span className="mono" data-testid="pl-needs-kid">{selected.kid}</span>. Opening happens here, in this tab.</p>
            <label htmlFor="pl-private">Private key (JWK)</label>
            <textarea id="pl-private" rows={8} value={privateText} onChange={(e) => setPrivateText(e.target.value)} spellCheck={false} autoComplete="off" placeholder='{"kty":"OKP","crv":"X25519","kid":"...","x":"...","d":"..."}' data-testid="pl-private" />
            <div className="pl-actions">
              <button type="button" className="primary" onClick={onOpen} disabled={!!busy || !privateText.trim()} data-testid="pl-open">Open this record</button>
              <button type="button" onClick={onUseMatching} data-testid="pl-use-key">Use the key made in this tab</button>
              <button type="button" onClick={onTamper} data-testid="pl-tamper">Flip one byte (simulate tampering)</button>
              <button type="button" onClick={onForget} data-testid="pl-forget">Close and forget the keys</button>
            </div>
            {err.open && <p className="field-error" role="alert" data-testid="pl-err-open"><strong data-testid="pl-err-code">{err.open.code}</strong> {err.open.text}</p>}
            {opened && (
              <div className="pl-opened" data-testid="pl-opened">
                <p><Chip kind="ok">OPENED IN THIS TAB</Chip> {opened.truncated && <Chip kind="warn">TRUNCATED: {opened.truncatedBytes} bytes were cut before sealing</Chip>} <span className="muted">Not stored anywhere.</span></p>
                <pre className="pl-json mono" tabIndex={0} data-testid="pl-plaintext">{opened.text}</pre>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
