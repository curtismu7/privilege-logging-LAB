import test from 'node:test';
import assert from 'node:assert/strict';
import { allPassed, runChecks } from '../src/doctor.js';
import { KEY, NOENV } from './helpers.js';

test('doctor passes on a clean checkout in Mock and reports every check by id', async () => {
  const checks = await runChecks({ env: NOENV });
  assert.ok(allPassed(checks), JSON.stringify(checks.filter((c) => c.level === 'fail')));
  for (const id of ['node', 'mode', 'real-settings', 'log-sources', 'bind', 'port-range', 'capture', 'scorer', 'facts-labelled', 'banner', 'story-hosts', 'story-keys', 'diagrams', 'netguard', 'tenant']) assert.ok(checks.some((c) => c.id === id), id);
});

test('doctor never prints the key or its value, and fails on a bad port or a bad bind', async () => {
  const env = { ...NOENV, PRIV_LOG_GATEWAY_URL: 'https://gateway.example/demo-mcp-app/mcp', PRIV_LOG_AGENT_KEY: KEY };
  const out = JSON.stringify(await runChecks({ env }));
  assert.ok(!out.includes(KEY));
  assert.match(out, /key set \(not shown\)/);
  assert.equal(allPassed(await runChecks({ env: { ...NOENV, PORT: '7800' } })), false);
  assert.equal(allPassed(await runChecks({ env: { ...NOENV, PRIV_LOG_BIND: undefined, MODE: 'real' } })), false);
});

test('doctor reports the log sources (k8s and search) without printing the key', async () => {
  const env = { ...NOENV, PRIV_LOG_GATEWAY_URL: 'https://gateway.example/demo-mcp-app/mcp', PRIV_LOG_AGENT_KEY: KEY, PRIV_LOG_K8S_NAMESPACE: 'privilege', PRIV_LOG_K8S_POD: 'app=gw', PRIV_LOG_K8S_CONTAINER: 'gateway', PRIV_LOG_SEARCH_URL: 'https://search.example', PRIV_LOG_SEARCH_INDEX: 'events' };
  const checks = await runChecks({ env });
  const line = checks.find((c) => c.id === 'log-sources').detail;
  assert.match(line, /Kubernetes pod log via http:\/\/127\.0\.0\.1:8001 \(namespace privilege, selector app=gw, container gateway; start it with: kubectl proxy\)/);
  assert.match(line, /search endpoint https:\/\/search\.example \(index events\)/);
  assert.ok(!JSON.stringify(checks).includes(KEY));
  assert.match((await runChecks({ env: NOENV })).find((c) => c.id === 'log-sources').detail, /PRIV_LOG_K8S_PROXY_URL/);
});
