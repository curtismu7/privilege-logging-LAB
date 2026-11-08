// Settings for Real mode (rule 19). Read from the shared settings file (~/Development/.env, STANDALONE_ENV overrides the path) and
// from the process environment (the environment wins). Names: PRIV_LOG_GATEWAY_URL, PRIV_LOG_AGENT_KEY (write-only), PRIV_LOG_SEARCH_URL,
// PRIV_LOG_SEARCH_INDEX, and for the Kubernetes pod-log reader (through `kubectl proxy`): PRIV_LOG_K8S_PROXY_URL, PRIV_LOG_K8S_NAMESPACE,
// PRIV_LOG_K8S_POD, PRIV_LOG_K8S_CONTAINER, and for the policy decision log (read through the Privilege console's elasticlog API):
// PRIV_LOG_CONSOLE_URL, PRIV_LOG_CONSOLE_TENANT. Real needs the gateway URL and the key; the log sources are optional (without any, the user pastes log lines).
// The key is only ever read here and handed to the Real client; no function in this file returns it to an API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLoopbackHost, isPrivateAddress } from './safety.js';

export const SETTING_NAMES = ['PRIV_LOG_GATEWAY_URL', 'PRIV_LOG_AGENT_KEY', 'PRIV_LOG_SEARCH_URL', 'PRIV_LOG_SEARCH_INDEX', 'PRIV_LOG_K8S_PROXY_URL', 'PRIV_LOG_K8S_NAMESPACE', 'PRIV_LOG_K8S_POD', 'PRIV_LOG_K8S_CONTAINER', 'PRIV_LOG_CONSOLE_URL', 'PRIV_LOG_CONSOLE_TENANT', 'PRIV_LOG_CONSOLE_CA', 'PRIV_LOG_BRIDGE_ES_URL', 'PRIV_LOG_BRIDGE_ES_APIKEY', 'PRIV_LOG_FED_SIGNING_SEED', 'PRIV_LOG_FED_AUDIENCE'];
export const DEFAULT_K8S_PROXY = 'http://127.0.0.1:8001';
export const DEFAULT_K8S_CONTAINER = 'log-tailer';
// A Kubernetes object name (RFC 1123 subdomain) or a label selector such as app=privilege-gateway,tier=gw.
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const K8S_SELECTOR = /^[A-Za-z0-9._\/-]{1,63}(=|!=|==)[A-Za-z0-9._-]{1,63}(,[A-Za-z0-9._\/-]{1,63}(=|!=|==)[A-Za-z0-9._-]{1,63}){0,4}$/;
const MAX_VALUE = 2048;
const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Per-case credentials only the owner has (a revoked key, a federated token): PRIV_LOG_BEARER_<CASEID>, id upper-cased, - as _. Write-only like the key.
export const BEARER_NAME = /^PRIV_LOG_BEARER_[A-Z0-9_]{1,60}$/;
export const isSettingName = (n) => SETTING_NAMES.includes(n) || BEARER_NAME.test(n);

export function settingsFile(env = process.env) {
  return env.STANDALONE_ENV || path.join(env.HOME || os.homedir(), 'Development', '.env');
}

// KEY=value lines, optional quotes, '#' comments. Only our four names are kept.
export function parseSettings(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    if (raw.length > 4096) continue; // a settings line is short; skip anything else
    const m = /^\s*(?:export\s+)?([A-Z0-9_]{1,80})\s*=\s*(.*)$/.exec(raw);
    if (!m || !isSettingName(m[1])) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (v.length <= MAX_VALUE) out[m[1]] = v;
  }
  return out;
}

// env: the process environment (or a test's); file: false to skip the settings file. Environment values win over the file.
export function readSettings(env = process.env, { file = true } = {}) {
  let fromFile = {};
  if (file) { try { fromFile = parseSettings(fs.readFileSync(settingsFile(env), 'utf8')); } catch { /* no file */ } }
  const out = {};
  const names = new Set([...SETTING_NAMES, ...Object.keys(env).filter((k) => BEARER_NAME.test(k)), ...Object.keys(fromFile)]);
  for (const n of names) { const v = env[n] !== undefined && env[n] !== '' ? String(env[n]) : fromFile[n]; if (v !== undefined && v !== '' && v.length <= MAX_VALUE) out[n] = v; }
  return out;
}

