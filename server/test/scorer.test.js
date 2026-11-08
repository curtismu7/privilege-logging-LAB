import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, loadCapture } from '../src/capture.js';
import { MAX_LINE, MAX_LINES, RANK, diffScores, looksLikeOAuthClient, scoreLines } from '../src/scorer.js';
import { naFields } from '../src/lab.js';
import { parsePaste } from '../src/logparse.js';

const capture = loadCapture();
const linesOf = (c) => c.logged.flatMap((l) => l.lines);
const scoreCase = (c, lines = linesOf(c)) => scoreLines(lines, { na: naFields(c) });

// The recorded assessment looked at more of the log than the sample lines kept in the capture, and judged some records on their own.
// These are the ONLY differences between the scorer (run on the sample lines) and the recorded score. The list is pinned so it cannot grow silently.
const DOCUMENTED_DIFFERENCES = {
  'mcp-tool-not-granted': { agent: ['partial', 'met'] },        // the key name is on the previous record; the scorer sees both lines of the window
  'mcp-list-filtered': { user: ['met', 'missing'], agent: ['partial', 'missing'] }, // the sample keeps only the "Removing unauthorized" lines
  'mcp-arg-injection': { user: ['met', 'missing'], agent: ['met', 'missing'], decision: ['partial', 'missing'] }, // sample keeps one line
  'aggregate-allowed': { decision: ['missing', 'partial'] },    // the app-level capabilities line is present; the assessment still called it missing
  'a2a-call': { agent: ['partial', 'missing'] },                // the sample keeps no client line
};

test('the scorer reproduces the recorded score for every case except the five documented differences', () => {
  const found = {};
  for (const c of capture.cases) {
    const diff = diffScores(c.score, scoreCase(c).score);
    if (Object.keys(diff).length) found[c.id] = diff;
  }
  assert.deepEqual(found, DOCUMENTED_DIFFERENCES);
});

test('every documented difference is disclosed in that field\'s score note, so the Scorecard and the Markdown export carry it', () => {
  for (const [id, diff] of Object.entries(DOCUMENTED_DIFFERENCES)) {
    const c = capture.cases.find((x) => x.id === id);
    for (const f of Object.keys(diff)) assert.match(c.scoreNotes[f] || '', /scorer/, `${id}.${f} has no note saying the scorer differs`);
  }
});

test('the capture stores only log lines in lines: no annotation such as "(no ... line)" posing as a recorded line', () => {
  for (const c of capture.cases) for (const l of c.logged) for (const t of l.lines) assert.ok(!/^\(.*\)$/.test(t.trim()), `${c.id}/${l.source}: ${t}`);
});

test('every tools/list case scores tool as n/a: a list call calls no tool', () => {
  const lists = capture.cases.filter((c) => c.request.method === 'tools/list');
  assert.ok(lists.length >= 5);
  for (const c of lists) assert.equal(c.score.tool, 'na', c.id);
});

test('not-applicable fields come only from the caller, never from lines', () => {
  const r = scoreLines(['MCP call detected for method tools with target: get_weather'], { na: ['tool'] });
  assert.equal(r.score.tool, 'na');
  assert.deepEqual(r.evidence.tool, []);
  assert.equal(scoreLines(['x'], { na: ['nonsense'] }).score.user, 'missing');
});

test('removing a line never raises a score, and removing every evidence line for a field drops it to missing', () => {
  for (const c of capture.cases) {
    const lines = linesOf(c);
    const full = scoreCase(c, lines);
    lines.forEach((_, i) => {
      const less = scoreCase(c, lines.filter((__, j) => j !== i));
      for (const f of FIELDS) if (full.score[f] !== 'na') assert.ok(RANK[less.score[f]] <= RANK[full.score[f]], `${c.id} line ${i} ${f}`);
    });
    for (const f of FIELDS) {
      if (full.score[f] === 'na' || full.score[f] === 'missing') continue;
      const witness = new Set(full.evidence[f].map((e) => e.line));
      const stripped = scoreCase(c, lines.filter((_, j) => !witness.has(j)));
      assert.equal(stripped.score[f], 'missing', `${c.id}: ${f} survives removing its evidence lines`);
    }
  }
});

