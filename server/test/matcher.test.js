import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SHOWN, MAX_SOURCE_LINES, TIGHT_MS, WINDOW_AFTER_MS, WINDOW_BEFORE_MS, appsIn, matchEntry, parseTs } from '../src/matcher.js';

// The window is a product decision, pinned with literal numbers (not the constants), so widening it fails a test: send time - 1 s to receipt + 3 s, tight span 1.5 s.
test('the window constants are pinned: 1 s before the send, 3 s after the receipt, 1.5 s around a marker line', () => {
  assert.equal(WINDOW_BEFORE_MS, 1000); assert.equal(WINDOW_AFTER_MS, 3000); assert.equal(TIGHT_MS, 1500);
});
import { redactLine } from '../src/redact.js';
import { linesFromText } from '../src/logSources.js';

const T0 = 1_000_000; const T1 = T0 + 400;
const L = (text, ts) => ({ text, ts });
const run = (lines, o = {}) => matchEntry({ lines, marker: 'audit-ab12cd34', t0: T0, t1: T1, app: 'demo-mcp-app', windowAllowed: true, ...o });

test('marker first: the line with the marker is "marker"; neighbours within the tight span and the call window are "window" (inferred)', () => {
  const r = run([
    L('Access token found for user: u1, client: k', T0 + 100),
    L('MCP call detected for method tools with target: get_weather', T0 + 110),
    L('payload {"city":"audit-ab12cd34"}', T0 + 120),
    L('someone else entirely', T0 + 120 + 1501),
    L('unrelated earlier line', T0 - 5000),
  ]);
  assert.equal(r.state, 'marker');
  assert.deepEqual(r.lines.map((x) => x.method), ['window', 'window', 'marker']);
  assert.equal(r.markerLines, 1); assert.equal(r.windowLines, 2);
  assert.ok(!r.lines.some((x) => /someone else|earlier/.test(x.text)), 'lines that do not belong to the call are not shown');
  // a neighbour exactly at the tight edge is in, one millisecond past it is out; and a line far outside the call window is out even next to the marker
  const edge = run([L('payload audit-ab12cd34', T0 + 100), L('at tight edge', T0 + 100 + 1500), L('past tight edge', T0 + 100 - 1501), L('outside call window but near', T1 + 3001)]);
  assert.deepEqual(edge.lines.map((x) => x.text), ['payload audit-ab12cd34', 'at tight edge']);
  const far = run([L('payload audit-ab12cd34', T1 + 2900), L('near marker, past the call window', T1 + 3500)]);
  assert.deepEqual(far.lines.map((x) => x.text), ['payload audit-ab12cd34']);
});

test('a line carrying ANOTHER run\'s marker is not this call\'s marker line (every marker starts with "audit-")', () => {
  const r = run([L('payload {"city":"audit-ab99ffff"}', T0 + 50)], { windowAllowed: false });
  assert.equal(r.state, 'none'); assert.deepEqual(r.lines, []);
  const w = run([L('payload {"city":"audit-ab99ffff"}', T0 + 50)]);
  assert.ok(!w.lines.some((x) => x.method === 'marker'), 'a foreign marker is never an exact match');
});

test('a neighbour more than the tight span BEFORE the marker line is excluded, even inside the call window', () => {
  const r = run([L('early neighbour, inside the call window', T0 - 900), L('close neighbour before', T0 + 1500 - 1400), L('payload audit-ab12cd34', T0 + 1500)]);
  assert.deepEqual(r.lines.map((x) => x.text), ['close neighbour before', 'payload audit-ab12cd34']);
});

test('marker not logged: falls back to the call window, every line "window" (inferred), edges inclusive', () => {
  const r = run([
    L('before the window', T0 - 1001),
    L('at the start edge', T0 - 1000),
    L('inside', T0 + 50),
    L('at the end edge', T1 + 3000),
    L('after the window', T1 + 3001),
  ]);
  assert.equal(r.state, 'window');
  assert.deepEqual(r.lines.map((x) => x.text), ['at the start edge', 'inside', 'at the end edge']);
  assert.ok(r.lines.every((x) => x.method === 'window'));
});

test('the window fallback waits: with windowAllowed false and no marker the answer is "none" (the marker may still appear)', () => {
  const r = run([L('inside', T0 + 50)], { windowAllowed: false });
  assert.equal(r.state, 'none'); assert.deepEqual(r.lines, []);
});

test('lines without a timestamp are never window-matched, only marker-matched', () => {
  assert.equal(run([L('no clock here', null)]).state, 'none');
  const r = run([L('payload audit-ab12cd34', null), L('neighbour', null)]);
  assert.equal(r.state, 'marker'); assert.deepEqual(r.lines.map((x) => x.method), ['marker']);
});

