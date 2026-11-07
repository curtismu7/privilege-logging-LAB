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
