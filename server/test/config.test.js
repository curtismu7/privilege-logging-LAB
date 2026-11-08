import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modeFrom, parseSettings, readSettings, realAvailableFrom, realConfig, settingsFile } from '../src/config.js';
import { KEY, NOENV } from './helpers.js';
import { bindHost, assertBindAllowed, isPrivateAddress, portProblem, resolvePort, scanHosts } from '../src/safety.js';

const base = { ...NOENV, PRIV_LOG_GATEWAY_URL: 'https://gateway.example/demo-mcp-app/mcp', PRIV_LOG_AGENT_KEY: KEY };
const cfg = (extra = {}) => realConfig({ ...base, ...extra }, { file: false });

test('Real needs a gateway URL and a key; otherwise it is unavailable with a reason that names the setting', () => {
  assert.equal(realConfig(NOENV, { file: false }).ok, false);
  assert.match(realConfig(NOENV, { file: false }).problem, /PRIV_LOG_GATEWAY_URL/);
  assert.match(cfg({ PRIV_LOG_AGENT_KEY: '' }).problem, /PRIV_LOG_AGENT_KEY/);
  assert.equal(cfg().ok, true);
});

test('the gateway URL: https anywhere, http only on loopback; no credentials, query, fragment, private literals, other schemes', () => {
  for (const u of ['https://gateway.example/x', 'http://127.0.0.1:9000/x', 'http://localhost:9000/x', 'http://[::1]:9000/x', 'https://127.0.0.1:9443/x']) assert.equal(cfg({ PRIV_LOG_GATEWAY_URL: u }).ok, true, u);
  for (const u of ['http://gateway.example/x', 'ftp://gateway.example/', 'file:///etc/passwd', 'https://user:pw@gateway.example/', 'https://gateway.example/x?a=1', 'https://gateway.example/x#f',
    'https://169.254.169.254/latest', 'https://10.0.0.5/', 'https://192.168.1.1/', 'https://[fd00::1]/', 'https://[::ffff:10.0.0.1]/', 'https://0.0.0.0/', 'nonsense', 'http://10.0.0.5/']) assert.equal(cfg({ PRIV_LOG_GATEWAY_URL: u }).ok, false, u);
});

test('the search URL is an origin (no path), same rules; the index name is a plain pattern', () => {
  assert.equal(cfg({ PRIV_LOG_SEARCH_URL: 'https://search.example' }).ok, true);
  assert.equal(cfg({ PRIV_LOG_SEARCH_URL: 'http://127.0.0.1:9200', PRIV_LOG_SEARCH_INDEX: 'gateway-events,other-*' }).ok, true);
  for (const u of ['https://search.example/idx/_search', 'http://search.example', 'https://169.254.169.254']) assert.equal(cfg({ PRIV_LOG_SEARCH_URL: u }).ok, false, u);
  for (const i of ['../x', '_all/../x', 'a b', '.hidden', 'x'.repeat(101), 'a/b']) assert.equal(cfg({ PRIV_LOG_SEARCH_URL: 'https://search.example', PRIV_LOG_SEARCH_INDEX: i }).ok, false, i);
});

test('a key with a space or control character is refused', () => {
  assert.equal(cfg({ PRIV_LOG_AGENT_KEY: 'abc def' }).ok, false);
  assert.equal(cfg({ PRIV_LOG_AGENT_KEY: 'abc\ndef' }).ok, false);
});

test('settings file: STANDALONE_ENV overrides the path, the environment wins, only our four names are read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pll-'));
  const file = path.join(dir, 'settings.env');
  fs.writeFileSync(file, `# comment\nPRIV_LOG_GATEWAY_URL="https://file.example/mcp"\nexport PRIV_LOG_AGENT_KEY='${KEY}'\nPRIV_LOG_SEARCH_INDEX=idx # trailing\nUNRELATED_SECRET=nope\n`);
  assert.equal(settingsFile({ STANDALONE_ENV: file }), file);
  const s = readSettings({ STANDALONE_ENV: file });
  assert.deepEqual(Object.keys(s).sort(), ['PRIV_LOG_AGENT_KEY', 'PRIV_LOG_GATEWAY_URL', 'PRIV_LOG_SEARCH_INDEX']);
  assert.equal(s.PRIV_LOG_SEARCH_INDEX, 'idx');
  assert.equal(readSettings({ STANDALONE_ENV: file, PRIV_LOG_GATEWAY_URL: 'https://env.example/mcp' }).PRIV_LOG_GATEWAY_URL, 'https://env.example/mcp');
  assert.equal(realAvailableFrom({ STANDALONE_ENV: file }), true);
  assert.equal(settingsFile({ HOME: '/home/x' }), path.join('/home/x', 'Development', '.env'));
  fs.rmSync(dir, { recursive: true });
});

