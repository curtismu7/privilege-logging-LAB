import { useEffect, useState } from "react";
import { getJson } from "../api";
import { Chip } from "./Chips";

// The "Valid workload token" case: the lab mints the token itself once it is registered as an issuer in Privilege.
// Shows the PUBLIC setup values from /api/fed-setup (issuer, subject, JWKS) and the steps; the signing seed is never sent to the page.
export default function FedSetup({ bearerConfigured }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { getJson("/api/fed-setup").then(setS, (e) => setErr(e.message)); }, [bearerConfigured]);
  if (err) return <p className="muted" data-testid="fed-setup-error">Could not read the issuer setup: {err}</p>;
  if (!s) return null;
  return (
    <details className="fed-setup" open={!s.ready} data-testid="fed-setup">
      <summary>
        Set up the lab as a token issuer{" "}
        {s.ready ? <Chip kind="ok" testId="fed-ready">lab mints the token</Chip> : <Chip kind="warn" testId="fed-not-ready">setup needed</Chip>}
      </summary>
      {s.problem && <p className="muted" data-testid="fed-problem">Not ready: {s.problem}.</p>}
      <ol>
        <li>In this repo run <code>npm run fed-key</code>. It writes a signing seed (secret) to <code>~/Development/.env</code> and prints the values below. In Docker, pass <code>PRIV_LOG_FED_SIGNING_SEED</code> and <code>PRIV_LOG_FED_AUDIENCE</code> to <code>docker compose up</code> and restart.</li>
        <li>In the Privilege console add a <strong>Federated Identity</strong> (platform OIDC):
          <ul>
            <li>Issuer: <code data-testid="fed-issuer">{s.issuer}</code></li>
            <li>Subject: allow any subject, and add <strong>required claims</strong> <code>sub</code> = <code>{s.subject}</code> and <code>iss</code> = the issuer above. That way only the lab's tokens match. The console refuses a pinned subject when <code>sub</code> also names the end user.</li>
            <li>Keys: paste this JWKS (no JWKS URI: the gateway cannot reach this lab){s.jwks ? null : " — run step 1 first"}</li>
          </ul>
          {s.jwks && <pre className="code" data-testid="fed-jwks">{JSON.stringify(s.jwks)}</pre>}
          <ul>
            <li>Max token lifetime: {s.tokenLifeSec} s or more (default 3600 is fine). Scopes: <code>mcp</code>. Enabled.</li>
          </ul>
        </li>
        <li>Copy the <strong>Audience</strong> the console shows on that identity into <code>PRIV_LOG_FED_AUDIENCE</code>{s.audience ? <> (now: <code data-testid="fed-audience">{s.audience}</code>)</> : null}.</li>
        <li>In <strong>Agent Registry</strong>, add an agent with scope <code>mcp</code> whose custodian is that Federated Identity, and select the same app your agent key reaches (that is the grant). Check the app's policy lists the identity under Issued To. Wait about 4 minutes.</li>
        <li>Run this case. Each run sends a fresh {s.tokenLifeSec}-second ES256 token. The gateway log should say <code>workload token accepted</code>.</li>
      </ol>
      <p className="muted">Pasting your own token below overrides the minted one.</p>
    </details>
  );
}
