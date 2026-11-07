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
| What it does | Replays 17 transactions **measured on 2026-11-07** (5 log sinks). Nothing is sent. | Sends the case to **your** gateway over MCP streamable HTTP (initialize, notifications/initialized, then the call, with `Mcp-Session-Id`), `traceparent` on every hop, then reads the log back. |
| Network | None. A netguard blocks every non-loopback socket, DNS lookup and fetch, with a self-test and a test that asserts zero attempts. | Only the two origins you configure (https, or http on loopback). No redirects followed, 8 s and 256 KB caps, SSRF guard, a confirm gate before the first send. |
| Log source | The recorded sample lines. | A search endpoint (Elasticsearch/OpenSearch `_search`) for the call's time window, or a **paste box** (logrus text lines and JSON records). |
| Score | The recorded assessment (the scorer is re-run on the samples and any difference is shown). | Computed by the scorer from the lines actually returned. No lines, no score. |

The toggle follows rule 19: `POST /api/mode {source:"mock"|"real"}`, `GET /api/info` returns `source` and `realAvailable`. Real not configured: the button is disabled with a how-to tooltip and the server answers 409. Default: Real if configured, else Mock. The Docker image defaults to Mock; Real is never on by default there.

## Pages

1. **Run**: use cases grouped MCP, AI Guard, Rejected, Aggregate, A2A, LLM, Intent, a Run button each and Run all.
2. **Trace**: the request, the response (HTTP and JSON-RPC `isError`), the raw hops, and per-sink panels with the **user, agent, tool and decision values marked inline** in the log lines.
3. **Scorecard**: use cases by the four clauses with met / partial / missing / n/a chips and the note. **Copy as Markdown table** for a customer email.
4. **Where it's logged**: the five sinks, what each held, and an honest "what we cannot see" list.
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

Not every case can be driven in Real: A2A, LLM and the intent-encoder case need routes this lab has not measured, so Real lists them as not runnable and you paste their log lines instead. The Rejected cases send no credential, a made-up key and a malformed token on purpose.

## How the scorer decides (a pure function, `server/src/scorer.js`)

Per field, from the lines of one call: **met** (a line names the value), **partial** (only implied or weak), **missing** (nothing says it). **n/a** is never decided from lines; the use case supplies it.

- user: access-token line, `Principal {User ...}`, a denial line naming the user, a JSON/logfmt `User`.
- agent: a named client or key is met; an OAuth client id (UUID, long hex, or a name with "oauth") or a bare `agent=true` is partial (a heuristic: a log line cannot say whether a client is an agent).
- tool: `MCP call detected ... target: <tool>`, a `tools/call` payload, a `tool` key; a tool named only because it was *removed* from a list is partial.
- decision: an explicit policy denial, a guardrail block or a decision key is met; an app-level permission line, an authentication refusal and similar are partial (the decision is implied).

Pinned against the capture: the scorer reproduces the recorded score for all but five documented differences (the capture keeps only sample lines, and one record was judged on its own). Mutation tests remove lines and the score drops. Input is bounded and parsed in one linear pass (no ReDoS, no `eval`, iterative JSON walk).

## What the capture says, in short

Run the Scorecard for the table. Headlines, all from the 2026-11-07 capture of one gateway build: the pod log is the only sink with per-call lines; no allowed call has an explicit allow line; rejected calls name no user, agent or tool; the aggregate, A2A and LLM routes log little or nothing; the SIEM index held console changes only; the OpenSearch shipper had not delivered since 2026-10-26. The `X-Gw-Audit-Trail` response header and the console Activity Log were **not captured: UNVERIFIED**.

## Safety

Loopback bind, Host check, same-origin writes, Docker publishes `127.0.0.1:` only (a test pins it), no `eval`/`Function`/`vm`, user text rendered inert. Details in [docs/safety.md](docs/safety.md). Only `.example` / `.invalid` hosts ship; the capture is sanitised to placeholders.

## Tests

`npm test` runs the server tests (`node --test test/*.test.js`), the web tests (vitest; the UI is tested against the real server in a child process) and the repo tests (`node --test scripts/*.test.mjs`). Browser proof (Playwright, both themes, 375px, Mock against the running app and Real against fake servers): `node scripts/e2e.mjs all`. Real mode is tested only against an in-process FAKE gateway and FAKE search endpoint; agents never use live credentials.

## Layout

`server/` Express API (`capture.js` validator, `scorer.js`, `lab.js`, `mcpRunner.js`, `searchClient.js`, `realClient.js`, `netguard.js`, `config.js`), `server/data/capture.json` the measured fixture (`privilege-logging-capture/1`), `server/diagrams/` flow diagrams, `web/` React + Vite UI, `docs/`, `scripts/`, `content-pack.json` (Learning Hub, `demo-content-pack/1`), `docs/shelf-entry.json`.

Scaffold, safety modules and the diagram stack follow `observability-LAB`; the Mock/Real toggle follows `ai-guard-sidecar-LAB`; no cross-repo imports.
