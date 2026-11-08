// The words of the lab: banners, intro, facts (each with a status), talk track. Data, not logic, so the docs and the pack are generated from it.
// Every claim about the product carries a status: measured (read from the capture), inferred (our reading), UNVERIFIED (not measured).
import { FIELDS } from './capture.js';
import { diffScores, scoreLines } from './scorer.js';

export const STATUSES = ['measured', 'inferred', 'UNVERIFIED'];

export const bannerMock = (capturedOn) => `SIMULATED. Replay of transactions measured on ${capturedOn}; nothing is sent. The log lines are recorded samples with placeholders for ids; no gateway, search endpoint or tenant is contacted.`;
export const bannerReal = 'REAL (owner-run): requests go only to the gateway you configured, and log events are read only from the log sources you configured (a Kubernetes pod log through kubectl proxy, a search endpoint, Privilege logs) or from lines you paste. Scores come from the lines actually returned; anything not seen is shown as missing, anything not checked is UNVERIFIED.';

export const INTRO = 'For each Privilege (PingOne Privilege AI gateway) use case, see what gets logged and score it against the customer requirement: the audit trail should clearly emit (a) the user on whose behalf the call was made, (b) the agent identity acting for the user, (c) which tool was called, and (d) the authorization policy decision. The point is honesty: the gaps are listed, not hidden.';

// Counts from the capture: how many of the cases meet each field fully. Used in facts and the talk track so numbers cannot drift.
export function tally(capture) {
  const out = {};
  for (const f of FIELDS) {
    const levels = capture.cases.map((c) => c.score[f]);
    out[f] = { met: levels.filter((l) => l === 'met').length, partial: levels.filter((l) => l === 'partial').length, missing: levels.filter((l) => l === 'missing').length, na: levels.filter((l) => l === 'na').length };
  }
  return out;
}

// What the capture says about refusals (HTTP 4xx), counted from the recorded lines so the sentence cannot drift from the data.
export function refusals(capture) {
  const refused = capture.cases.filter((c) => c.outcome.http >= 400 && c.outcome.http < 500);
  const linesOf = (c) => c.logged.filter((l) => l.source === 'gateway-log').flatMap((l) => l.lines);
  const has = (c, marker) => linesOf(c).some((l) => l.includes(marker));
  const denial = refused.filter((c) => has(c, 'policy denied'));
  const guard = refused.filter((c) => !has(c, 'policy denied') && has(c, 'aiguard: blocked'));
  const auth = refused.filter((c) => !has(c, 'policy denied') && !has(c, 'aiguard: blocked') && has(c, 'auth rejected'));
  const none = refused.filter((c) => linesOf(c).length === 0);
  return { refused, denial, guard, auth, none };
}

// Cases whose recorded level differs from the scorer run on the sample lines kept in the capture.
export function sampleDifferences(capture) {
  const out = [];
  for (const c of capture.cases) {
    const na = FIELDS.filter((f) => c.score[f] === 'na');
    const diff = diffScores(c.score, scoreLines(c.logged.flatMap((l) => l.lines), { na }).score);
    if (Object.keys(diff).length) out.push({ id: c.id, fields: Object.keys(diff) });
  }
  return out;
}

const readFor = (capture, sinkId) => capture.cases.filter((c) => c.logged.some((l) => l.source === sinkId));

