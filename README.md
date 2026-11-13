# Privilege Logging LAB

Tier: Tester.
Repo: https://github.com/curtismu7/privilege-logging-LAB

A customer-explanation tool. For each PingOne Privilege (AI gateway) use case it drives a transaction through the gateway and shows **what gets logged**, scored against this customer requirement:

> The gateway provides an end-to-end audit trail for all MCP interactions. The audit trail should clearly emit:
> a. the user on whose behalf the MCP tool call was made;
> b. the agent identity acting on behalf of the user;
> c. which tool was called;
> d. what the authorization policy decision was.

The point is honesty. The findings include gaps (missing fields) and the lab never overstates them: anything not measured is labelled **UNVERIFIED**.

Open it: <http://127.0.0.1:7801/>

## Two modes (header toggle on every page)

| | Mock | Real (owner-run) |
| --- | --- | --- |
| What it does | Replays 17 transactions **measured on 2026-11-07**. 3 of the 5 log sinks were read (gateway pod log, Elasticsearch, OpenSearch); the response header and the console were not, so they are UNVERIFIED. Nothing is sent. | Sends the case to **your** gateway over MCP streamable HTTP (initialize, notifications/initialized, then the call, with `Mcp-Session-Id`), `traceparent` on every hop, then **fetches the log entry for that call by itself**. |
| Progress | Same two phases as Real, with a short fixed simulated delay: "Sending..." then "Fetching the log entry (simulated delay)...", then the recorded entry. The banner still says it is a replay. | A spinner (role=status, aria-busy, reduced-motion aware): "Sending..." then "Fetching the log entry...", retrying about once a second for up to 15 s and stopping as soon as the entry is found. Failures are explicit with a Retry: "Log source not reachable", "No entry found within 15 s". |
| Network | None. A netguard blocks every non-loopback socket, DNS lookup and fetch, with a self-test and a test that asserts zero attempts. | Only the origins you configure (gateway, log source): https, or http on loopback. No redirects followed, 8 s and 256 KB (1 MB for pod logs) caps, SSRF guard, a confirm gate before the first send. |
| Log source | The recorded sample lines. | A Kubernetes pod log through `kubectl proxy`, and/or a search endpoint (Elasticsearch/OpenSearch `_search`). With neither configured, Real says so and the **paste box** is the fallback. |
| Score | The recorded assessment (the scorer is re-run on the samples and any difference is shown). | Computed by the scorer from the entry actually retrieved. No entry, no score. |

The toggle follows rule 19: `POST /api/mode {source:"mock"|"real"}`, `GET /api/info` returns `source` and `realAvailable`. Real not configured: the button is disabled with a how-to tooltip and the server answers 409. Default: Real if configured, else Mock. The Docker image defaults to Mock; Real is never on by default there.

### How the log entry is found for a call (Real)

1. **Run marker.** Each run embeds a unique marker (`audit-<8 hex>`) in the request where the case allows it: the first string tool argument (replaced, or appended for a long sentence such as an injection test), `arguments.lab_run` for a call with no string argument, `params._meta` for `tools/list`. The Trace shows the marker and where it travelled.
2. **Marker first.** A log line that contains the marker is the call's own line (**matched by marker**). Lines written within 1.5 s of it, inside the call window, are its neighbours (**time window: inferred**).
3. **Time-window fallback.** If the marker never appears (after a 4 s grace period), lines from just before the send to 3 s after the receipt are used, and when the case names an app, only lines that do not name another app. A rejected 401 call logs only app, method, path and caller address, so there the lines must name the app path, and the window is used at once. Every such line is labelled **inferred**, and so is any score that rests only on them: other traffic in the window can be included, and a clock skew of more than a second between this Mac and the log source breaks it.
4. Lines that do not belong to the call are not shown. Every shown line has tokens, JWTs, API keys and passwords redacted first; the agent key is never shown.

### Kubernetes pod log through `kubectl proxy`

