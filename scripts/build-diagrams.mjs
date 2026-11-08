// Builds server/diagrams/*.json (format diagram-studio/1, the family's shared diagram data) from the measured capture, so a diagram
// can never claim a sink logged something the capture says it did not. One diagram per flow (group):
// caller -> Privilege gateway -> backend, with the five log sinks hanging off the gateway.
//   node scripts/build-diagrams.mjs        (writes server/diagrams/<name>.json; the test fails if they drift)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCapture } from '../server/src/capture.js';
import { validateDiagram } from '../server/src/diagramStudioValidate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FLOWS = [
  { name: 'mcp', group: 'MCP', backend: 'MCP server (one app)', title: 'MCP tool call through the gateway', forwards: 'The gateway forwards allowed calls to the MCP server and filters the tool list on the way back.' },
  { name: 'ai-guard', group: 'AI Guard', backend: 'MCP server (one app)', title: 'AI Guard on the MCP path', forwards: 'The gateway forwards the call; AI Guard inspects the response and can block it.' },
  { name: 'rejected', group: 'Rejected', backend: null, title: 'A call with no usable credential', forwards: null },
  { name: 'aggregate', group: 'Aggregate', backend: 'Member MCP servers', title: 'Aggregate door (several MCP servers behind one route)', forwards: 'The gateway fans the call out to the member apps and prefixes their tools.' },
  { name: 'a2a', group: 'A2A', backend: 'A2A agent', title: 'Agent-to-agent (A2A) call', forwards: 'The gateway resolves the app and dials the A2A agent.' },
  { name: 'llm', group: 'LLM', backend: 'LLM provider', title: 'LLM call through the gateway', forwards: 'The gateway forwards the model request to the provider.' },
  { name: 'intent', group: 'Intent', backend: 'Intent encoder', title: 'Intent encoder not reachable', forwards: 'The gateway probes the intent encoder on each request.' },
];

// Caller, gateway and backend on one row; the five sinks on a row below the gateway, so the arrows fan out without crossing the boxes.
const SINK_POS = { 'gateway-log': [0, 330], response: [230, 330], console: [460, 330], elasticsearch: [690, 330], opensearch: [920, 330] };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function buildDiagram(flow, capture) {
  const cases = capture.cases.filter((c) => c.group === flow.group);
  const sinks = capture.sinks;
  const nodes = [
    { id: 'caller', label: 'Caller: agent key or signed-in user', group: 'caller', x: 130, y: 120 },
    { id: 'gateway', label: 'Privilege gateway', group: 'gateway', x: 460, y: 120 },
    ...(flow.backend ? [{ id: 'backend', label: flow.backend, group: 'backend', x: 790, y: 120 }] : []),
    ...sinks.map((s) => ({ id: s.id, label: s.name, group: s.unverified ? 'unverified' : 'sink', x: SINK_POS[s.id]?.[0] ?? 0, y: SINK_POS[s.id]?.[1] ?? 480 })),
  ];
  const edges = []; const steps = [];
  const step = (source, target, label, title, what, dashed) => { edges.push({ source, target, label, ...(dashed ? { dashed: true } : {}) }); steps.push({ title, what: clip(what, 590), edges: [edges.length - 1] }); };
  const reqs = cases.map((c) => `${c.title} (${c.outcome.http})`).join('; ');
  step('caller', 'gateway', 'request', 'The request arrives', `Cases measured in this flow: ${reqs}.`);
  if (flow.forwards) step('gateway', 'backend', 'forward', 'The gateway forwards it', flow.forwards);
  else step('gateway', 'caller', 'refused', 'The gateway refuses it', 'The call is refused at the gateway with HTTP 401, so no backend is reached.');
  for (const s of sinks) {
    const entries = cases.flatMap((c) => c.logged.filter((l) => l.source === s.id));
    const n = entries.reduce((sum, l) => sum + l.lines.length, 0);
    const notes = [...new Set(entries.map((l) => l.note).filter(Boolean))].join(' ');
    // A search that found nothing is not proof that nothing was logged; drop bare "Nothing." notes so the sentence does not repeat.
    const noneNotes = [...new Set(entries.map((l) => l.note).filter((t) => t && !/^Nothing( found)?\.?$/.test(t.trim())))].join(' ');
    const unread = s.unverified || entries.length === 0; // never read back for these cases: say so, do not claim "nothing"
    const none = !unread && n === 0;
    const label = unread ? 'not read back' : none ? 'nothing found' : `${n} line${n === 1 ? '' : 's'}`;
    const what = unread ? `${s.summary} No reading of this sink was recorded for the ${flow.group} cases (UNVERIFIED).` : none ? `No line was found here for this flow. ${noneNotes || s.summary}` : `${n} line(s) across ${entries.length} case(s). ${notes}`;
    step('gateway', s.id, label, `${s.name}: ${unread ? 'not read back' : none ? 'nothing' : `${n} line${n === 1 ? '' : 's'}`}`, what, none || unread);
  }
  return {
    schema: 'diagram-studio/1', id: `privilege-logging-${flow.name}`, title: flow.title,
    lede: `What each log sink held for the ${flow.group} cases measured on ${capture.capturedOn}. Dashed arrows mean nothing was found or the sink was not measured.`,
    groups: { caller: { label: 'Caller', color: 'grey' }, gateway: { label: 'Privilege gateway', color: 'red' }, backend: { label: 'Backend', color: 'blue' }, sink: { label: 'Log sinks (measured)', color: 'dark' }, unverified: { label: 'Log sinks (not measured, UNVERIFIED)', color: 'amber' } },
    nodes, edges, steps,
  };
}

