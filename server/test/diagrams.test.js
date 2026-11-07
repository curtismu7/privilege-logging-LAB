import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadCapture } from '../src/capture.js';
import { DIAGRAM_NAMES, buildDiagram, loadDiagram } from '../src/diagramData.js';
import { validateDiagram } from '../src/diagramStudioValidate.js';
import { FLOWS, buildDiagrams } from '../../scripts/build-diagrams.mjs';

const capture = loadCapture();

test('one diagram per flow (group), each diagram-studio/1 valid, and the committed files are exactly what the builder makes', () => {
  assert.deepEqual(FLOWS.map((f) => f.name), DIAGRAM_NAMES);
  assert.deepEqual([...new Set(capture.cases.map((c) => c.group))].sort(), FLOWS.map((f) => f.group).sort());
  const built = buildDiagrams(capture);
  for (const n of DIAGRAM_NAMES) {
    assert.deepEqual(validateDiagram(built[n]), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(new URL(`../diagrams/${n}.json`, import.meta.url), 'utf8')), built[n], `${n} drifted: run npm run diagrams`);
    assert.deepEqual(loadDiagram(n), built[n]);
  }
});

test('every diagram walks caller -> gateway -> (backend), then each of the five sinks, and dashed means nothing found or not read back', () => {
  for (const n of DIAGRAM_NAMES) {
    const d = buildDiagram(n);
    const ids = new Set(d.nodes.map((x) => x.id));
    for (const s of capture.sinks) assert.ok(ids.has(s.id), `${n} has sink ${s.id}`);
    assert.ok(ids.has('caller') && ids.has('gateway'));
    assert.equal(d.steps.length, 2 + capture.sinks.length);
    assert.equal(d.steps[0].from, 'caller'); assert.equal(d.steps[0].to, 'gateway');
    d.steps.slice(2).forEach((s, i) => assert.equal(s.to, capture.sinks[i].id));
  }
});

test('diagrams never claim a sink logged something the capture says it did not (llm: pod log empty; header and console never claimed)', () => {
  const llm = buildDiagram('llm');
  const pod = llm.steps.find((s) => s.to === 'gateway-log');
  assert.equal(pod.dashed, true); assert.match(pod.label, /nothing/i);
  for (const n of DIAGRAM_NAMES) for (const id of ['response', 'console']) { const s = buildDiagram(n).steps.find((x) => x.to === id); assert.equal(s.dashed, true); assert.match(s.say, /UNVERIFIED/); }
  const mcp = buildDiagram('mcp');
  const lines = capture.cases.filter((c) => c.group === 'MCP').flatMap((c) => c.logged).filter((l) => l.source === 'gateway-log').reduce((n, l) => n + l.lines.length, 0);
  assert.equal(mcp.steps.find((s) => s.to === 'gateway-log').edgeLabel, `${lines} lines`);
});

test('an unknown diagram name falls back to the first one, never a path', () => {
  assert.equal(buildDiagram('../../etc/passwd').name, 'mcp');
});
