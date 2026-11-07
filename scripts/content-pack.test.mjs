import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPack } from './build-content-pack.mjs';
import { TALK_TRACK } from '../server/src/story.js';
import { validatePack } from './validate-content-pack.mjs';

const root = new URL('..', import.meta.url);
const committed = JSON.parse(fs.readFileSync(new URL('content-pack.json', root), 'utf8'));

test('the pack validates against the schema and its cross-references hold', () => {
  assert.deepEqual(validatePack(buildPack()), []);
});

test('the committed content-pack.json is exactly what the builder makes (no drift)', () => {
  assert.deepEqual(committed, buildPack());
});

test('every story is used by a card, and every card with a story points at one', () => {
  const pack = buildPack();
  assert.equal(pack.stories.length, TALK_TRACK.length);
  assert.ok(pack.cards.filter((c) => c.story).length >= 5);
  for (const c of pack.cards.filter((x) => x.story)) assert.ok(pack.stories.some((s) => s.id === c.story), c.id);
});

test('a broken pack is caught: unknown term, unknown story, missing required field', () => {
  const pack = buildPack();
  pack.cards[0].terms = ['nope'];
  pack.cards[1].story = 'ghost';
  delete pack.demo.catalog;
  const errors = validatePack(pack).join('\n');
  assert.match(errors, /unknown term nope/);
  assert.match(errors, /unknown story ghost/);
  assert.match(errors, /catalog/);
});

test('the pack links only to the two standards pages (and localhost)', () => {
  const t = JSON.stringify(buildPack()).toLowerCase();
  const urls = [...t.matchAll(/https?:\/\/[^"\s]+/g)].map((m) => new URL(m[0]).hostname);
  assert.deepEqual([...new Set(urls)].sort(), ['modelcontextprotocol.io', 'www.w3.org'].concat(urls.includes('localhost') ? ['localhost'] : []).sort());
});
