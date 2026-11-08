import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCapture } from '../src/capture.js';
import { STATUSES, TALK_TRACK, bannerMock, bannerReal, buildFacts, buildStory, renderTalkTrackMarkdown, tally } from '../src/story.js';
import { scanHosts, scanKeys } from '../src/safety.js';

const capture = loadCapture();

test('every fact carries a status, and the tallies in the facts match the capture', () => {
  const facts = buildFacts(capture);
  assert.ok(facts.every((f) => STATUSES.includes(f.status)));
  assert.ok(facts.some((f) => f.status === 'UNVERIFIED'), 'the unmeasured sinks are labelled UNVERIFIED');
  const t = tally(capture);
  const count = (f, l) => capture.cases.filter((c) => c.score[f] === l).length; // counted independently of tally()
  for (const f of ['user', 'agent', 'tool', 'decision']) for (const l of ['met', 'partial', 'missing', 'na']) assert.equal(t[f][l], count(f, l), `${f}.${l}`);
  assert.match(facts.find((f) => f.id === 'user').text, new RegExp(`met in ${count('user', 'met')} of 17 cases`));
});

test('the Mock banner says replay, the date and that nothing is sent; the Real banner says owner-run and only two origins', () => {
  assert.match(bannerMock('2026-11-07'), /Replay of transactions measured on 2026-11-07; nothing is sent\./);
  assert.match(bannerReal, /owner-run/); assert.match(bannerReal, /only to the gateway you configured/);
  assert.match(bannerReal, /kubectl proxy/, 'the Real banner names the pod-log source, which Real also contacts');
  assert.match(bannerReal, /search endpoint/);
});

test('the per-field tallies are labelled inferred: they count our scoring, not a number the gateway reports', () => {
  const facts = buildFacts(capture);
  for (const id of ['user', 'agent', 'tool', 'decision']) {
    const f = facts.find((x) => x.id === id);
    assert.equal(f.status, 'inferred', id); assert.match(f.text, /our met\/partial\/missing scoring/);
  }
});

test('the refusal fact is counted from the capture and does not claim every refusal has a denial line', () => {
  const f = buildFacts(capture).find((x) => x.id === 'no-decision-line');
  assert.doesNotMatch(f.text, /a refused call has an explicit denial line/);
  const refused = capture.cases.filter((c) => c.outcome.http >= 400 && c.outcome.http < 500);
  const pod = (c) => c.logged.filter((l) => l.source === 'gateway-log').flatMap((l) => l.lines);
  const silent = refused.filter((c) => pod(c).length === 0).length;
  assert.ok(silent > 0, 'the capture has refusals that logged nothing');
  assert.match(f.text, new RegExp(`Of the ${refused.length} refused calls`));
  assert.match(f.text, new RegExp(`${silent} \\(Aggregate and LLM\\) logged nothing`));
  assert.match(f.text, new RegExp(`${refused.filter((c) => pod(c).some((l) => l.includes('policy denied'))).length} have an explicit MCP policy-denial line`));
});

test('the sinks fact and the sample-lines fact state only what was read', () => {
  const facts = buildFacts(capture);
  const read = (id) => capture.cases.filter((c) => c.logged.some((l) => l.source === id)).length;
  const siem = facts.find((x) => x.id === 'siem').text;
  assert.doesNotMatch(siem, /any of these cases/);
  assert.match(siem, new RegExp(`${read('elasticsearch')} of 17 cases it was read for`));
  assert.match(siem, new RegExp(`read for ${read('opensearch')} cases only`));
  assert.match(facts.find((x) => x.id === 'sample-lines').text, /^For 5 of 17 cases .* 8 fields differs/);
  assert.equal(capture.sinks.find((s) => s.id === 'console').unverified, true, 'the console was never read, so it is UNVERIFIED, not "held nothing"');
  assert.equal(read('console'), 0);
});

test('the gaps talk track does not say every rejected call names nobody, and qualifies the one A2A call', () => {
  const gaps = TALK_TRACK.find((t) => t.id === 'gaps').say;
  assert.doesNotMatch(gaps, /^Rejected calls name nobody/);
  assert.match(gaps, /policy denials name the user/); assert.match(gaps, /A2A was measured on one call that failed/);
});

test('the story names no real host, key or customer', () => {
  const text = JSON.stringify(buildStory(capture));
  assert.deepEqual(scanHosts(text), []); assert.deepEqual(scanKeys(text), []);
});

test('the shipped docs/talk-track.md is exactly what the generator writes (no drift)', async () => {
  const fs = await import('node:fs');
  assert.equal(fs.readFileSync(new URL('../../docs/talk-track.md', import.meta.url), 'utf8'), renderTalkTrackMarkdown(capture));
  assert.ok(TALK_TRACK.length >= 6);
});