// An origin we may contact: https anywhere, or http on loopback. No credentials, query or fragment. A private/link-local/metadata
// IP LITERAL is refused here; a host NAME that resolves to one is refused at connect time (realClient.js).
export function checkUrl(raw, { what, allowPath = true }) {
  if (!raw) return { error: `${what} is not set` };
  let u;
  try { u = new URL(raw); } catch { return { error: `${what} is not a URL` }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: `${what} must be https (or http on loopback)` };
  if (u.username || u.password) return { error: `${what} must not carry credentials` };
  if (u.search || u.hash) return { error: `${what} must not carry a query or fragment` };
  if (!allowPath && u.pathname !== '/') return { error: `${what} must be an origin with no path` };
  const loop = isLoopbackHost(u.hostname);
  if (u.protocol === 'http:' && !loop) return { error: `${what} must be https unless it is on loopback` };
  if (!loop && isPrivateAddress(u.hostname)) return { error: `${what} points at a private or reserved address` };
  return { url: u, origin: u.origin, host: u.hostname.replace(/^\[|\]$/g, '') };
}

// The Real configuration, or why it is unusable. Returns { ok, problem, gateway, search, index, key } (key only for the client).
export function realConfig(env = process.env, opts) {
  const s = readSettings(env, opts);
  const gw = checkUrl(s.PRIV_LOG_GATEWAY_URL, { what: 'PRIV_LOG_GATEWAY_URL' });
  if (gw.error) return { ok: false, problem: `Real is not configured: ${gw.error}. Set PRIV_LOG_GATEWAY_URL and PRIV_LOG_AGENT_KEY in ~/Development/.env (or STANDALONE_ENV). Mock keeps working.` };
  if (!s.PRIV_LOG_AGENT_KEY) return { ok: false, problem: 'Real is not configured: PRIV_LOG_AGENT_KEY (an agent access key; write-only) is not set in ~/Development/.env or STANDALONE_ENV. Mock keeps working.' };
  if (/[\s\u0000-\u001f]/.test(s.PRIV_LOG_AGENT_KEY)) return { ok: false, problem: 'Real is not configured: PRIV_LOG_AGENT_KEY must not contain spaces or control characters. Mock keeps working.' };
  let search = null; let index = null;
  if (s.PRIV_LOG_SEARCH_URL) {
    search = checkUrl(s.PRIV_LOG_SEARCH_URL, { what: 'PRIV_LOG_SEARCH_URL', allowPath: false });
    if (search.error) return { ok: false, problem: `Real is not configured: ${search.error}. Mock keeps working.` };
  }
  if (s.PRIV_LOG_SEARCH_INDEX) {
    if (!/^[A-Za-z0-9._*,-]{1,100}$/.test(s.PRIV_LOG_SEARCH_INDEX) || s.PRIV_LOG_SEARCH_INDEX.startsWith('_') || s.PRIV_LOG_SEARCH_INDEX.startsWith('.')) return { ok: false, problem: 'Real is not configured: PRIV_LOG_SEARCH_INDEX may only use letters, digits and . _ * , - (no leading . or _). Mock keeps working.' };
    index = s.PRIV_LOG_SEARCH_INDEX;
  }
  // Kubernetes pod log through `kubectl proxy` (owner-run, loopback by default). Configured when a namespace and a pod (or selector) are set.
  let k8s = null;
  if (s.PRIV_LOG_K8S_NAMESPACE || s.PRIV_LOG_K8S_POD || s.PRIV_LOG_K8S_PROXY_URL) {
    const bad = (m) => ({ ok: false, problem: `Real is not configured: ${m}. Mock keeps working.` });
    if (!s.PRIV_LOG_K8S_NAMESPACE || !s.PRIV_LOG_K8S_POD) return bad('the Kubernetes log source needs both PRIV_LOG_K8S_NAMESPACE and PRIV_LOG_K8S_POD');
    const px = checkUrl(s.PRIV_LOG_K8S_PROXY_URL || DEFAULT_K8S_PROXY, { what: 'PRIV_LOG_K8S_PROXY_URL', allowPath: false });
    if (px.error) return bad(px.error);
    if (!K8S_NAME.test(s.PRIV_LOG_K8S_NAMESPACE)) return bad('PRIV_LOG_K8S_NAMESPACE is not a Kubernetes name');
    const selector = s.PRIV_LOG_K8S_POD.includes('=');
    if (selector ? !K8S_SELECTOR.test(s.PRIV_LOG_K8S_POD) : !K8S_NAME.test(s.PRIV_LOG_K8S_POD)) return bad('PRIV_LOG_K8S_POD must be a pod name or a label selector like app=name');
    const container = s.PRIV_LOG_K8S_CONTAINER || DEFAULT_K8S_CONTAINER;
    if (!K8S_NAME.test(container)) return bad('PRIV_LOG_K8S_CONTAINER is not a Kubernetes name');
    k8s = { url: px.url, origin: px.origin, host: px.host, namespace: s.PRIV_LOG_K8S_NAMESPACE, pod: selector ? null : s.PRIV_LOG_K8S_POD, selector: selector ? s.PRIV_LOG_K8S_POD : null, container };
  }
  // Policy decision log through the Privilege console (owner-run): POST <console>/api/<tenant>/v1/elasticlog. Configured when both are set.
  let decisions = null;
  if (s.PRIV_LOG_CONSOLE_URL || s.PRIV_LOG_CONSOLE_TENANT) {
    const bad = (m) => ({ ok: false, problem: `Real is not configured: ${m}. Mock keeps working.` });
    if (!s.PRIV_LOG_CONSOLE_URL || !s.PRIV_LOG_CONSOLE_TENANT) return bad('the decision-log source needs both PRIV_LOG_CONSOLE_URL and PRIV_LOG_CONSOLE_TENANT');
    const cu = checkUrl(s.PRIV_LOG_CONSOLE_URL, { what: 'PRIV_LOG_CONSOLE_URL', allowPath: false });
    if (cu.error) return bad(cu.error);
    if (!TENANT.test(s.PRIV_LOG_CONSOLE_TENANT)) return bad('PRIV_LOG_CONSOLE_TENANT must be the tenant id (a UUID)');
    // The local console's certificate chains to a tenant root the PingOne Privilege app installs in the keychain, which Node does not
    // trust by default: PRIV_LOG_CONSOLE_CA names a PEM file of that root, trusted for the console origin ONLY.
    let ca = null;
    if (s.PRIV_LOG_CONSOLE_CA) {
      try { ca = fs.readFileSync(s.PRIV_LOG_CONSOLE_CA.replace(/^~(?=\/)/, os.homedir()), 'utf8'); } catch { return bad('PRIV_LOG_CONSOLE_CA is not a readable file'); }
      if (ca.length > 65_536 || !ca.includes('-----BEGIN CERTIFICATE-----')) return bad('PRIV_LOG_CONSOLE_CA must be a PEM certificate file');
    }
    decisions = { url: cu.url, origin: cu.origin, host: cu.host, tenant: s.PRIV_LOG_CONSOLE_TENANT.toLowerCase(), ca };
  }
  return { ok: true, gateway: gw, search: search || null, index, k8s, decisions, key: s.PRIV_LOG_AGENT_KEY };
}

