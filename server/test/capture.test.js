import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, GROUPS, LEVELS, loadCapture, validateCapture } from '../src/capture.js';

const fresh = () => structuredClone(loadCapture());

test('the measured capture loads and has the shape the lab relies on', () => {
  const d = loadCapture();
  assert.equal(d.schema, 'privilege-logging-capture/1');
  assert.equal(d.capturedOn, '2026-11-07');
  assert.equal(d.cases.length, 17);
  assert.equal(d.sinks.length, 5);
  assert.equal(d.requirement.length, 4);
  assert.deepEqual([...new Set(d.cases.map((c) => c.group))].sort(), [...GROUPS].sort());
  for (const c of d.cases) for (const f of FIELDS) assert.ok(LEVELS.includes(c.score[f]), `${c.id}.${f}`);
});

test('the response sink is marked unverified (it was not captured)', () => {
  assert.equal(loadCapture().sinks.find((s) => s.id === 'response').unverified, true);
});

test('a sink that no case was read for is marked unverified, so no page reads "held nothing" for it', () => {
  const d = loadCapture();
  for (const s of d.sinks) if (!d.cases.some((c) => c.logged.some((l) => l.source === s.id))) assert.equal(s.unverified, true, s.id);
});

const bad = [
  ['wrong schema', (d) => { d.schema = 'x'; }, /schema must be/],
  ['bad date', (d) => { d.capturedOn = 'yesterday'; }, /capturedOn/],
  ['three requirement clauses', (d) => { d.requirement.pop(); }, /requirement/],
  ['duplicate case id', (d) => { d.cases[1].id = d.cases[0].id; }, /duplicate id/],
  ['unknown group', (d) => { d.cases[0].group = 'Other'; }, /group must be/],
  ['score value outside the set', (d) => { d.cases[0].score.user = 'great'; }, /score needs exactly/],
  ['score missing a field', (d) => { delete d.cases[0].score.tool; }, /score needs exactly/],
  ['extra score field', (d) => { d.cases[0].score.extra = 'met'; }, /score needs exactly/],
  ['log line from an unknown sink', (d) => { d.cases[0].logged[0].source = 'nope'; }, /known sink id/],
  ['lines not text', (d) => { d.cases[0].logged[0].lines = [1]; }, /lines must be/],
  ['outcome without http', (d) => { delete d.cases[0].outcome.http; }, /outcome needs/],
  ['a real-looking host', (d) => { d.cases[0].logged[0].lines.push('GET https://gateway.corp.net/x'); }, /non-reserved hosts/],
  ['a real-looking uuid', (d) => { d.cases[0].logged[0].lines.push('user 123e4567-e89b-12d3-a456-426614174000'); }, /UUID/],
  ['scoreNotes key not a field', (d) => { d.cases[0].scoreNotes.colour = 'x'; }, /scoreNotes/],
];
for (const [name, mutate, re] of bad) {
  test(`validator rejects: ${name}`, () => {
    const d = fresh(); mutate(d);
    assert.match(validateCapture(d).join('\n'), re);
  });
}

test('the validator never throws on hostile input', () => {
  for (const v of [null, undefined, 5, 'x', [], { cases: 'x' }, { schema: 'privilege-logging-capture/1', cases: [null], sinks: [null], requirement: null }]) assert.doesNotThrow(() => validateCapture(v));
});

// ---- real-only (not yet measured) cases ----
const pending = () => structuredClone(loadCapture().realOnly);
const withPending = (mutate) => { const d = structuredClone(loadCapture()); d.cases = pending(); mutate(d); return validateCapture(d); };

test('the unmeasured cases load as realOnly in the four new groups, with no outcome, lines or score', () => {
  const d = loadCapture();
  assert.equal(d.cases.length, 17, 'measured cases are untouched');
  assert.deepEqual([...new Set(d.realOnly.map((c) => c.group))], ['Keys', 'Federated identity', 'Approvals', 'Registry lifecycle']);
  assert.deepEqual(d.realOnly.filter((c) => c.group === 'Keys').map((c) => c.id), ['keys-revoked', 'keys-expired', 'keys-rate-limited', 'keys-no-mcp-scope']);
  assert.equal(d.realOnly.filter((c) => c.group === 'Federated identity').length, 5);
  assert.equal(d.realOnly.filter((c) => c.group === 'Approvals').length, 4);
  assert.equal(d.realOnly.filter((c) => c.group === 'Registry lifecycle').length, 4);
  for (const c of d.realOnly) { assert.equal(c.realOnly, true); assert.ok(c.needs.length); assert.equal(c.score, undefined); assert.equal(c.outcome, undefined); assert.equal(c.logged, undefined); }
  assert.ok(d.realOnly.filter((c) => c.group === 'Registry lifecycle').every((c) => c.consoleAction && c.needs.includes('console action')));
  assert.ok(new Set([...d.cases, ...d.realOnly].map((c) => c.id)).size === d.cases.length + d.realOnly.length);
});

const badPending = [
  ['recorded lines', (d) => { d.cases[0].logged = [{ source: 'gateway-log', lines: ['x'], note: '' }]; }, /must not carry recorded log lines/],
  ['a score', (d) => { d.cases[0].score = { user: 'met', agent: 'met', tool: 'met', decision: 'met' }; }, /must not carry a score/],
  ['score notes', (d) => { d.cases[0].scoreNotes = {}; }, /must not carry a score/],
  ['a recorded outcome', (d) => { d.cases[0].outcome = { http: 200, note: 'x' }; }, /recorded outcome/],
  ['no needs', (d) => { delete d.cases[0].needs; }, /say what it needs/],
  ['a measured group', (d) => { d.cases[0].group = 'MCP'; }, /group must be one of Keys/],
  ['realOnly not a boolean', (d) => { d.cases[0].realOnly = 'yes'; }, /realOnly must be true or false/],
  ['bad auth', (d) => { d.cases[0].request.auth = 'password'; }, /request\.auth/],
  ['too many needs', (d) => { d.cases[0].needs = Array(7).fill('x'); }, /needs must be up to 6/],
];
for (const [name, mutate, re] of badPending) test(`validator rejects a realOnly case with ${name}`, () => assert.match(withPending(mutate).join('\n'), re));

test('a measured case may not use a real-only group, and a measured case must still carry its score', () => {
  const d = structuredClone(loadCapture()); d.cases[0].group = 'Keys';
  assert.match(validateCapture(d).join('\n'), /group must be one of MCP/);
});

test('loadCapture refuses a pending file whose case is not realOnly or reuses a measured id', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pll-'));
  const write = (cases) => { const f = path.join(dir, 'p.json'); fs.writeFileSync(f, JSON.stringify({ schema: 'privilege-logging-capture/1', cases })); return f; };
  const ok = pending()[0];
  assert.throws(() => loadCapture(undefined, write([{ ...ok, id: 'mcp-allowed-user' }])), /reuses a measured case id/);
  assert.throws(() => loadCapture(undefined, write([{ ...ok, realOnly: false }])), /not valid|must set realOnly/);
  fs.rmSync(dir, { recursive: true });
});
