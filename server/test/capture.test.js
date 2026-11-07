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
