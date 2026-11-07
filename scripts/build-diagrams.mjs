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

const SINK_POS = { 'gateway-log': [320, 420], response: [0, 420], console: [640, 420], elasticsearch: [160, 580], opensearch: [480, 580] };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function buildDiagram(flow, capture) {
  const cases = capture.cases.filter((c) => c.group === flow.group);
  const sinks = capture.sinks;
  const nodes = [
    { id: 'caller', label: 'Caller: agent key or signed-in user', group: 'caller', x: 0, y: 200 },
    { id: 'gateway', label: 'Privilege gateway', group: 'gateway', x: 320, y: 200 },
    ...(flow.backend ? [{ id: 'backend', label: flow.backend, group: 'backend', x: 640, y: 200 }] : []),
    ...sinks.map((s) => ({ id: s.id, label: s.name, group: s.unverified ? 'unverified' : 'sink', x: SINK_POS[s.id]?.[0] ?? 0, y: SINK_POS[s.id]?.[1] ?? 700 })),
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
    const unread = s.unverified || entries.length === 0; // never read back for these cases: say so, do not claim "nothing"
    const none = !unread && n === 0;
    const label = unread ? 'not read back' : none ? 'nothing found' : `${n} line${n === 1 ? '' : 's'}`;
    const what = unread ? `${s.summary} No reading of this sink was recorded for the ${flow.group} cases (UNVERIFIED).` : none ? `Nothing was logged here for this flow. ${notes || s.summary}` : `${n} line(s) across ${entries.length} case(s). ${notes}`;
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, d] of Object.entries(buildDiagrams())) fs.writeFileSync(path.join(ROOT, 'server/diagrams', `${name}.json`), `${JSON.stringify(d, null, 2)}\n`);
  console.log('wrote server/diagrams/*.json');
}