export function buildFacts(capture) {
  const t = tally(capture);
  const n = capture.cases.length;
  const line = (f, label) => `${label}: met in ${t[f].met} of ${n} cases, partial in ${t[f].partial}, missing in ${t[f].missing}${t[f].na ? `, not applicable in ${t[f].na}` : ''}. A count of our met/partial/missing scoring of the recorded log, not a number the gateway reports.`;
  const r = refusals(capture);
  const groups = (cs) => [...new Set(cs.map((c) => c.group))].join(' and ');
  const diffs = sampleDifferences(capture);
  const es = readFor(capture, 'elasticsearch'); const os = readFor(capture, 'opensearch');
  const esMissed = capture.cases.filter((c) => !es.includes(c)).map((c) => c.id);
  return [
    { id: 'scope', status: 'measured', text: `${n} use cases were driven through the gateway on ${capture.capturedOn} and what each one logged was read back. Sources: ${capture.sources}.` },
    { id: 'user', status: 'inferred', text: line('user', 'User') },
    { id: 'agent', status: 'inferred', text: line('agent', 'Agent') },
    { id: 'tool', status: 'inferred', text: line('tool', 'Tool') },
    { id: 'decision', status: 'inferred', text: `${line('decision', 'Decision')} A guardrail block counts as partial: it is a guardrail verdict, not an authorization policy decision.` },
    { id: 'sample-lines', status: 'measured', text: `For ${diffs.length} of ${n} cases (${diffs.map((d) => d.id).join(', ')}) the recorded level of ${diffs.reduce((k, d) => k + d.fields.length, 0)} fields differs from the scorer run on the sample lines kept in the capture; each such field says so in its note.` },
    { id: 'no-decision-line', status: 'measured', text: `No case showed a per-call allow line. An allowed call is only implied by an app-level permission line. Of the ${r.refused.length} refused calls (HTTP 4xx), ${r.denial.length} have an explicit MCP policy-denial line, ${r.guard.length} an AI Guard block line, ${r.auth.length} only an auth-rejected line (a credential refusal, not a policy decision), and ${r.none.length} (${groups(r.none)}) logged nothing in the gateway pod log.` },
    { id: 'siem', status: 'measured', text: `The Elasticsearch ping-siem-events index held console REST API changes only, and zero events in the ${es.length} of ${n} cases it was read for${esMissed.length ? ` (not read for ${esMissed.join(', ')})` : ''}. The OpenSearch gateway-events index receives LLM, AI Guard and A2A events only, its newest event was dated 2026-10-26, and it was read for ${os.length} cases only (${os.map((c) => c.id).join(', ')}).` },
    { id: 'llm', status: 'measured', text: 'The LLM route logged nothing in the gateway pod log for the allowed, denied-model and injection cases, so user, agent and decision are missing for all three.' },
    { id: 'real-only', status: 'UNVERIFIED', text: `${capture.realOnly?.length ?? 0} more use cases (Keys, Federated identity, Approvals, Registry lifecycle) are listed but have not been measured: there is no recording and no score for them. They run only in Real mode, and the Scorecard says "not measured" until a Real run produces log lines.` },
    { id: 'correlation', status: 'inferred', text: 'In Real mode each run embeds a unique marker (audit-<runid>) in the request where the case allows it, and the log entry is found by that marker first. Lines next to the marker, and calls that never log their payload (a rejected 401 logs only app, method, path and caller address), are matched by a tight time window and the app path. A time-window match is labelled inferred: other traffic in the window can be included, and a clock skew of more than a second between the lab and the log source breaks it.' },
    { id: 'k8s-log', status: 'UNVERIFIED', text: 'The Kubernetes pod-log reader asks `kubectl proxy` for timestamps=true so each line carries a time. That the owner\'s cluster, pod and container (log-tailer by default) return the gateway lines in that shape has not been verified; this lab has never read a live pod log.' },
    { id: 'response-header', status: 'UNVERIFIED', text: 'The X-Gw-Audit-Trail response header is described as a record with user, agent, tool and decision, returned to the caller and not stored. It was not captured in this run, so it is not scored here.' },
    { id: 'console', status: 'UNVERIFIED', text: 'The Console Activity Log and Agent Insights were not re-checked for these cases. Earlier observations say local-proxy rows lack tool, decision and agent.' },
    { id: 'agent-vs-oauth', status: 'inferred', text: 'The scorer calls a client name "met" for the agent only when it does not look like an OAuth client id (a UUID, long hex or a name with "oauth"). That is a heuristic: a log line cannot say whether a client is an agent.' },
    { id: 'key-presentation', status: 'UNVERIFIED', text: 'How the agent key is presented to the gateway in Real mode (Authorization: Bearer) was not recorded in the capture.' },
    { id: 'one-build', status: 'inferred', text: 'One capture on one gateway build. Results may differ by version and by configuration; re-measure before quoting them as current.' },
  ];
}

