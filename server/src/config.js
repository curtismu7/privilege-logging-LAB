// Settings for Real mode (rule 19). Read from the shared settings file (~/Development/.env, STANDALONE_ENV overrides the path) and
// from the process environment (the environment wins). Names: PRIV_LOG_GATEWAY_URL, PRIV_LOG_AGENT_KEY (write-only), PRIV_LOG_SEARCH_URL,
// PRIV_LOG_SEARCH_INDEX. Real needs the gateway URL and the key; the search URL is optional (without it, the user pastes log lines).
// The key is only ever read here and handed to the Real client; no function in this file returns it to an API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLoopbackHost, isPrivateAddress } from './safety.js';

export const SETTING_NAMES = ['PRIV_LOG_GATEWAY_URL', 'PRIV_LOG_AGENT_KEY', 'PRIV_LOG_SEARCH_URL', 'PRIV_LOG_SEARCH_INDEX'];
const MAX_VALUE = 2048;

export function settingsFile(env = process.env) {
  return env.STANDALONE_ENV || path.join(env.HOME || os.homedir(), 'Development', '.env');
}

// KEY=value lines, optional quotes, '#' comments. Only our four names are kept.
export function parseSettings(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    if (raw.length > 4096) continue; // a settings line is short; skip anything else
    const m = /^\s*(?:export\s+)?([A-Z0-9_]{1,40})\s*=\s*(.*)$/.exec(raw);
    if (!m || !SETTING_NAMES.includes(m[1])) continue;
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
  for (const n of SETTING_NAMES) { const v = env[n] !== undefined && env[n] !== '' ? String(env[n]) : fromFile[n]; if (v !== undefined && v !== '' && v.length <= MAX_VALUE) out[n] = v; }
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
  return { ok: true, gateway: gw, search: search || null, index, key: s.PRIV_LOG_AGENT_KEY };
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