test('launch mode: Real if configured else Mock; MODE=real without settings is refused; a bad MODE is refused', () => {
  const o = { file: false };
  assert.equal(modeFrom(NOENV, o), 'mock');
  assert.equal(modeFrom(base, o), 'real');
  assert.equal(modeFrom({ ...base, MODE: 'mock' }, o), 'mock');
  assert.throws(() => modeFrom({ ...NOENV, MODE: 'real' }, o), /MODE=real/);
  assert.throws(() => modeFrom({ ...NOENV, MODE: 'live' }, o), /not available/);
});

test('safety: private/reserved address detection, port, bind, and host scan', () => {
  for (const a of ['10.1.2.3', '172.16.0.1', '192.168.0.9', '169.254.169.254', '100.64.0.1', '127.0.0.1', '0.0.0.0', '::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPrivateAddress(a), true, a);
  for (const a of ['8.8.8.8', '1.1.1.1', '2001:db8::1', 'gateway.example', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(a), false, a);
  // IPv6 forms that carry or stand for a private IPv4, or are reserved: 6to4, IPv4-compatible (both spellings), site-local, Teredo, NAT64, ::
  for (const a of ['2002:a9fe:a9fe::1', '[2002:a9fe:a9fe::1]', '::a9fe:a9fe', '::7f00:1', '::127.0.0.1', '::169.254.169.254', 'fec0::1', 'feff::1', '2001::a9fe:a9fe', '2001:0:a9fe::1', '64:ff9b::a9fe:a9fe', '::', '::ffff:a9fe:a9fe', 'fe80::1%en0', '1:2:3:4:5:6:7:8:9', 'zz::1']) assert.equal(isPrivateAddress(a), true, a);
  for (const u of ['https://[2002:a9fe:a9fe::1]/', 'https://[::a9fe:a9fe]/', 'https://[::127.0.0.1]/', 'https://[fec0::1]/', 'https://[2001::a9fe:a9fe]/']) assert.equal(isPrivateAddress(new URL(u).hostname), true, u);
  assert.equal(portProblem(7801), null);
  for (const p of [7800, 7802, 8080, 5173, 80, 'x']) assert.ok(portProblem(p), String(p));
  assert.equal(resolvePort({}), 7801);
  assert.throws(() => resolvePort({ PORT: '7800' }));
  assert.equal(bindHost({}), '127.0.0.1');
  assert.throws(() => assertBindAllowed('0.0.0.0', {}), /loopback only/);
  assert.equal(assertBindAllowed('0.0.0.0', { PRIV_LOG_BIND: '0.0.0.0' }), '0.0.0.0');
  assert.deepEqual(scanHosts('see https://gateway.example/x and http://127.0.0.1:1/ and https://real.corp.net/'), ['real.corp.net']);
});

test('a hostile settings file: an over-long line is skipped, unrelated names are ignored, a quoted value keeps its text', () => {
  const t0 = Date.now();
  const s = parseSettings(`${' '.repeat(500_000)}x\nPRIV_LOG_AGENT_KEY=${'a'.repeat(5000)}\nPRIV_LOG_SEARCH_INDEX="my index"\nHOME=/etc\n`);
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(s, { PRIV_LOG_SEARCH_INDEX: 'my index' });
});

test('Kubernetes pod-log source: proxy URL defaults to loopback 8001, namespace and pod are required together, names are validated, container defaults to log-tailer', () => {
  const k = (x) => cfg(x);
  assert.equal(k().k8s, null);
  const ok = k({ PRIV_LOG_K8S_NAMESPACE: 'privilege', PRIV_LOG_K8S_POD: 'gateway-abc-123' });
  assert.equal(ok.ok, true);
  assert.equal(ok.k8s.origin, 'http://127.0.0.1:8001'); assert.equal(ok.k8s.container, 'log-tailer'); assert.equal(ok.k8s.pod, 'gateway-abc-123'); assert.equal(ok.k8s.selector, null);
  const sel = k({ PRIV_LOG_K8S_NAMESPACE: 'privilege', PRIV_LOG_K8S_POD: 'app=privilege-gateway,tier=gw', PRIV_LOG_K8S_CONTAINER: 'gateway', PRIV_LOG_K8S_PROXY_URL: 'http://localhost:9001' });
  assert.equal(sel.ok, true); assert.equal(sel.k8s.selector, 'app=privilege-gateway,tier=gw'); assert.equal(sel.k8s.pod, null); assert.equal(sel.k8s.container, 'gateway');
  const bad = [
    { PRIV_LOG_K8S_NAMESPACE: 'privilege' }, { PRIV_LOG_K8S_POD: 'p' }, { PRIV_LOG_K8S_PROXY_URL: 'http://127.0.0.1:8001' },
    { PRIV_LOG_K8S_NAMESPACE: 'Bad_NS', PRIV_LOG_K8S_POD: 'p' }, { PRIV_LOG_K8S_NAMESPACE: 'ns', PRIV_LOG_K8S_POD: '../etc' }, { PRIV_LOG_K8S_NAMESPACE: 'ns', PRIV_LOG_K8S_POD: 'a=b;rm -rf' },
    { PRIV_LOG_K8S_NAMESPACE: 'ns', PRIV_LOG_K8S_POD: 'p', PRIV_LOG_K8S_CONTAINER: 'c/../x' },
    { PRIV_LOG_K8S_NAMESPACE: 'ns', PRIV_LOG_K8S_POD: 'p', PRIV_LOG_K8S_PROXY_URL: 'http://10.0.0.5:8001' },
    { PRIV_LOG_K8S_NAMESPACE: 'ns', PRIV_LOG_K8S_POD: 'p', PRIV_LOG_K8S_PROXY_URL: 'http://kube.example:8001' },
    { PRIV_LOG_K8S_NAMESPACE: 'ns', PRIV_LOG_K8S_POD: 'p', PRIV_LOG_K8S_PROXY_URL: 'http://127.0.0.1:8001/api' },
    { PRIV_LOG_K8S_NAMESPACE: 'ns', PRIV_LOG_K8S_POD: 'p', PRIV_LOG_K8S_PROXY_URL: 'https://169.254.169.254' },
  ];
  for (const b of bad) assert.equal(k(b).ok, false, JSON.stringify(b));
  assert.equal(k({ PRIV_LOG_K8S_NAMESPACE: 'ns', PRIV_LOG_K8S_POD: 'p', PRIV_LOG_K8S_PROXY_URL: 'https://kube.example' }).ok, true, 'https is allowed');
});

test('per-case bearers: PRIV_LOG_BEARER_<CASEID> is read from the environment and the settings file, and only that shape', async () => {
  const { bearerFromSettings, bearerEnvName } = await import('../src/config.js').then(async (m) => ({ ...m, ...(await import('../src/mcpRunner.js')) }));
  const env = { ...NOENV, PRIV_LOG_BEARER_KEYS_REVOKED: 'tok-1', PRIV_LOG_BEARER_lowercase: 'no', SOMETHING_ELSE: 'no' };
  assert.equal(bearerFromSettings('keys-revoked', env, { file: false }), 'tok-1');
  assert.equal(bearerFromSettings('keys-expired', env, { file: false }), undefined);
  assert.equal(bearerEnvName('fed-lifetime-too-long'), 'FED_LIFETIME_TOO_LONG');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pll-')); const file = path.join(dir, 's.env');
  fs.writeFileSync(file, 'PRIV_LOG_BEARER_FED_VALID_TOKEN=from-file\nOTHER=x\n');
  assert.equal(bearerFromSettings('fed-valid-token', { STANDALONE_ENV: file }), 'from-file');
  fs.rmSync(dir, { recursive: true });
});