// The bearer the owner set for a case in the environment or settings file, or undefined. Never returned by an API.
export const bearerFromSettings = (caseId, env = process.env, opts) => readSettings(env, opts)[`PRIV_LOG_BEARER_${String(caseId).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];

// The lab's own workload-token issuer (fedIssuer.js) for the "Valid workload token" case: PRIV_LOG_FED_SIGNING_SEED (write-only, never
// returned) and PRIV_LOG_FED_AUDIENCE (the Audience the Privilege console shows on the Federated Identity). Returns
// { seed, audience, problem }: problem is null only when both are set and usable.
export function fedConfig(env = process.env, opts) {
  const s = readSettings(env, opts);
  const seed = s.PRIV_LOG_FED_SIGNING_SEED || null; const audience = s.PRIV_LOG_FED_AUDIENCE || null;
  let problem = null;
  if (!seed) problem = 'PRIV_LOG_FED_SIGNING_SEED is not set (run npm run fed-key)';
  else if (!/^[0-9a-f]{64}$/i.test(seed)) problem = 'PRIV_LOG_FED_SIGNING_SEED must be 64 hex characters (run npm run fed-key for a new one)';
  else if (!audience) problem = 'PRIV_LOG_FED_AUDIENCE is not set (copy the Audience from the Federated Identity in the Privilege console)';
  else if (audience.length > 512 || /[\s\u0000-\u001f]/.test(audience)) problem = 'PRIV_LOG_FED_AUDIENCE must be up to 512 characters with no spaces';
  return { seed, audience, problem };
}

export const realAvailableFrom = (env = process.env, opts) => realConfig(env, opts).ok;
export const realProblemFrom = (env = process.env, opts) => { const c = realConfig(env, opts); return c.ok ? null : c.problem; };

// The launch mode (env MODE). Default: Real if configured, else Mock. The Docker image sets MODE=mock, so Real is never on by default there.
export function modeFrom(env = process.env, opts) {
  if (env.MODE === undefined || env.MODE === '') return realAvailableFrom(env, opts) ? 'real' : 'mock';
  if (env.MODE !== 'mock' && env.MODE !== 'real') throw new Error(`MODE=${String(env.MODE).slice(0, 20)} is not available: this app has mock and real modes`);
  if (env.MODE === 'real' && !realAvailableFrom(env, opts)) throw new Error('MODE=real requested but the Real settings are missing or not usable');
  return env.MODE;
}