export function buildDiagrams(capture = loadCapture()) {
  const out = {};
  for (const f of FLOWS) {
    const d = buildDiagram(f, capture);
    const problems = validateDiagram(d);
    if (problems.length) throw new Error(`diagram ${f.name}: ${problems.join('; ')}`);
    out[f.name] = d;
  }
  return out;
}

// The Requirement 9 tab's relationship view: the four parts one policy decision record carries, and the approval hold joined by
// Data.RequestID. Field names only; the tab fills each box with the selected record's values at runtime.
export function buildReq9Diagram() {
  return {
    schema: 'diagram-studio/1', id: 'privilege-logging-req9', title: 'The relationship one decision record carries',
    lede: 'One policy-decision-log record holds all four parts of requirement 9. Data.RequestID ties the decision to the approval hold that follows it. Pick a record to fill the boxes with its values.',
    groups: { caller: { label: 'Who (a, b)', color: 'grey' }, backend: { label: 'What (c)', color: 'blue' }, gateway: { label: 'Decision (d)', color: 'red' }, sink: { label: 'Linked record', color: 'dark' } },
    nodes: [
      { id: 'user', label: 'a · User', group: 'caller', x: 0, y: 60, sub: ['Data.User', 'Data.PrincipalKind'] },
      { id: 'agent', label: 'b · Agent', group: 'caller', x: 250, y: 60, sub: ['Data.AgentKey'] },
      { id: 'tool', label: 'c · Tool', group: 'backend', x: 500, y: 60, sub: ['Data.Target · Data.Method', 'on Data.App'] },
      { id: 'decision', label: 'd · Decision', group: 'gateway', x: 750, y: 60, sub: ['Data.Decision · Data.Reason', 'Data.PolicyIDs'] },
      { id: 'approval', label: 'policy_approval_required', group: 'sink', x: 750, y: 300, sub: ['same Data.RequestID'] },
    ],
    edges: [
      { source: 'user', target: 'agent', label: 'on behalf of' },
      { source: 'agent', target: 'tool', label: 'calls' },
      { source: 'tool', target: 'decision', label: 'judged by' },
      { source: 'decision', target: 'approval', label: 'Data.RequestID joins them', dashed: true },
    ],
    steps: [
      { title: 'a · the user', what: 'Data.User names the user the call was made for; Data.PrincipalKind says whether it is a person (User) or a workload (NonHumanIdentity).', edges: [0] },
      { title: 'b · the agent', what: "Data.AgentKey names the agent access key the call came in with. A call that carried the user's own token has no agent key, so nothing names the agent.", edges: [1] },
      { title: 'c · the tool', what: 'Data.Target is the tool, Data.Method the MCP method (tools/call) and Data.App the MCP app it was called on.', edges: [2] },
      { title: 'd · the decision', what: 'Data.Decision (deny, hitl, allow), Data.Reason and Data.PolicyIDs: what the policy said and which policy said it. The approval hold that follows carries the same Data.RequestID (dashed: a separate record).', edges: [3] },
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(ROOT, 'server/diagrams', 'req9.json'), `${JSON.stringify(buildReq9Diagram(), null, 2)}\n`);
  for (const [name, d] of Object.entries(buildDiagrams())) fs.writeFileSync(path.join(ROOT, 'server/diagrams', `${name}.json`), `${JSON.stringify(d, null, 2)}\n`);
  console.log('wrote server/diagrams/*.json');
}
