// Builds content-pack.json for the Learning Hub from the story data and the capture, so the pack cannot drift from the lab.
//   node scripts/build-content-pack.mjs        (writes content-pack.json)
// demo.catalog is D999: the schema requires a catalog id and no catalog row truly matches this lab yet (D999 is the family's
// "no row yet" placeholder). The owner assigns the real id when the board row is made.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCapture } from '../server/src/capture.js';
import { TALK_TRACK } from '../server/src/story.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export function buildPack(capture = loadCapture()) {
  const sid = (n) => `S${String(n).padStart(2, '0')}`;
  const story = { 'say-first': 1, run: 2, trace: 3, scorecard: 4, gaps: 5, sinks: 6, real: 7, close: 8 };
  return {
    schema: 'demo-content-pack/1',
    id: 'privilege-logging-lab',
    title: 'Privilege Logging Lab',
    version,
    demo: { id: 'privilege-logging-lab', name: 'Privilege Logging Lab', catalog: 'D999', baseUrl: 'http://localhost:7801', doctor: '/api/health', tags: ['logging', 'audit-trail', 'privilege', 'mcp', 'tester', 'mock-and-real'] },
    glossary: [
      { id: 'audit-requirement', term: 'The four-clause audit requirement', definition: 'The gateway provides an end-to-end audit trail for all MCP interactions that clearly emits (a) the user on whose behalf the call was made, (b) the agent identity acting for the user, (c) which tool was called and (d) the authorization policy decision. Each use case is scored against these four.', aliases: ['audit trail'] },
      { id: 'met-partial-missing', term: 'Met, partial, missing, n/a', definition: 'Met: a log line names it. Partial: it is only implied or half there (an app-level permission line instead of a per-call allow line, an OAuth client id that names a client but not an agent). Missing: nothing in the log says it. n/a: the use case cannot have it.', aliases: ['score'] },
      { id: 'log-sink', term: 'Log sink', definition: 'A place a record could land: the gateway pod log, the X-Gw-Audit-Trail response header, the console Activity Log, an Elasticsearch index, an OpenSearch index. Only the pod log carried per-call lines in the capture.', aliases: ['sink'] },
      { id: 'unverified', term: 'UNVERIFIED', definition: 'Not measured. The lab never turns an unmeasured thing into a pass or a fail: the response header and the console were not captured, so they are labelled UNVERIFIED.', aliases: [] },
    ],
    sources: [
      { id: 'mcp-transport', title: 'Model Context Protocol: streamable HTTP transport', url: 'https://modelcontextprotocol.io/specification/2025-06-18/basic/transports', kind: 'standard', use: 'The initialize, notifications/initialized and call sequence with Mcp-Session-Id that Real mode sends.', status: 'not-read', checked: capture.capturedOn },
      { id: 'trace-context', title: 'W3C Trace Context', url: 'https://www.w3.org/TR/trace-context/', kind: 'standard', use: 'The traceparent header shown on every hop.', status: 'not-read', checked: capture.capturedOn },
    ],
    cards: [
      { id: 'try-run', label: 'Run a use case', description: 'Replay (Mock) or send (Real) any of the 17 use cases, one by one or all.', group: 'try-it', action: { type: 'route', href: '/#run' }, terms: ['audit-requirement'], story: sid(story.run) },
      { id: 'try-trace', label: 'Read the trace', description: 'The request, the response and what each sink logged, with the user, agent, tool and decision marked inline.', group: 'try-it', action: { type: 'route', href: '/#trace' }, terms: ['log-sink'], story: sid(story.trace) },
      { id: 'try-scorecard', label: 'The scorecard', description: 'Use cases by requirement clause, with a Markdown export for a customer email.', group: 'try-it', action: { type: 'route', href: '/#scorecard' }, terms: ['met-partial-missing'], story: sid(story.scorecard) },
      { id: 'concept-sinks', label: "Where it's logged", description: 'Five places a record could land, what each held, and what we cannot see.', group: 'concept', action: { type: 'route', href: '/#sinks' }, terms: ['log-sink', 'unverified'], story: sid(story.sinks) },
      { id: 'concept-diagram', label: 'Flow diagrams', description: 'One diagram per flow: caller, gateway, backend, with the log sinks hanging off the gateway.', group: 'concept', action: { type: 'route', href: '/#diagram' }, story: sid(story['say-first']) },
      { id: 'ref-doctor', label: 'Doctor and health', description: 'Preflight checks and the demo-health/1 endpoint.', group: 'setup', action: { type: 'route', href: '/api/health' } },
    ],
    stories: TALK_TRACK.map((t) => ({ id: sid(story[t.id]), title: t.title, say: t.say })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(ROOT, 'content-pack.json'), `${JSON.stringify(buildPack(), null, 2)}\n`);
}
