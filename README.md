# Privilege Logging Lab

**Tier: Tester**

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
- Approval cases send the call and you act in the console; a call held for approval that does not answer is a recorded result, and the log is still read.
- Registry lifecycle cases are console actions: nothing is sent. Do the action in the console, then press **Look for entries** (since a time you choose) and the lab shows what the log source recorded since then, labelled inferred.

## Pages

1. **Run**: use cases grouped MCP, AI Guard, Rejected, Aggregate, A2A, LLM, Intent, a Run button each and Run all.
2. **Trace**: the request, the response (HTTP and JSON-RPC `isError`), the raw hops, and per-sink panels where **every log entry is a syntax-coloured JSON tree**: logrus text lines (`time`, `level`, `msg`, `file`, then key=value pairs) and JSON records (such as the AI Guard record) are parsed, anything else is one string node, nothing is dropped. Collapse or expand per node (arrow keys, `role=tree`), Expand all / Collapse all, a Raw toggle, Copy JSON (redacted). The user, agent, tool and decision values are badged and underlined in the tree with a legend, each entry is tagged by how it was matched (marker, inferred time window, recorded sample, pasted), and missing fields are listed as "not present in this entry". Rendering is React text only (no `innerHTML`), by an iterative walker with depth, node and string caps.
3. **Scorecard**: use cases by the four clauses with met / partial / missing / n/a chips and the note. **Copy as Markdown table** for a customer email.
4. **Where it's logged**: the five sinks, what each held for the cases it was read for (two were never read: UNVERIFIED), and an honest "what we cannot see" list.
5. **Diagram**: one ReactFlow diagram per flow, caller to Privilege gateway to backend with the sinks hanging off the gateway. Drawn from `diagram-studio/1` data (`server/diagrams/*.json`, built from the capture), movable boxes, Simulate, speed control, Reset restores positions.
6. **Talk track**, presenter mode (`P`), theme picker (auto / light / dark), Reset.

A simulation banner is the first element of every page, also in presenter mode.

## Run it

```sh
# Docker (OrbStack, never Docker Desktop): published on 127.0.0.1:7801 only, Mock by default
HOST_PORT=7801 docker compose up --build -d
# or on the host (Node 26)
./scripts/run.sh
```

Open <http://127.0.0.1:7801/>. Health: <http://127.0.0.1:7801/api/health> (`demo-health/1`). Preflight: `npm run doctor`. Reset a running lab: `npm run reset` (or the header Reset, or `POST /api/reset`).

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

## Where an entry came from: console vs runtime

Every entry is labelled twice:

- **Channel** (a badge on each sink): `GATEWAY POD LOG` (read with kubectl, not from Privilege), `PRIVILEGE -> ELASTICSEARCH` (what Privilege itself wrote), or another source (our OpenSearch sidecar, the response header, pasted lines).
- **Kind**: a **runtime event** is something the gateway did with traffic (a call, a policy decision, a guardrail verdict, an approval hold); a **console event** is an admin change in the Privilege console. Privilege's hosted indices decide it: `policy-decision-log`, `aiguard-log`, `proxy-audit-log`, `agent-approval-log`, `proxy-event-log` are runtime; `audit-log`, `event-log` are console. In a SIEM index a console event has a top-level `Module` and a string `Data`.

The **Privilege -> Elasticsearch** tab shows only Privilege's own entries for a time range, filterable by kind and index. Privilege's logs carry keys in full (an `aiguard-log` `VirtualKeyID`, an agent save's provider `RealKey` in `audit-log`); the lab shows only their first 8 and last 4 characters, and never shows the console's raw base64 answer.

## How the scorer decides (a pure function, `server/src/scorer.js`)

Per field, from the lines of one call: **met** (a line names the value), **partial** (only implied or weak), **missing** (nothing says it). **n/a** is never decided from lines; the use case supplies it.

- user: access-token line, `Principal {User ...}`, a denial line naming the user, a JSON/logfmt `User`.
- agent: a named client or key is met (taken as the agent or key: a log line cannot prove it); an OAuth client id (UUID, long hex, or a name with "oauth") or a bare `agent=true` is partial (a heuristic: a log line cannot say whether a client is an agent).
- tool: `MCP call detected ... target: <tool>`, a `tools/call` payload, a `tool` key; a tool named only because it was *removed* from a list is partial.
- decision: an explicit policy denial (`policy denied`, `Access Denied` on a `[mcpgw]` line, a denied/forbidden event) or a decision key is met; an app-level permission line, an authentication refusal, a guardrail block (`aiguard: blocked`, a blocked event: a guardrail verdict, not an authorization decision) and `Access Denied` text off a gateway line are partial.

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