export const TALK_TRACK = [
  { id: 'say-first', title: 'Start with the requirement', say: 'The customer asked for an end-to-end audit trail for every MCP interaction: who the call was for, which agent made it, which tool, and what the policy decided. This lab shows, use case by use case, what the gateway actually logged, and where it does not.' },
  { id: 'run', title: 'Run a case', say: 'Pick a case on the Run page. In Mock mode this replays a transaction we measured on the capture date; nothing is sent. In Real mode the owner sends it to their own gateway and reads the log back.' },
  { id: 'retrieval', title: 'Watch it fetch the log', say: 'Pressing Run shows a spinner: first Sending, then Fetching the log entry. The lab finds the entry by a unique marker it put in the request, and falls back to a tight time window, which it labels as inferred. If the log source is down or the entry never shows up, the page says so and offers Retry; with no log source configured you can paste the lines instead.' },
  { id: 'realonly', title: 'Cases not measured yet', say: 'Keys, Federated identity, Approvals and Registry lifecycle are listed but have no recording. In Mock they are disabled and the Scorecard says not measured. In Real you supply the credential or do the console action yourself, and the lab shows what the log recorded.' },
  { id: 'trace', title: 'Read the trace', say: 'The Trace page shows the request, the response and, per log sink, the entries that were written as coloured JSON trees, each tagged with how it was matched. The user, agent, tool and decision values are badged and underlined so the customer sees exactly which words satisfy which clause, and fields that are not in the entry are listed.' },
  { id: 'scorecard', title: 'Show the scorecard', say: 'Met means a line names it. Partial means it is only implied or only half there, for example an app-level permission line instead of a per-call allow. Missing means nothing in the log says it. Copy the table into the customer email as it is.' },
  { id: 'gaps', title: 'Say the gaps out loud', say: 'The 401 rejections and the aggregate and LLM refusals name nobody; the MCP policy denials name the user and agent=true but not the tool. Aggregate routes log almost nothing for the member calls. The LLM route logged nothing we could find. A2A was measured on one call that failed because the backend was down, so a successful A2A call is not measured. No allowed call has an explicit allow line. Naming these is what makes the rest credible.' },
  { id: 'sinks', title: 'Where it is logged', say: 'There are five places a record could land. Only the gateway pod log carried per-call lines, the SIEM index held console changes only, and the shipper to OpenSearch has not delivered since late October. The response header was not captured and the console was not read for these cases, so both are UNVERIFIED.' },
  { id: 'real', title: 'Real mode and the paste box', say: 'Real mode sends the call to the gateway you configured and queries your search endpoint for events in the call window. With no search endpoint, paste the gateway log lines and the same scorer reads them.' },
  { id: 'close', title: 'Close honestly', say: 'Offer the scorecard as the current measured state, not a promise. Anything marked UNVERIFIED is an open question, and a re-run after a gateway change updates the table.' },
];

export const PAGE_SAYS = { run: ['say-first', 'run', 'retrieval', 'realonly'], trace: ['trace', 'retrieval'], scorecard: ['scorecard', 'gaps'], sinks: ['sinks'], privilege: ['sinks'], diagram: ['say-first'], talk: [] };

export function buildStory(capture) {
  return { title: 'Privilege Logging Lab', intro: INTRO, banner: bannerMock(capture.capturedOn), realBanner: bannerReal, requirement: capture.requirement, facts: buildFacts(capture), talkTrack: TALK_TRACK, pageSays: PAGE_SAYS, capturedOn: capture.capturedOn };
}

export function renderTalkTrackMarkdown(capture) {
  const s = buildStory(capture);
  return [
    '# Talk track: Privilege Logging Lab',
    '',
    `Generated from \`server/src/story.js\` by \`npm run talk-track\`. Do not edit by hand. ${s.banner}`,
    '',
    ...TALK_TRACK.flatMap((t, i) => [`## ${i + 1}. ${t.title}`, '', t.say, '']),
    '## Facts and their status',
    '',
    ...s.facts.map((f) => `- **${f.status}**: ${f.text}`),
    '',
  ].join('\n');
}
