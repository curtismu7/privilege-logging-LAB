import test from 'node:test';
import assert from 'node:assert/strict';
import { allPassed, runChecks } from '../src/doctor.js';
import { KEY, NOENV } from './helpers.js';

test('doctor passes on a clean checkout in Mock and reports every check by id', async () => {
  const checks = await runChecks({ env: NOENV });
  assert.ok(allPassed(checks), JSON.stringify(checks.filter((c) => c.level === 'fail')));
  for (const id of ['node', 'mode', 'real-settings', 'bind', 'port-range', 'capture', 'scorer', 'facts-labelled', 'banner', 'story-hosts', 'story-keys', 'diagrams', 'netguard', 'tenant']) assert.ok(checks.some((c) => c.id === id), id);
});

test('doctor never prints the key or its value, and fails on a bad port or a bad bind', async () => {
  const env = { ...NOENV, PRIV_LOG_GATEWAY_URL: 'https://gateway.example/demo-mcp-app/mcp', PRIV_LOG_AGENT_KEY: KEY };
  const out = JSON.stringify(await runChecks({ env }));
  assert.ok(!out.includes(KEY));
  assert.match(out, /key set \(not shown\)/);
  assert.equal(allPassed(await runChecks({ env: { ...NOENV, PORT: '7800' } })), false);
  assert.equal(allPassed(await runChecks({ env: { ...NOENV, PRIV_LOG_BIND: undefined, MODE: 'real' } })), false);
});
