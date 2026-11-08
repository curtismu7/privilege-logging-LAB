# Changelog

## Unreleased (Requirement 9 tab)

- Requirement 9 tab (`#req9`): the customer's audit clause (a user, b agent, c tool, d decision) mapped onto Privilege's own `policy-decision-log` and `proxy-audit-log` records over the last 90 days. A ReactFlow relationship view of one selected decision record (values from the record, dashed red where a part is absent, dashed link to the approval hold with the same RequestID), coverage tiles a-d with met / partial chips, a ledger of one example per pattern (held, denied, non-human caller, no agent key, approval released under a new RequestID, plain allowed call) and the three gaps in plain words.
- Record picker: every decision record newest first with search (RequestID, user, agent key, tool, app) and Previous / Next; linked records by RequestID and, for an approval release, by user, tool and time within 10 minutes.
- Deep link `#req9/<RequestID>` (stable, for Kibana's field URL formatter); an invalid id is never sent and an unknown one falls back to the newest record with a note.
- `GET /api/req9[?rid=]`: read-only, strict 400 on anything else; Real behind the confirm gate with redaction, the record cap and a one-minute cache per tab; Mock from `server/data/req9-sample.json` (placeholder values).
- Privilege record fields now include `method`, `path` and `policyIds`; diagram nodes may carry `sub` lines.

## Unreleased (case tags)

- Run page: every case card carries tags (area, expected allow/refuse, call, credential, measured or not) and an open tag panel above the cards filters them, shelf style; sections with no matching card hide. Clicking a tag on a card toggles it too.
- The tag filter is one shared component for the Run page and the Trace.
- Finishing a run no longer scrolls the page to bring the Run button into view (focus returns without scrolling).

## Unreleased (entry tags)

- Trace: every log entry has clickable tags (event type, this call or nearby, labels, identity) and each sink has a tag filter with counts.
- Run stays on the Run page: the result shows on the card and focus goes back to that Run button; Open trace is a separate click. Look for entries works the same way.
- Real: the confirm before the first send opens inside the case card you ran (Send button there), so the page no longer jumps to the top. Run all and the Privilege page keep the top-of-page confirm.
- Trace tags restyled after the Demo Shelf: Filter by tag toggle, grouped chip panel with counts and disabled zero chips, X of Y shown, Clear tags / Hide tags, six pills per entry then +N more.
- Getting back from a Trace: a Back to Run button on the Trace page, and the browser Back button works (page changes are history entries now). Either way the Run page comes back with the case you opened in view and its Open trace button focused.

## Unreleased (Privilege tab explorer)

- Privilege -> Elasticsearch tab: quick ranges up to 90 days and a custom From/To; filters (kind, index, decision, user, agent key, tool, app, event, free text); server-side paging through the console (200 per read, 5,000 cap, 10,000 window, said plainly when cut off) and Newer/Older pages; counts and an events-over-time chart with click-to-zoom; a table view with Related records by request id or trace id (`GET /api/privilege-logs/related`); JSON and CSV export; Open in Kibana (`PRIVILEGE_KIBANA_URL`). Every query parameter is validated (400). The `minutes` parameter is replaced by `range` or `from`/`to`.
- Fix: secrets the Real client knows (the agent key) are now masked inside decoded console records too, not only in the base64 answer text.
- Mock sample: recorded shapes, placeholder values (adds AI Guard, HTTP and console records in the 2026-11-08 shapes).

## Unreleased (workload token)

- Valid workload token: the lab mints the token itself (ES256, 300 s, key derived from `PRIV_LOG_FED_SIGNING_SEED`, audience from `PRIV_LOG_FED_AUDIENCE`). `npm run fed-key` makes the seed. The case card and `GET /api/fed-setup` show the public issuer, subject and JWKS, plus the console steps. A pasted token still overrides the minted one. Measured on a live gateway 2026-11-08: `workload token accepted`, call answered 200.

## Unreleased (bridge)

- Privilege logs bridge (`npm run bridge`): copies policy-decision-log, aiguard-log and agent-approval-log through the console into the SIEM index under their own ids, every minute, with a 10-minute overlap and a saved position; the doctor reports its last pass.

## Unreleased

- Honesty fixes: a guardrail block scores decision partial (not an authorization decision); `Access Denied` counts as met only on a gateway line; an intent-unavailable warning is no decision evidence; every tools/list case is n/a for tool; the console sink is UNVERIFIED (never read); score notes disclose where the recorded level differs from the scorer on the sample lines; the "(no guardrail line)" annotation is no longer stored as a log line; per-field tallies are labelled inferred; the refusal and sink facts are counted from the capture; the Real banner names the kubectl proxy pod-log source.
- Privilege -> Elasticsearch tab: only what Privilege itself logged (its hosted indices, read through the console's elasticlog API), for a time range, with runtime/console and index filters. Mock shows the five decision records recorded on 2026-11-07.
- Privilege logs as a Real log source on every run (PRIV_LOG_CONSOLE_URL, PRIV_LOG_CONSOLE_TENANT, PRIV_LOG_CONSOLE_CA), matched by time window and app.
- Every entry says where it came from (channel badge: gateway pod log vs Privilege -> Elasticsearch vs other) and what kind it is (runtime or console event).
- Redaction: sk- keys (Privilege logs carry virtual keys and provider keys in full) keep only their first 8 and last 4 characters; the console's base64 answer is never shown raw.
- Refresh button (stops any wait for a log entry, keeps runs). Trace dropdown grouped into Happy path and Failures. Bad keys and tokens are generated by the lab, never pasted.
- Scorer reads Privilege decision records (AgentKey, Target, a hold counts as a decision). The confirm gate lists every origin it will read.

## 0.1.0

- First version. Mock replays the 17 use cases measured on 2026-11-07 (3 of 5 log sinks read; the response header and the console were not, UNVERIFIED); Real sends them to a configured gateway over MCP streamable HTTP and reads the log back from a search endpoint or from pasted lines.
- Scorer: a pure function that scores user, agent, tool and decision from log lines (logrus text and JSON records); pinned against the capture with five documented differences.
- Pages: Run, Trace, Scorecard (Markdown export), Where it's logged, Diagram (one per flow, diagram-studio/1 data), Talk track. Presenter mode, theme picker, Reset.