test('mutation: removing the line that names the tool drops tool from met', () => {
  const c = capture.cases.find((x) => x.id === 'mcp-allowed-key');
  const lines = linesOf(c);
  assert.equal(scoreCase(c, lines).score.tool, 'met');
  assert.equal(scoreCase(c, lines.filter((l) => !l.includes('target:'))).score.tool, 'missing');
});

test('mutation: blanking the user id drops user; an empty or anonymous user is not evidence', () => {
  assert.equal(scoreLines(['Access token found for user: abc-123, client: lab-agent-key']).score.user, 'met');
  assert.equal(scoreLines(['Access token found for user: , client: lab-agent-key']).score.user, 'missing');
  assert.equal(scoreLines(['{"User":"anonymous"}']).score.user, 'missing');
  assert.equal(scoreLines(['{"User":""}']).score.user, 'missing');
});

test('agent: a named key is met, an OAuth client id or a bare agent=true is partial, nothing is missing', () => {
  assert.equal(scoreLines(['Access token found for user: u1, client: lab-agent-key']).score.agent, 'met');
  assert.equal(scoreLines(['Access token found for user: u1, client: 123e4567-e89b-12d3-a456-426614174000']).score.agent, 'partial');
  assert.equal(scoreLines(['Access token found for user: u1, client: <oauth-client-id>']).score.agent, 'partial');
  assert.equal(scoreLines(['[mcpgw] policy denied u1 access to app (agent=true): Access Denied for ']).score.agent, 'partial');
  assert.equal(scoreLines(['[mcpgw] policy denied u1 access to app (agent=false): Access Denied for ']).score.agent, 'missing');
  assert.equal(scoreLines(['unrelated line']).score.agent, 'missing');
  assert.ok(looksLikeOAuthClient('0123456789abcdef0123456789abcdef'));
  assert.ok(!looksLikeOAuthClient('lab-agent-key'));
});

test('decision: an explicit denial is met; an app-level permission line is only partial; an auth refusal is partial', () => {
  assert.equal(scoreLines(['[mcpgw] policy denied u1 access to demo-mcp-app (agent=true): Access Denied for ']).score.decision, 'met');
  assert.equal(scoreLines(['Principal {User u1} has permission for {Application demo-mcp-app}']).score.decision, 'partial');
  assert.equal(scoreLines(['[mcpgw] auth rejected: reason=token_not_found app=a method=POST']).score.decision, 'partial');
  assert.equal(scoreLines(['MCP call detected for method tools with target: get_weather']).score.decision, 'missing');
});

// One pattern per line, so each rule is pinned on its own.
test('decision rules, one at a time', () => {
  const d = (line) => scoreLines([line]).score.decision;
  assert.equal(d('[mcpgw] policy denied u1 access to demo-mcp-app'), 'met', 'policy denied alone');
  assert.equal(d('[mcpgw] Access Denied for x'), 'met', 'Access Denied on a gateway line');
  assert.equal(d('level=warning msg="Access Denied for something unrelated to authz"'), 'partial', 'Access Denied off a gateway line is not a policy verdict');
  assert.equal(d('aiguard: blocked mcp response client=k category=malicious_content'), 'partial', 'a guardrail block is not an authorization decision');
  assert.equal(d('{"Event":"mcp_response_blocked"}'), 'partial', 'a block event is not an authorization decision');
  assert.equal(d('{"Event":"request_rejected"}'), 'partial', 'a rejected event is not an authorization decision');
  assert.equal(d('{"Event":"policy_denied"}'), 'met', 'a denied event is a verdict');
  assert.equal(d('{"Event":"tool_forbidden"}'), 'met', 'a forbidden event is a verdict');
  assert.equal(d('{"Event":"tool_called"}'), 'missing', 'an ordinary event is no decision');
  assert.equal(d('[mcpgw] aiintent: configuration <id> is not usable, intent signals stay unavailable'), 'missing', 'an intent-unavailable warning carries no verdict');
  assert.equal(d('[mcpgw] aiintent: verdict ok'), 'missing');
  for (const v of ['allow', 'deny', 'permit', 'forbid', 'blocked', 'hitl', 'approval_required', 'held']) assert.equal(d(`decision=${v}`), 'met', `decision=${v}`);
  assert.equal(d('decision=pending'), 'partial');
});

