# Talk track: Privilege Logging Lab

Generated from `server/src/story.js` by `npm run talk-track`. Do not edit by hand. SIMULATED. Replay of transactions measured on 2026-11-07; nothing is sent. The log lines are recorded samples with placeholders for ids; no gateway, search endpoint or tenant is contacted.

## 1. Start with the requirement

The customer asked for an end-to-end audit trail for every MCP interaction: who the call was for, which agent made it, which tool, and what the policy decided. This lab shows, use case by use case, what the gateway actually logged, and where it does not.

## 2. Run a case

Pick a case on the Run page. In Mock mode this replays a transaction we measured on the capture date; nothing is sent. In Real mode the owner sends it to their own gateway and reads the log back.

## 3. Watch it fetch the log

Pressing Run shows a spinner: first Sending, then Fetching the log entry. The lab finds the entry by a unique marker it put in the request, and falls back to a tight time window, which it labels as inferred. If the log source is down or the entry never shows up, the page says so and offers Retry; with no log source configured you can paste the lines instead.

## 4. Cases not measured yet

Keys, Federated identity, Approvals and Registry lifecycle are listed but have no recording. In Mock they are disabled and the Scorecard says not measured. In Real you supply the credential or do the console action yourself, and the lab shows what the log recorded.

## 5. Read the trace

The Trace page shows the request, the response and, per log sink, the entries that were written as coloured JSON trees, each tagged with how it was matched. The user, agent, tool and decision values are badged and underlined so the customer sees exactly which words satisfy which clause, and fields that are not in the entry are listed.

## 6. Show the scorecard

Met means a line names it. Partial means it is only implied or only half there, for example an app-level permission line instead of a per-call allow. Missing means nothing in the log says it. Copy the table into the customer email as it is.

## 7. Say the gaps out loud

Rejected calls name nobody. Aggregate routes log almost nothing for the member calls. The LLM route logged nothing we could find. No allowed call has an explicit allow line. Naming these is what makes the rest credible.

## 8. Where it is logged

There are five places a record could land. Only the gateway pod log carried per-call lines, the SIEM index held console changes only, and the shipper to OpenSearch has not delivered since late October. The response header is described but was not captured, so we say UNVERIFIED.

## 9. Real mode and the paste box

Real mode sends the call to the gateway you configured and queries your search endpoint for events in the call window. With no search endpoint, paste the gateway log lines and the same scorer reads them.

## 10. Close honestly

Offer the scorecard as the current measured state, not a promise. Anything marked UNVERIFIED is an open question, and a re-run after a gateway change updates the table.

## Facts and their status

- **measured**: 17 use cases were driven through the gateway on 2026-11-07 and what each one logged was read back. Sources: hosted Privilege gateway pod log, Elasticsearch ping-siem-events, OpenSearch gateway-events.
- **measured**: User: met in 9 of 17 cases, partial in 0, missing in 7, not applicable in 1.
- **measured**: Agent: met in 4 of 17 cases, partial in 5, missing in 7, not applicable in 1.
- **measured**: Tool: met in 3 of 17 cases, partial in 1, missing in 7, not applicable in 6.
- **measured**: Decision: met in 3 of 17 cases, partial in 9, missing in 5.
- **measured**: No case showed a per-call allow line. An allowed call is only implied by an app-level permission line; a refused call has an explicit denial line.
- **measured**: The Elasticsearch ping-siem-events index held console REST API changes only, and zero events for any of these cases. The OpenSearch gateway-events index receives LLM, AI Guard and A2A events only, and its newest event was dated 2026-10-26.
- **measured**: The LLM route logged nothing in the gateway pod log for the allowed, denied-model and injection cases, so user, agent and decision are missing for all three.
- **UNVERIFIED**: 17 more use cases (Keys, Federated identity, Approvals, Registry lifecycle) are listed but have not been measured: there is no recording and no score for them. They run only in Real mode, and the Scorecard says "not measured" until a Real run produces log lines.
- **inferred**: In Real mode each run embeds a unique marker (audit-<runid>) in the request where the case allows it, and the log entry is found by that marker first. Lines next to the marker, and calls that never log their payload (a rejected 401 logs only app, method, path and caller address), are matched by a tight time window and the app path. A time-window match is labelled inferred: other traffic in the window can be included, and a clock skew of more than a second between the lab and the log source breaks it.
- **UNVERIFIED**: The Kubernetes pod-log reader asks `kubectl proxy` for timestamps=true so each line carries a time. That the owner's cluster, pod and container (log-tailer by default) return the gateway lines in that shape has not been verified; this lab has never read a live pod log.
- **UNVERIFIED**: The X-Gw-Audit-Trail response header is described as a record with user, agent, tool and decision, returned to the caller and not stored. It was not captured in this run, so it is not scored here.
- **UNVERIFIED**: The Console Activity Log and Agent Insights were not re-checked for these cases. Earlier observations say local-proxy rows lack tool, decision and agent.
- **inferred**: The scorer calls a client name "met" for the agent only when it does not look like an OAuth client id (a UUID, long hex or a name with "oauth"). That is a heuristic: a log line cannot say whether a client is an agent.
- **UNVERIFIED**: How the agent key is presented to the gateway in Real mode (Authorization: Bearer) was not recorded in the capture.
- **inferred**: One capture on one gateway build. Results may differ by version and by configuration; re-measure before quoting them as current.
