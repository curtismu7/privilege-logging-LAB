// The Privilege logs bridge (owner-run, on the owner's Mac): copies the Privilege records its SIEM export does not send into our SIEM
// index. Reads policy-decision-log, aiguard-log and agent-approval-log through the console's elasticlog API (the same read the
// Privilege -> Elasticsearch tab does) and writes each record to <PRIV_LOG_BRIDGE_ES_URL>/ping-siem-events-v2/_doc/<its own _id>, so a
// re-read never duplicates anything. The index's ingest pipeline masks keys and labels each record runtime.
//
// Each pass reads from (last copied record time - OVERLAP_MS) to now, so records that reach Privilege's store late are still copied.
// A first run starts BACKFILL_DAYS back. A pass that fails leaves the saved position where it was; the next pass catches up.
// Settings: the console ones (PRIV_LOG_CONSOLE_URL, PRIV_LOG_CONSOLE_TENANT, PRIV_LOG_CONSOLE_CA) plus PRIV_LOG_BRIDGE_ES_URL and
// PRIV_LOG_BRIDGE_ES_APIKEY (write-only: an Elasticsearch API key that may only write to the target index).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkUrl, readSettings, realConfig } from './config.js';
import { createRealClient } from './realClient.js';
import { elasticlogSearch } from './logSources.js';
import { newTrace } from './trace.js';

export const BRIDGE_INDICES = ['policy-decision-log', 'aiguard-log', 'agent-approval-log'];
export const TARGET_INDEX = 'ping-siem-events-v2';
export const OVERLAP_MS = 10 * 60_000;
export const BACKFILL_DAYS = 30;
export const CHUNK_MS = 6 * 3_600_000;
export const PAGE = 200;
export const MAX_FROM = 9_800; // elasticlog is a plain search: from + size stays under the usual 10,000 window
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export const stateFile = (env = process.env) => env.PRIV_LOG_BRIDGE_STATE || path.join(env.HOME || os.homedir(), '.config', 'privilege-logging-lab', 'bridge-state.json');
export function readState(file) { try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; } }
function writeState(file, s) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(s, null, 1)}\n`, { mode: 0o600 }); }

// The bridge settings, or why they are unusable. Needs the console source and an https Elasticsearch origin plus its API key.
export function bridgeConfig(env = process.env, opts) {
  const s = readSettings(env, opts);
  const probe = realConfig({ ...env, PRIV_LOG_GATEWAY_URL: env.PRIV_LOG_GATEWAY_URL || s.PRIV_LOG_GATEWAY_URL || 'https://gateway.example.invalid/x/mcp', PRIV_LOG_AGENT_KEY: env.PRIV_LOG_AGENT_KEY || s.PRIV_LOG_AGENT_KEY || 'unused-by-the-bridge' }, opts);
  if (!probe.ok) return { ok: false, problem: probe.problem };
  if (!probe.decisions) return { ok: false, problem: 'the bridge reads Privilege through the console: set PRIV_LOG_CONSOLE_URL and PRIV_LOG_CONSOLE_TENANT (and PRIV_LOG_CONSOLE_CA for the local console)' };
  const es = checkUrl(s.PRIV_LOG_BRIDGE_ES_URL, { what: 'PRIV_LOG_BRIDGE_ES_URL', allowPath: false });
  if (es.error) return { ok: false, problem: es.error };
  const key = s.PRIV_LOG_BRIDGE_ES_APIKEY;
  if (!key || !/^[A-Za-z0-9+/=_-]{16,512}$/.test(key)) return { ok: false, problem: 'PRIV_LOG_BRIDGE_ES_APIKEY (an Elasticsearch API key, write-only) is not set or not a key' };
  return { ok: true, decisions: probe.decisions, es, key };
}

// One pass. Returns { copied, read, from, to, chunks, lastTs } or throws (the saved position is then unchanged).
export async function bridgePass({ cfg, client, now = Date.now, state = {}, log = () => {} }) {
  const to = now();
  const start = Number.isFinite(state.lastTs) ? state.lastTs - OVERLAP_MS : to - BACKFILL_DAYS * 86_400_000;
  let copied = 0; let read = 0; let chunks = 0; let lastTs = Number.isFinite(state.lastTs) ? state.lastTs : null;
  for (let a = start; a < to; a += CHUNK_MS) {
    const b = Math.min(a + CHUNK_MS, to); chunks += 1;
    for (let from = 0; from <= MAX_FROM; from += PAGE) {
      const { hits } = await elasticlogSearch({ client, decisions: cfg.decisions, indices: BRIDGE_INDICES, fromMs: a, toMs: b, size: PAGE, from, trace: newTrace() });
      for (const h of hits) {
        if (!h || typeof h !== 'object' || typeof h._id !== 'string' || !ID.test(h._id) || !BRIDGE_INDICES.includes(h._index) || !h._source || typeof h._source !== 'object') continue;
        read += 1;
        const doc = { ...h._source, Index: h._index, privilege_bridge: true };
        const res = await client.request({ url: `${cfg.es.origin}/${TARGET_INDEX}/_doc/${encodeURIComponent(h._id)}`, method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `ApiKey ${cfg.key}` }, body: JSON.stringify(doc) });
        if (res.status !== 200 && res.status !== 201) throw Object.assign(new Error(`Elasticsearch answered HTTP ${res.status} writing a ${h._index} record`), { code: 'write_failed' });
        copied += 1;
        const t = Date.parse(h._source['@timestamp']);
        if (Number.isFinite(t) && (lastTs === null || t > lastTs)) lastTs = t;
      }
      if (hits.length < PAGE) break;
      if (from + PAGE > MAX_FROM) log(`more than ${MAX_FROM + PAGE} records in one ${CHUNK_MS / 3_600_000} h window; the rest of that window is skipped`);
    }
  }
  return { copied, read, from: new Date(start).toISOString(), to: new Date(to).toISOString(), chunks, lastTs: lastTs ?? (Number.isFinite(state.lastTs) ? state.lastTs : null) };
}

export function clientForBridge(cfg, opts = {}) {
  return createRealClient({ origins: [cfg.decisions.origin, cfg.es.origin], secrets: [cfg.key], loopbackNames: [cfg.decisions.host], caByHost: cfg.decisions.ca ? { [cfg.decisions.host]: cfg.decisions.ca } : {}, maxBytes: 1_048_576, ...opts });
}

// One pass with the saved position: read state, run, save. Never prints a key; errors are recorded in the state file too.
export async function runOnce({ env = process.env, now = Date.now, client = null, log = console.log } = {}) {
  const cfg = bridgeConfig(env);
  if (!cfg.ok) throw Object.assign(new Error(cfg.problem), { code: 'not_configured' });
  const file = stateFile(env); const state = readState(file);
  try {
    const r = await bridgePass({ cfg, client: client || clientForBridge(cfg), now, state, log });
    writeState(file, { lastTs: r.lastTs, lastRunAt: new Date(now()).toISOString(), lastCopied: r.copied, totalCopied: (state.totalCopied || 0) + r.copied, lastError: null });
    return r;
  } catch (e) {
    writeState(file, { ...state, lastRunAt: new Date(now()).toISOString(), lastError: String(e.detail || e.message).slice(0, 300) });
    throw e;
  }
}