test('user, agent and empty-value rules, one at a time', () => {
  assert.equal(scoreLines(['sub=u1']).score.user, 'met', 'the sub key names the user');
  assert.equal(scoreLines(['user=undefined']).score.user, 'missing', '"undefined" is not a user');
  assert.equal(scoreLines(['client=my-oauth-app']).score.agent, 'partial', 'a client named oauth is the OAuth client');
  assert.ok(looksLikeOAuthClient('my-oauth-app') && !looksLikeOAuthClient('my-web-app'));
  const named = scoreLines(['Access token found for user: 5f1c, client: my-web-app']).evidence.agent[0];
  assert.equal(named.level, 'met');
  assert.match(named.why, /cannot prove the client is an agent/, 'the reason does not overclaim that a bare client name is an agent');
});

test('bounds, one at a time: the first MAX_LINES lines are kept, JSON deeper than 5 levels and past the node budget is not read', () => {
  const lines = [...Array.from({ length: MAX_LINES }, () => 'x'), 'MCP call detected for method tools with target: t'];
  assert.equal(scoreLines(lines).score.tool, 'missing', 'the line after the cap is not read');
  assert.equal(scoreLines(lines.slice(1)).score.tool, 'met', 'the last line within the cap is read');
  const nest = (depth) => { let o = { user: 'u1' }; for (let i = 0; i < depth; i += 1) o = { a: o }; return JSON.stringify(o); };
  assert.equal(scoreLines([nest(5)]).score.user, 'met', 'depth 5 is read');
  assert.equal(scoreLines([nest(6)]).score.user, 'missing', 'depth 6 is not read');
  // z is pushed first, so the walk reaches it last: 10 x 50 nodes in front of it use up the 400-node budget (the line stays under MAX_LINE).
  const wide = (n) => JSON.stringify({ z: { user: 'u1' }, a: Array.from({ length: n }, () => Array.from({ length: 50 }, () => ({}))) });
  assert.ok(wide(10).length < MAX_LINE);
  assert.equal(scoreLines([wide(10)]).score.user, 'missing', 'the node budget stops the walk');
  assert.equal(scoreLines([wide(2)]).score.user, 'met', 'under the budget the record is read');
  const pad = 'x'.repeat(MAX_LINE - 'MCP call detected for method tools with target: t'.length);
  assert.equal(scoreLines([`${pad}MCP call detected for method tools with target: t`]).score.tool, 'met', 'a line exactly at the cap is read in full');
});

test('logrus text lines are read: key=value pairs, quoted msg, and the markers inside a quoted msg', () => {
  const r = scoreLines([
    'time="2026-11-07T10:00:00Z" level=info msg="Access token found for user: u-9, client: lab-agent-key"',
    'time="2026-11-07T10:00:00Z" level=info msg="decision made" decision=allow tool=get_weather',
  ]);
  assert.deepEqual([r.score.user, r.score.agent, r.score.tool, r.score.decision], ['met', 'met', 'met', 'met']);
  // spans point at the value inside the line
  const user = r.evidence.user[0];
  assert.equal('time="2026-11-07T10:00:00Z" level=info msg="Access token found for user: u-9, client: lab-agent-key"'.slice(user.start, user.end), 'u-9');
});