test('a line that names ANOTHER app is not this call, in both methods', () => {
  const lines = [L('policy denied u1 access to other-app (agent=true)', T0 + 10), L('mine path=/demo-mcp-app/mcp', T0 + 10), L('payload audit-ab12cd34', T0 + 10)];
  assert.ok(!run(lines).lines.some((x) => /other-app/.test(x.text)));
  assert.ok(!run(lines.slice(0, 2)).lines.some((x) => /other-app/.test(x.text)));
  assert.deepEqual(run(lines.slice(0, 2)).lines.map((x) => x.text), ['mine path=/demo-mcp-app/mcp']);
});

test('a Rejected call logs only app, method, path and address: the window match must name the app path', () => {
  const lines = [L('[mcpgw] auth rejected: reason=token_not_found app=demo-mcp-app method=POST path=/demo-mcp-app/mcp remote=<ip>', T0 + 20), L('Access token found for user: bystander, client: other', T0 + 30)];
  const r = run(lines, { rejected: true });
  assert.equal(r.state, 'window'); assert.equal(r.lines.length, 1); assert.match(r.lines[0].text, /auth rejected/);
  assert.equal(run([lines[1]], { rejected: true }).state, 'none');
});

test('since (console actions): everything between the chosen time and now, labelled window', () => {
  const r = matchEntry({ lines: [L('old', 1000), L('key created', 5000), L('key revoked', 6000)], marker: null, t0: 5500, t1: 9000, app: null, windowAllowed: true, since: 4000 });
  assert.deepEqual(r.lines.map((x) => x.text), ['key created', 'key revoked']);
});

test('hostile input is bounded: 200k lines, a 5 MB line, a thousand marker hits', () => {
  const t = Date.now();
  const many = Array.from({ length: 200_000 }, (_, i) => L(`line ${i}`, T0 + 10));
  const r = run(many);
  assert.ok(r.lines.length <= MAX_SHOWN);
  assert.ok(r.ignored <= MAX_SOURCE_LINES);
  const big = run([L('x'.repeat(5_000_000), T0 + 10), ...Array.from({ length: 1000 }, () => L('audit-ab12cd34', T0 + 10))]);
  assert.ok(big.lines.length <= MAX_SHOWN);
  assert.ok(Date.now() - t < 5000, `${Date.now() - t} ms`);
});

test('parseTs: kubectl prefix, logrus time pair, and none', () => {
  assert.deepEqual(parseTs('2026-11-07T10:00:00.123456789Z hello world'), { ts: Date.parse('2026-11-07T10:00:00.123Z'), rest: 'hello world' });
  assert.equal(parseTs('time="2026-11-07T10:00:00Z" level=info msg="x"').ts, Date.parse('2026-11-07T10:00:00Z'));
  assert.equal(parseTs('no time here').ts, null);
  assert.equal(parseTs('9999-99-99T99:99:99 bad').ts, null);
});

test('appsIn finds app names after the known prefixes and nothing else', () => {
  assert.deepEqual([...appsIn('[mcpgw] policy denied u access to other-app (agent=true) path=/third/mcp app=demo-mcp-app {Application fourth}')].sort(), ['demo-mcp-app', 'fourth', 'other-app', 'third']);
  assert.equal(appsIn('a'.repeat(100_000) + ' app=').size, 0);
});

test('redactLine masks bearer tokens, JWTs, key/secret/password values; ordinary text and user ids survive; ReDoS-shaped input is fast', () => {
  const t = Date.now();
  assert.equal(redactLine('Authorization: Bearer abc.def-123_456'), 'Authorization: Bearer ***');
  assert.match(redactLine('token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln here'), /\*\*\*jwt\*\*\*/);
  assert.equal(redactLine('api_key=placeholdervalue ok'), 'api_key=*** ok');
  assert.equal(redactLine('{"client_secret":"hunter22","user":"u-1"}'), '{"client_secret":"***","user":"u-1"}');
  assert.equal(redactLine('Access token found for user: u-9, client: audit-test'), 'Access token found for user: u-9, client: audit-test');
  redactLine(`Bearer ${'a'.repeat(4000)}`); redactLine(`${'password '.repeat(500)}`); redactLine(`${'eyJ'.repeat(1300)}`);
  assert.ok(Date.now() - t < 1000);
});

test('linesFromText: kubectl timestamps become ts, tokens are redacted, only the newest lines are kept', () => {
  const l = linesFromText('2026-11-07T10:00:00Z Authorization: Bearer abcdefgh12345\n\n2026-11-07T10:00:01Z plain');
  assert.deepEqual(l.map((x) => x.text), ['Authorization: Bearer ***', 'plain']);
  assert.equal(l[1].ts, Date.parse('2026-11-07T10:00:01Z'));
  assert.equal(linesFromText(Array.from({ length: 20_000 }, (_, i) => `l${i}`).join('\n')).length, MAX_SOURCE_LINES);
});