Run on the host (the proxy is loopback; the Docker image cannot reach your host's loopback, so use `./scripts/run.sh` for this source):

```sh
kubectl proxy                      # http://127.0.0.1:8001 (loopback)
```

The lab then GETs `/api/v1/namespaces/<ns>/pods/<pod>/log?container=<c>&sinceSeconds=<n>&timestamps=true&tailLines=3000` and reads plain logrus text lines (and JSON record lines such as the AI Guard record). `PRIV_LOG_K8S_POD` is a pod name, or a label selector such as `app=privilege-gateway` (the lab lists pods by that selector and reads the newest three Running ones). That a given cluster returns the gateway lines in this shape is **UNVERIFIED**: this lab has never read a live pod log.

## Cases not measured yet (Real only)

17 more cases are listed in four groups: **Keys** (revoked, expired, rate-limited 429, no mcp scope), **Federated identity** (valid token, wrong audience, wrong issuer, expired, lifetime too long), **Approvals** (held, approved, denied, Cedar per-call decision) and **Registry lifecycle** (key created, rotated or replaced, revoked, expired). They are `realOnly: true` in `server/data/real-only-cases.json` with the things they `needs`, and carry no recording and no score. In Mock the Run button is disabled ("No recorded measurement yet. Real mode only."), the API answers 409 and the Scorecard says **not measured**. In Real they run through the same spinner and automatic retrieval:

- Cases that send a credential only you have (a revoked key, a federated token) take it from a **write-only field on the case** (a password input, kept in memory for this tab, never returned or logged) or from `PRIV_LOG_BEARER_<CASEID>` (case id upper-cased, `-` as `_`, e.g. `PRIV_LOG_BEARER_KEYS_REVOKED`).
- **Valid workload token: the lab mints it.** Set the lab up once as a token issuer and every run sends a fresh token, with nothing pasted. The same steps, with your values filled in, are on the case card in Real mode (**Set up the lab as a token issuer**):
  1. Run `npm run fed-key`. It writes `PRIV_LOG_FED_SIGNING_SEED` (64 hex characters, a secret, write-only like the agent key) to `~/Development/.env` and prints the public values. It never replaces a seed that is already set, because a new seed is a new key. In Docker, pass `PRIV_LOG_FED_SIGNING_SEED` and `PRIV_LOG_FED_AUDIENCE` to `docker compose up`.
  2. In the Privilege console, add a **Federated Identity** (API kind `NonHumanIdentity`) with platform OIDC, issuer `https://privilege-logging-lab.invalid/workload`, "allow any subject" on with required claims `sub` = `privilege-logging-lab` and `iss` = that issuer (the console refuses a pinned subject when `sub` also names the end user; the required claims keep it to the lab's tokens), and the printed JWKS pasted as its keys. It needs a pasted JWKS, not a JWKS URI: the gateway cannot reach this loopback lab. Set the max token lifetime to 300 s or more (the default of 3600 is fine), the scope to `mcp`, and enable it.
  3. Copy the **Audience** the console shows on that identity into `PRIV_LOG_FED_AUDIENCE`.
  4. In **Agent Registry**, add an `mcp`-scoped agent whose custodian is that Federated Identity, and select the app your agent key reaches (that selection is the grant). Check that the app's policy lists the identity under Issued To, then wait about 4 minutes.
  5. Run the case. Each run sends an ES256 JWT (`iss`, `sub`, `aud`, `iat`/`nbf`, `exp` = +300 s, `jti`, and `kid` = the JWK thumbprint). The gateway log should say `workload token accepted for key …`.
  A token pasted in the field, or set as `PRIV_LOG_BEARER_FED_VALID_TOKEN`, overrides the minted one. Measured 2026-11-08 against a live gateway: the call answered 200, and the pod log showed `mcpgw: workload token accepted for key privilege-logging-lab-fed issuer=https://privilege-logging-lab.invalid/workload subject=privilege-logging-lab`, then the principal resolved as the NonHumanIdentity with policy capabilities for the app. The identity, key and grant were created through the console API; the console UI field labels are from the 2026-10 console (UNVERIFIED).
- Approval cases send the call and you act in the console; a call held for approval that does not answer is a recorded result, and the log is still read.
- Registry lifecycle cases are console actions: nothing is sent. Do the action in the console, then press **Look for entries** (since a time you choose) and the lab shows what the log source recorded since then, labelled inferred.

## Pages

1. **Run**: use cases grouped MCP, AI Guard, Rejected, Aggregate, A2A, LLM, Intent, a Run button each and Run all. A Run stays on this page (no jump to the Trace): the HTTP and score chips appear on the card, and **Open trace** shows the details.
2. **Trace**: the request, the response (HTTP and JSON-RPC `isError`), the raw hops, and per-sink panels where **every log entry is a syntax-coloured JSON tree**: logrus text lines (`time`, `level`, `msg`, `file`, then key=value pairs) and JSON records (such as the AI Guard record) are parsed, anything else is one string node, nothing is dropped. Collapse or expand per node (arrow keys, `role=tree`), Expand all / Collapse all, a Raw toggle, Copy JSON (redacted). The user, agent, tool and decision values are badged and underlined in the tree with a legend, each entry is tagged by how it was matched (marker, inferred time window, recorded sample, pasted), and missing fields are listed as "not present in this entry". Every entry also carries clickable **tags** in four groups: event type (auth, policy, routing, MCP request, response filter, guardrail, other, read from the line), this call or nearby (marker match vs time window), labels (source, runtime/console, the requirement fields found) and identity (keys, users, apps and Federated Identities the line names; Privilege RefIDs are decoded to their name). Styled after the Demo Shelf: each entry shows up to six tag pills ("+N more" opens the rest), and **Filter by tag** above each sink opens a panel of grouped tag chips with counts (what each tag would leave with the other groups applied; a tag that would leave nothing is disabled), "X of Y shown", Clear tags and Hide tags. Matching: any selected tag within a group, all groups with a selection (auth + policy = either; auth + this call = auth lines from this call); Clear restores. Rendering is React text only (no `innerHTML`), by an iterative walker with depth, node and string caps.
3. **Requirement 9** (the audit map, `#req9`): the customer's clause (a user, b agent, c tool, d decision) mapped onto Privilege's own records over the last 90 days (`policy-decision-log` and `proxy-audit-log`, read through the console like the Privilege tab). See [Requirement 9 tab](#requirement-9-tab).
4. **Scorecard**: use cases by the four clauses with met / partial / missing / n/a chips and the note. **Copy as Markdown table** for a customer email.
5. **Where it's logged**: the five sinks, what each held for the cases it was read for (two were never read: UNVERIFIED), and an honest "what we cannot see" list.
6. **Diagram**: one ReactFlow diagram per flow, caller to Privilege gateway to backend with the sinks hanging off the gateway. Drawn from `diagram-studio/1` data (`server/diagrams/*.json`, built from the capture), movable boxes, Simulate, speed control, Reset restores positions.
7. **Talk track**, presenter mode (`P`), theme picker (auto / light / dark), Reset.

A simulation banner is the first element of every page, also in presenter mode.

## Run it

```sh
# Docker (OrbStack, never Docker Desktop): published on 127.0.0.1:7801 only, Mock by default
HOST_PORT=7801 docker compose up --build -d
# or on the host (Node 26)
./scripts/run.sh
```

Open <http://127.0.0.1:7801/>. Health: <http://127.0.0.1:7801/api/health> (`demo-health/1`). Preflight: `npm run doctor`. Reset a running lab: `npm run reset` (or the header Reset, or `POST /api/reset`).

## Run from a clone

Prerequisites: Node 26 or newer. Docker (OrbStack) only for the Docker form. Mock needs no tenant and no credentials.

```
git clone https://github.com/curtismu7/privilege-logging-LAB.git
cd privilege-logging-LAB
npm ci
npm run build
npm run doctor
npm start
```

Open http://127.0.0.1:7801/. `GET /api/health` answers `demo-health/1`. Or with Docker: `HOST_PORT=7801 docker compose up --build -d` from the same folder.

## What to do if the port is taken

```
Ports: privilege-logging-LAB listens on 7801 only.
Docker publishes it on 127.0.0.1:7801 only.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:7801 -sTCP:LISTEN -n -P
2. If it is an old copy of this lab (npm start), stop that process: kill <PID>.
   If it is this lab's container: docker compose down (from this folder).
3. If it is something else, stop it. The lab refuses any other port on purpose
   (one port per app; npm run doctor says so), so free 7801 rather than moving the lab.
4. Then start again: npm start, or docker compose up -d.
```

### Real mode settings

In `~/Development/.env` (or the file named by `STANDALONE_ENV`; the environment wins). See `.env.example`.

| Name | |
| --- | --- |
| `PRIV_LOG_GATEWAY_URL` | The gateway's MCP endpoint. https, or http on loopback. A case that names an app uses `/<app>/mcp` on the same origin. |
| `PRIV_LOG_AGENT_KEY` | An agent access key, sent as `Authorization: Bearer ...` (UNVERIFIED: the capture does not record how the measured key was presented). **Write-only**: never returned by any API, never logged, shown only as `Bearer ***`. |
| `PRIV_LOG_SEARCH_URL` | Optional. An origin to read log events from. Without it, paste the gateway log lines. |
| `PRIV_LOG_SEARCH_INDEX` | Optional index name (`/<index>/_search`). |
| `PRIV_LOG_K8S_PROXY_URL` | Optional. `kubectl proxy` (https, or http on loopback). Defaults to `http://127.0.0.1:8001` when the namespace and pod are set. |
| `PRIV_LOG_K8S_NAMESPACE`, `PRIV_LOG_K8S_POD` | Both needed for the pod-log source. The pod is a name or a label selector (`app=name`). |
| `PRIV_LOG_K8S_CONTAINER` | Container to read. Default `log-tailer`. |
| `PRIV_LOG_BEARER_<CASEID>` | Optional per-case credential for the not-yet-measured cases that send one. Write-only. |
| `PRIV_LOG_CONSOLE_URL`, `PRIV_LOG_CONSOLE_TENANT` | Optional, both needed. The Privilege console origin (for the local desktop console, the address the PingOne Privilege app opens in your browser) and the tenant id. Turns on the **Privilege logs** source and the **Privilege -> Elasticsearch** tab: Privilege's own hosted indices, read through the console's `elasticlog` API. The console host may resolve to loopback; no other name may. |
| `PRIV_LOG_CONSOLE_CA` | Optional. A PEM file of the console's root CA (the local console chains to a tenant root the PingOne Privilege app installs in the keychain, which Node does not trust). Trusted for the console origin only. Export it with `security find-certificate -a -c TenantRoot -p /Library/Keychains/System.keychain`. |

Not every case can be driven in Real: A2A, LLM and the intent-encoder case need routes this lab has not measured, so Real lists them as not runnable and you paste their log lines instead. The Rejected cases, and the four bad federated-token cases, use a bad credential the lab generates itself (a made-up key, a malformed token, or a JWT with one wrong claim on `.invalid` hosts); you never paste one. A revoked, expired or rate-limited key cannot be generated: those need a real key in that state.

## The Privilege logs bridge (owner-run)

Privilege's SIEM export sends console events (`audit-log`) and gateway HTTP records (`proxy-audit-log`) but not its decision, guardrail or approval records. The bridge copies those three (`policy-decision-log`, `aiguard-log`, `agent-approval-log`) into the SIEM index every minute:

```
npm run bridge            # every 60 s until stopped
npm run bridge -- --once  # one pass
```

- **Reads** through the console's `elasticlog` API (the same read as the Privilege -> Elasticsearch tab), so it runs where the PingOne Privilege desktop app runs. No cloud API credential exists for it, so it cannot run in Kubernetes.
- **Writes** each record to `<PRIV_LOG_BRIDGE_ES_URL>/ping-siem-events-v2/_doc/<the record's own id>`, so a re-read never duplicates. The index's ingest pipeline masks keys and labels each record `privilege_event_kind: runtime`; the bridge adds `Index` (the source index) and `privilege_bridge: true`.
- **Catches up**: each pass reads from 10 minutes before the newest record it copied (records reach Privilege's store late), and a failed pass keeps the saved position. A first run copies the last 30 days. State: `~/.config/privilege-logging-lab/bridge-state.json` (`PRIV_LOG_BRIDGE_STATE` overrides). `npm run doctor` says when it last ran.

| Name | |
| --- | --- |
| `PRIV_LOG_BRIDGE_ES_URL` | The Elasticsearch origin (https, or http on loopback). |
| `PRIVILEGE_KIBANA_URL` | Optional. Where the Privilege tab's **Open in Kibana** link points (an origin: https, or http on loopback; default `http://localhost:5601`). The lab never contacts it. |
| `PRIV_LOG_BRIDGE_ES_APIKEY` | An Elasticsearch API key that may only write to the target index. **Write-only**: never printed or logged. |

The bridge also needs the console settings above. What it cannot fix: a plain allowed call has no decision record to copy (only calls a policy matched get one).

## Where an entry came from: console vs runtime

Every entry is labelled twice:

- **Channel** (a badge on each sink): `GATEWAY POD LOG` (read with kubectl, not from Privilege), `PRIVILEGE -> ELASTICSEARCH` (what Privilege itself wrote), or another source (our OpenSearch sidecar, the response header, pasted lines).
- **Kind**: a **runtime event** is something the gateway did with traffic (a call, a policy decision, a guardrail verdict, an approval hold); a **console event** is an admin change in the Privilege console. Privilege's hosted indices decide it: `policy-decision-log`, `aiguard-log`, `proxy-audit-log`, `agent-approval-log`, `proxy-event-log` are runtime; `audit-log`, `event-log` are console. In a SIEM index a console event has a top-level `Module` and a string `Data`.

The **Privilege -> Elasticsearch** tab shows only Privilege's own entries, read through the console:

- **Time**: 15 min, 1 h, 6 h, 24 h, 7 d, 30 d, 90 d, or a custom From/To (at most 90 days back, From before To). Mock counts back from the end of the recording.
- **Filters**: kind, index, decision (allow, deny, hitl), user, agent key (the client for AI Guard records), tool, app, event (each offered from the values in the range) and free text over the redacted record.
- **Paging**: the server reads the console 200 records at a time (Size, From) up to 5,000 records per query (the console's search stops at 10,000), says plainly when the cap or the window cut it off, and pages the filtered set 50 at a time (Newer / Older). A read is reused for a minute while you page or filter.
- **Counts and chart**: runtime vs console, decisions, AI Guard verdicts, and entries over time; click a bar to narrow the range to it. Over a capped read the counts say "capped sample".
- **Table and JSON**: a compact table (time, index, kind, user, agent, tool, decision) or the colour JSON view. Choose a row's time to see **Related records**: every record within 10 minutes that shares its request id or trace id (`Data.TraceID`, or the trace id in a `Traceparent` header), plus records linked to those by their own ids.
- **Export**: the page or the whole filtered set (up to the cap) as JSON or CSV, built in the browser from already redacted entries (CSV cells are quoted and formula starts defused).
- **Open in Kibana**: Discover on the `privilege-logs` data view with the same range and a KQL query from the filters. `PRIVILEGE_KIBANA_URL` sets the origin. The default is `http://localhost:5601` through a port-forward (`kubectl --context <your-context> -n <your-namespace> port-forward svc/kibana-siem 5601:5601`, with your own kube context and namespace). Kibana shows what reached the SIEM index, which may differ from what the console holds.

Mock is labelled "recorded shapes, placeholder values": the five measured decision records plus AI Guard, HTTP and console records in shapes measured 2026-11-08; their times and shared ids are illustrative.

Privilege's logs carry keys in full (an `aiguard-log` `VirtualKeyID`, an agent save's provider `RealKey` in `audit-log`); the lab shows only their first 8 and last 4 characters, and never shows the console's raw base64 answer.

## Requirement 9 tab

`GET /api/req9[?rid=<RequestID>]` (read-only; `rid` is 1 to 64 letters, digits, `_` or `-`, anything else or any other parameter is a 400). Real reads `policy-decision-log` and `proxy-audit-log` for the last 90 days through the console, behind the same confirm gate (412), record cap, redaction and netguard as the Privilege tab, and keeps the read a minute per tab. Mock is `server/data/req9-sample.json`: recorded shapes, placeholder values, with every pattern in it.

- **Relationship**: one selected decision record drawn as User (`Data.User`, `Data.PrincipalKind`) on behalf of Agent (`Data.AgentKey`) calls Tool (`Data.Target` + `Data.Method` on `Data.App`) judged by Decision (`Data.Decision`, `Data.Reason`, `Data.PolicyIDs`), with a dashed link to the `policy_approval_required` record that shares `Data.RequestID`. ReactFlow over `diagram-studio/1` data (`server/diagrams/req9.json`, loaded by name), movable boxes, Simulate, speed, Reset; a part the record lacks is a dashed red box.
- **Record picker**: every decision record, newest first (a hold that has its `policy_decision` is shown linked to it, not listed twice), time, short user, agent key or "no agent", tool and a decision chip; search over RequestID, user, agent key, tool or app; Previous / Next. **Linked records**: the same RequestID within 10 minutes, and the approval release for a hold (or the hold for a release) by the same user and tool within 10 minutes, labelled "matched by user, tool and time" because Privilege logs the release under a new RequestID.
- **Deep link**: `http://127.0.0.1:7801/#req9/<RequestID>` opens that record. Kibana links to it through a field URL formatter, so this shape is kept stable. An invalid id is never sent (the page says so and shows the newest record); an unknown one falls back to the newest with a short note.
- **Coverage**: per part, how many decision records carry it, with met / partial chips (d is partial when HTTP records show calls but no plain allow decision exists).
- **Ledger**: one example per pattern in four lanes a-d: all four held, all four denied, non-human caller, no agent key, approval released under a new RequestID, and the plain allowed call (`proxy-audit-log`: user and the `/mcp` path only). A pattern not seen says so.
- **Gaps**: the agent is missing when the user's own token is used; allowed calls write no decision record (a question for Ping); the approval release has a new RequestID.

## How the scorer decides (a pure function, `server/src/scorer.js`)

Per field, from the lines of one call: **met** (a line names the value), **partial** (only implied or weak), **missing** (nothing says it). **n/a** is never decided from lines; the use case supplies it.

- user: access-token line, `Principal {User ...}`, a denial line naming the user, a JSON/logfmt `User`.
- agent: a named client or key is met (taken as the agent or key: a log line cannot prove it); an OAuth client id (UUID, long hex, or a name with "oauth") or a bare `agent=true` is partial (a heuristic: a log line cannot say whether a client is an agent).
- tool: `MCP call detected ... target: <tool>`, a `tools/call` payload, a `tool` key; a tool named only because it was *removed* from a list is partial.
- decision: an explicit policy denial (`policy denied`, `Access Denied` on a `[mcpgw]` line, a denied/forbidden event) or a decision key is met; an app-level permission line, an authentication refusal, a guardrail block (`aiguard: blocked`, a blocked event: a guardrail verdict, not an authorization decision) and `Access Denied` text off a gateway line are partial. An `aiintent: ... unavailable` warning is no decision evidence (missing).

Pinned against the capture: the scorer reproduces the recorded score for all but five documented differences (8 field levels; the capture keeps only sample lines, and one record was judged on its own). Each differing field says so in its score note, so the Scorecard and the Markdown export carry it. A tools/list call is n/a for tool (it calls no tool). Mutation tests remove lines and the score drops. Input is bounded and parsed in one linear pass (no ReDoS, no `eval`, iterative JSON walk).

## What the capture says, in short

Run the Scorecard for the table. Headlines, all from the 2026-11-07 capture of one gateway build: the pod log is the only sink with per-call lines; no allowed call has an explicit allow line; the 401 rejections and the aggregate and LLM refusals name no user or agent, while the MCP policy denials (403) and the AI Guard block name the user (and agent=true or the client) but no tool; the aggregate and LLM routes log little or nothing; A2A was measured on one call that failed (backend down), so a successful A2A call is not measured; the SIEM index held console changes only; the OpenSearch shipper had not delivered since 2026-10-26. The `X-Gw-Audit-Trail` response header and the console Activity Log were **not captured: UNVERIFIED**.

## Safety

Loopback bind, Host check, same-origin writes, Docker publishes `127.0.0.1:` only (a test pins it), no `eval`/`Function`/`vm`, user text rendered inert. Details in [docs/safety.md](docs/safety.md). Only `.example` / `.invalid` hosts ship; the capture is sanitised to placeholders.

## Tests

`npm test` runs the server tests (`node --test test/*.test.js`), the web tests (vitest; the UI is tested against the real server in a child process) and the repo tests (`node --test scripts/*.test.mjs`). Browser proof (Playwright, both themes, 375px, Mock against the running app and Real against fake gateway and fake kubectl-proxy servers): `node scripts/e2e.mjs all`; screenshots of the spinner, JSON viewer and failure states are in `docs/evidence/`. Real mode is tested only against an in-process FAKE gateway and FAKE search endpoint; agents never use live credentials.

## Layout

`server/` Express API (`capture.js` validator, `scorer.js`, `matcher.js` marker/window matching, `lab.js`, `mcpRunner.js`, `logSources.js` (kubectl proxy pod log, search), `redact.js`, `searchClient.js`, `realClient.js`, `netguard.js`, `config.js`), `server/data/capture.json` the measured fixture (`privilege-logging-capture/1`), `server/diagrams/` flow diagrams, `web/` React + Vite UI, `docs/`, `scripts/`, `content-pack.json` (Learning Hub, `demo-content-pack/1`), `docs/shelf-entry.json`.

Scaffold, safety modules and the diagram stack follow `observability-LAB`; the Mock/Real toggle follows `ai-guard-sidecar-LAB`; no cross-repo imports.

---

## If the Privilege desktop agent shows "unregistered"

The PingOne Privilege **desktop app** (the one serving the local console at
`https://local.procyon.ai:8643`) stays registered with the Ping cloud through a background
agent (`ping-helper`). When that agent's device record is deleted or unapproved on the cloud
side, every Privilege app on this machine loses Real mode: the local console stops serving,
connections time out, and the desktop app shows the agent as **unregistered**.

### How to tell this is what happened

1. **The desktop app says the agent is unregistered** (banner or the agent status panel), or its
   diagnostics print `✖ Found N errors` with `Device … not found`.
2. **The local console is down with it**: `https://local.procyon.ai:8643` does not answer
   (connection refused / timeout) even though the PingOne Privilege app is running.
3. **The agent log loops on one error.** Check `/Library/Logs/Procyon/procyon-agent.log`:

   ```
   Error getting the device: HTTP error: 500 Internal Server Error
   Body: { "error": "Device <base64-id> not found", "code": 2, ... }
   ```

   repeated every ~2 seconds. That single line is the tell: the agent is asking the cloud
   about a device record the cloud no longer has. (A one-off is harmless — it is the endless
   repetition that means unregistered.)

### Why it happens

- The cloud side **deletes or disables the device record** (an admin action in the console, a
  tenant sync, or a guard tripping after network churn). The agent cannot re-create it by
  itself: it re-registers only on an enable/disable cycle, and re-registration **waits for a
  human to approve the new device** in the console.
- Network/VPN blips to `privilege.pingone.com` (`lookup … no such host` in the same log) force
  re-registrations and can churn the device identity, making the window for this bigger.

### How to fix it

1. Open the **PingOne Privilege** desktop app and make sure it is running.
2. Sign in to the **cloud console**: `https://console.pingone.com/?env=<your-privilege-env-id>`
   → launch **PingOne Privilege** → open the **Devices** page.
3. Find this machine's device (`DeviceName: mac-…`, type MAC). It is either:
   - **pending approval** — click **Approve** (the agent's certificate request is waiting;
     this is the usual state after a delete), or
   - **missing entirely** — in the desktop app toggle the agent **off and on** (or quit and
     reopen the app) so it mints a fresh certificate request, then approve it in the console.
4. The agent picks up the approval within seconds (watch
   `/Library/Logs/Procyon/procyon-agent.log` for `Device registered with controller`), and the
   local console at `local.procyon.ai:8643` starts serving again. Real mode in this app works
   immediately after — no restart of the app needed.

### If it comes back

The device being deleted repeatedly is a **console-side action** (admin, sync sweep, or a
server-side guard after repeated network drops). Note the times from
`grep "Delete request recieved" /Library/Logs/Procyon/procyon-agent*.log` and raise it with
 whoever administers the Privilege tenant — re-approving treats the symptom; the deletes have
 to stop for it to stay fixed.