test('JSON records are read, with or without a text prefix, and a tools/call payload names the tool', () => {
  const rec = '{"Event":"mcp_response_blocked","Client":"lab-agent-key","User":"u-1","Category":"x"}';
  assert.deepEqual(Object.values(scoreLines([rec]).score), ['met', 'met', 'missing', 'partial']); // a guardrail block event is not an authorization decision
  assert.equal(scoreLines([`Received HTTP request ${rec}`]).score.user, 'met');
  const payload = 'incoming request: POST /mcp ... payload: {"method":"tools/call","params":{"name":"get_weather","arguments":{}}}';
  assert.equal(scoreLines([payload]).score.tool, 'met');
  assert.equal(scoreLines(['{"decision":"deny","tool":"x"}']).score.decision, 'met');
  assert.equal(scoreLines(['{"decision":"maybe"}']).score.decision, 'partial');
});

test('the pasted-log path uses the same scorer: pasted fixture lines score exactly like the fixture lines', () => {
  const c = capture.cases.find((x) => x.id === 'mcp-allowed-key');
  const text = linesOf(c).join('\n');
  assert.deepEqual(scoreLines(parsePaste(text).lines, { na: naFields(c) }).score, scoreCase(c).score);
  const es = JSON.stringify({ hits: { hits: linesOf(c).map((m) => ({ _source: { message: m } })) } });
  assert.deepEqual(scoreLines(parsePaste(es).lines, { na: naFields(c) }).score, scoreCase(c).score);
});

test('hostile input: huge lines, huge line counts, ReDoS-shaped text and deep JSON all finish fast and bounded', () => {
  const t0 = Date.now();
  const nasty = [
    'a'.repeat(5_000_000), `${'a='.repeat(200_000)}`, `${'"'.repeat(100_000)}`, `{${'"a":'.repeat(50_000)}`, `${'['.repeat(100_000)}`, `${'{"a":'.repeat(20_000)}1${'}'.repeat(20_000)}`,
    `Access token found for user: ${'x'.repeat(1_000_000)}`, `client: ${' '.repeat(1_000_000)}`, 'key=' + '\\'.repeat(100_000), '{"__proto__":{"user":"x"},"constructor":{"prototype":{}}}',
  ];
  const r = scoreLines(nasty);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.equal(r.lines, nasty.length);
  const many = scoreLines(Array.from({ length: 50_000 }, () => 'MCP call detected for method tools with target: t'));
  assert.equal(many.lines, MAX_LINES);
  assert.equal(many.truncated, true);
  assert.ok(many.evidence.tool.every((e) => e.line < MAX_LINES));
  assert.equal({}.user, undefined, 'prototype not polluted');
});

test('a line longer than the cap is truncated, not scanned past the cap', () => {
  const r = scoreLines([`${'x'.repeat(MAX_LINE + 10)} MCP call detected for method tools with target: t`]);
  assert.equal(r.score.tool, 'missing');
});

test('non-array and non-string input is tolerated', () => {
  assert.doesNotThrow(() => scoreLines(null));
  assert.doesNotThrow(() => scoreLines([null, 5, {}, undefined, ['x']]));
  assert.equal(scoreLines('text').lines, 0);
});

test('parsePaste: bounds, blank lines, and an oversize paste is refused', () => {
  assert.deepEqual(parsePaste('  \n\n a \n b\r\n').lines, ['a', 'b']);
  assert.match(parsePaste('x'.repeat(300_000)).problem, /over/);
  assert.equal(parsePaste(Array.from({ length: 2000 }, (_, i) => `l${i}`).join('\n')).lines.length, MAX_LINES);
  assert.equal(parsePaste(5).problem, 'text must be a string');
  assert.deepEqual(parsePaste('[not json').lines, ['[not json']);
});

test('pasted lines are redacted before they are scored or shown, and the user, agent and tool values survive', () => {
  const p = parsePaste('Access token found for user: u-1, client: lab-agent-key Authorization: Bearer abcdefgh12345678\nsecret=hunter2222 and eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln');
  assert.ok(!p.lines.join('\n').includes('abcdefgh12345678') && !p.lines.join('\n').includes('hunter2222') && !p.lines.join('\n').includes('eyJhbGci'));
  assert.equal(scoreLines(p.lines).score.user, 'met'); assert.equal(scoreLines(p.lines).score.agent, 'met');
});
