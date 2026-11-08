// The Privilege -> Elasticsearch explorer: one time range read through the console (paged), every record parsed into fields, then
// filters, counts, a histogram, one page of entries, the related records of one call, and the matching Kibana Discover link.
// Pure apart from readWindow (which pages through elasticlogSearch). Every shown string is redacted; raw console answers never leave here.
import { hitLine } from './logparse.js';
import { redactLine } from './redact.js';
import { PRIVILEGE_INDICES, kindOf } from './eventKind.js';
import { elasticlogSearch } from './logSources.js';

export const QUICK_RANGES = { '15m': 15 * 60_000, '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000 };
export const MAX_BACK_MS = 90 * 86_400_000;
const SLACK_MS = 15 * 60_000; // a pinned window resent a little later may start a few minutes past the 90-day line
export const CONSOLE_PAGE = 200;
export const SEARCH_WINDOW = 10_000; // a plain search answers From + Size up to 10,000
export const RECORD_CAP = 5_000; // records read per query, at most
export const VIEW_PAGE = 50;
export const RELATED_MS = 10 * 60_000;
export const DECISIONS = ['allow', 'deny', 'hitl'];
export const KINDS = ['runtime', 'console', 'unknown'];
export const FIELD_FILTERS = ['user', 'agent', 'tool', 'app', 'event'];
const FIELD_MAX = 200; // the longest field value fieldsOf keeps, so every offered facet value is also an accepted filter
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/;
const ID = /^[A-Za-z0-9<>_.:-]{1,128}$/;
const CTRL = /[\u0000-\u001f\u007f]/;
const BUCKETS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000, 2 * 86_400_000, 3 * 86_400_000];
export const MAX_BARS = 60;

const bad = (error, detail) => ({ error, detail });
const str = (v, max = FIELD_MAX) => (typeof v === 'string' && v !== '' ? redactLine(v).slice(0, max) : null);
// Strict: the digit layout AND a real calendar time (no 2026-09-31, no T24:00, no +25:00), so Date.parse never rolls a value over.
const isoMs = (v) => {
  const m = typeof v === 'string' ? ISO.exec(v) : null;
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s = '00', , oh = '00', om = '00'] = m;
  const days = new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate();
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > days || +h > 23 || +mi > 59 || +s > 59 || +oh > 23 || +om > 59) return NaN;
  return Date.parse(v);
};

// GET /api/privilege-logs query -> { from, to, filters, page, all } or { error, detail } (400).
export function parseExplorerQuery(q, { now }) {
  const allowed = ['range', 'from', 'to', 'kind', 'index', 'decision', 'q', 'page', 'all', ...FIELD_FILTERS];
  for (const [k, v] of Object.entries(q)) {
    if (!allowed.includes(k)) return bad('bad_param', `unknown parameter ${String(k).slice(0, 40)}; allowed: ${allowed.join(', ')}`);
    if (typeof v !== 'string') return bad('bad_param', `${k} must be given once, as text`);
  }
  let from; let to;
  if (q.range !== undefined) {
    if (q.from !== undefined || q.to !== undefined) return bad('bad_range', 'give either range or from and to, not both');
    if (!Object.hasOwn(QUICK_RANGES, q.range)) return bad('bad_range', `range must be one of ${Object.keys(QUICK_RANGES).join(', ')}`);
    to = now; from = now - QUICK_RANGES[q.range];
  } else if (q.from !== undefined || q.to !== undefined) {
    from = isoMs(q.from); to = isoMs(q.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return bad('bad_range', 'from and to must both be ISO 8601 times with a zone, such as 2026-11-07T22:15:00Z');
    if (from >= to) return bad('bad_range', 'from must be before to');
    if (from < now - MAX_BACK_MS - SLACK_MS) return bad('bad_range', 'from may be at most 90 days back');
    if (to > now + 60_000) return bad('bad_range', 'to may not be in the future');
  } else { to = now; from = now - QUICK_RANGES['1h']; }
  const filters = {};
  if (q.kind !== undefined) { if (!KINDS.includes(q.kind)) return bad('bad_kind', `kind must be one of ${KINDS.join(', ')}`); filters.kind = q.kind; }
  if (q.index !== undefined) { if (![...PRIVILEGE_INDICES, 'unknown'].includes(q.index)) return bad('bad_index', `index must be one of ${PRIVILEGE_INDICES.join(', ')} or unknown`); filters.index = q.index; }
  if (q.decision !== undefined) { if (!DECISIONS.includes(q.decision)) return bad('bad_decision', `decision must be one of ${DECISIONS.join(', ')}`); filters.decision = q.decision; }
  for (const k of FIELD_FILTERS) {
    if (q[k] === undefined) continue;
    if (!q[k].length || q[k].length > FIELD_MAX || CTRL.test(q[k])) return bad(`bad_${k}`, `${k} must be 1 to ${FIELD_MAX} characters with no control characters`);
    filters[k] = q[k];
  }
  if (q.q !== undefined) {
    if (!q.q.length || q.q.length > 200 || CTRL.test(q.q)) return bad('bad_q', 'q (free text) must be 1 to 200 characters with no control characters');
    filters.q = q.q;
  }
  let page = 0;
  if (q.page !== undefined) { if (!/^\d{1,3}$/.test(q.page)) return bad('bad_page', 'page must be a whole number from 0 to 999'); page = Number(q.page); }
  if (q.all !== undefined && q.all !== '1') return bad('bad_all', 'all must be 1');
  return { from, to, filters, page, all: q.all === '1' };
}

// GET /api/privilege-logs/related query -> { at, requestId, traceId, from, to } or { error, detail }.
export function parseRelatedQuery(q, { now }) {
  for (const [k, v] of Object.entries(q)) {
    if (!['request_id', 'trace_id', 'at'].includes(k)) return bad('bad_param', 'allowed parameters: request_id, trace_id, at');
    if (typeof v !== 'string') return bad('bad_param', `${k} must be given once, as text`);
  }
  const at = isoMs(q.at);
  if (!Number.isFinite(at) || at < now - MAX_BACK_MS - SLACK_MS || at > now + 60_000) return bad('bad_at', 'at must be an ISO 8601 time with a zone within the last 90 days');
  for (const k of ['request_id', 'trace_id']) if (q[k] !== undefined && !ID.test(q[k])) return bad(`bad_${k}`, `${k} must be 1 to 128 letters, digits or < > _ . : -`);
  if (!q.request_id && !q.trace_id) return bad('bad_related', 'give request_id, trace_id or both');
  return { at, requestId: q.request_id || null, traceId: q.trace_id || null, from: at - RELATED_MS, to: at + RELATED_MS };
}

// The trace-id part of a W3C traceparent (00-<32 hex>-<16 hex>-<2 hex>).
const traceOf = (tp) => { const v = Array.isArray(tp) ? tp[0] : tp; const m = typeof v === 'string' ? /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(v.trim()) : null; return m ? m[1] : null; };

// The fields of one record (its _source), each redacted. Decision records carry User, AgentKey, Target, Decision; AI Guard records name
// the caller as Client; console records name the admin as User.Name; HTTP records carry the trace in a Traceparent header.
export function fieldsOf(src) {
  const s = src && typeof src === 'object' && !Array.isArray(src) ? src : {};
  const d = s.Data && typeof s.Data === 'object' && !Array.isArray(s.Data) ? s.Data : {};
  const consoleUser = s.User && typeof s.User === 'object' && !Array.isArray(s.User) ? s.User.Name : s.User;
  const agentKey = str(d.AgentKey); const client = str(d.Client);
  const headers = d.Headers && typeof d.Headers === 'object' ? d.Headers : {};
  return {
    user: str(d.User) || str(consoleUser), agent: agentKey || client, agentFrom: agentKey ? 'agent key' : client ? 'client' : null,
    principalKind: str(d.PrincipalKind, 40), tool: str(d.Target), decision: str(d.Decision, 40), app: str(d.App), event: str(d.Event, 120),
    reason: str(d.Reason, 400), requestId: str(d.RequestID, 128), traceId: str(d.TraceID, 128) || traceOf(headers.Traceparent), message: str(s.Message, 200),
    method: str(d.Method, 40), path: str(d.Path), policyIds: Array.isArray(d.PolicyIDs) ? str(d.PolicyIDs.filter((x) => typeof x === 'string').slice(0, 10).join(', ')) : str(d.PolicyIDs),
  };
}

// One console hit -> the entry the page shows.
export function entryOf(hit) {
  const src = hit?._source;
  const t = src?.['@timestamp']; const ts = typeof t === 'string' ? Date.parse(t) : NaN;
  const index = typeof hit?._index === 'string' && PRIVILEGE_INDICES.includes(hit._index) ? hit._index : null;
  const text = redactLine(hitLine(hit));
  return { index, kind: kindOf({ index, text }), at: Number.isFinite(ts) ? new Date(ts).toISOString() : null, text, fields: fieldsOf(src) };
}

const newestFirst = (a, b) => (b.at || '').localeCompare(a.at || '');
export const entriesOf = (hits) => hits.map(entryOf).sort(newestFirst);

// Pages through the console for one range: Size `pageSize`, From offset, until the records run out, `cap` records are read or the
// search window (From + Size) is reached. Says plainly which limit cut it off.
export async function readWindow({ client, decisions, indices, fromMs, toMs, trace, pageSize = CONSOLE_PAGE, cap = RECORD_CAP, window = SEARCH_WINDOW }) {
  const hits = []; let total = null; let from = 0; let requests = 0; let stop = 'end';
  for (;;) {
    const size = Math.min(pageSize, cap - hits.length, window - from);
    if (size <= 0) { stop = hits.length >= cap ? 'cap' : 'window'; break; }
    const r = await elasticlogSearch({ client, decisions, ...(indices ? { indices } : {}), fromMs, toMs, trace, size, from });
    requests += 1;
    if (total === null && r.total !== null) total = r.total;
    hits.push(...r.hits.slice(0, size));
    if (r.hits.length < size) break;
    from += size;
  }
  if (stop !== 'end' && total !== null && total <= hits.length) stop = 'end';
  return { hits, total, requests, stop };
}

export function limitNote({ stop, read, total, cap = RECORD_CAP, window = SEARCH_WINDOW }) {
  if (stop === 'end') return null;
  const more = total !== null ? `The console reports ${total.toLocaleString('en-US')} records in this range` : 'The console may hold more records in this range (it did not report a total)';
  const why = stop === 'cap' ? `the lab reads at most ${cap.toLocaleString('en-US')} per query` : `its search stops at ${window.toLocaleString('en-US')} records (From + Size)`;
  return `${more}; ${why}, so only ${read.toLocaleString('en-US')} were read. Counts and the chart cover that capped sample, in the order the console returned them (not measured: which records the console returns first). Narrow the range (click a bar) to see the rest.`;
}

export function applyFilters(entries, f) {
  const q = f.q ? f.q.toLowerCase() : null;
  return entries.filter((e) => (!f.kind || e.kind === f.kind)
    && (!f.index || (e.index || 'unknown') === f.index)
    && (!f.decision || e.fields.decision === f.decision)
    && FIELD_FILTERS.every((k) => !f[k] || e.fields[k] === f[k])
    && (!q || e.text.toLowerCase().includes(q)));
}

// Distinct values per filterable field over the whole range (before filters), so the page can offer them. Bounded.
export function facetsOf(entries, max = 50) {
  const out = {};
  for (const k of [...FIELD_FILTERS, 'index']) {
    const counts = new Map();
    for (const e of entries) { const v = k === 'index' ? (e.index || 'unknown') : e.fields[k]; if (v) counts.set(v, (counts.get(v) || 0) + 1); }
    out[k] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([value, count]) => ({ value, count }));
  }
  return out;
}

export function summaryOf(entries) {
  const s = { total: entries.length, kinds: { runtime: 0, console: 0, unknown: 0 }, decisions: { allow: 0, deny: 0, hitl: 0 }, aiguard: {} };
  for (const e of entries) {
    s.kinds[e.kind] = (s.kinds[e.kind] || 0) + 1;
    if (e.index === 'policy-decision-log' && DECISIONS.includes(e.fields.decision)) s.decisions[e.fields.decision] += 1;
    if (e.index === 'aiguard-log') { const v = e.fields.event || 'no Event'; s.aiguard[v] = (s.aiguard[v] || 0) + 1; }
  }
  return s;
}

export const bucketFor = (spanMs) => BUCKETS.find((b) => Math.ceil(spanMs / b) <= MAX_BARS) || BUCKETS.at(-1);

export function histogramOf(entries, fromMs, toMs) {
  const size = bucketFor(toMs - fromMs);
  const n = Math.max(1, Math.ceil((toMs - fromMs) / size));
  const buckets = Array.from({ length: n }, (_, i) => ({ from: new Date(fromMs + i * size).toISOString(), to: new Date(Math.min(toMs, fromMs + (i + 1) * size)).toISOString(), count: 0 }));
  for (const e of entries) {
    const t = e.at ? Date.parse(e.at) : NaN;
    if (!Number.isFinite(t) || t < fromMs || t > toMs) continue;
    buckets[Math.min(n - 1, Math.floor((t - fromMs) / size))].count += 1;
  }
  return { bucketMs: size, buckets };
}

// Records within the window that share the anchor's request id or trace id, then (one hop) those that share an id with a match:
// a decision has a request id, its AI Guard record has the same request id and a trace id, and the HTTP record carries that trace id.
export function relatedOf(entries, { requestId, traceId }) {
  const req = new Set(requestId ? [requestId] : []); const tr = new Set(traceId ? [traceId] : []);
  const via = new Map();
  const pass = (label) => {
    for (const e of entries) {
      if (via.has(e)) continue;
      const r = e.fields.requestId && req.has(e.fields.requestId); const t = e.fields.traceId && tr.has(e.fields.traceId);
      if (r || t) via.set(e, label || (r && t ? 'request id and trace id' : r ? 'request id' : 'trace id'));
    }
  };
  pass(null);
  for (const e of via.keys()) { if (e.fields.requestId) req.add(e.fields.requestId); if (e.fields.traceId) tr.add(e.fields.traceId); }
  pass('linked through another related record');
  return [...via.entries()].map(([e, v]) => ({ ...e, via: v })).sort((a, b) => (a.at || '').localeCompare(b.at || ''));
}

// KQL for the privilege-logs data view (runtime fields privilege.*, the pipeline's privilege_event_kind and Index).
const kq = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
export function kqlOf(f) {
  const p = [];
  if (f.kind && f.kind !== 'unknown') p.push(`privilege_event_kind : ${kq(f.kind)}`);
  if (f.index && f.index !== 'unknown') p.push(`Index : ${kq(f.index)}`);
  if (f.user) p.push(`(privilege.user : ${kq(f.user)} or User.Name : ${kq(f.user)})`);
  if (f.agent) p.push(`(privilege.agent_key : ${kq(f.agent)} or privilege.client : ${kq(f.agent)})`);
  if (f.tool) p.push(`privilege.tool : ${kq(f.tool)}`);
  if (f.decision) p.push(`privilege.decision : ${kq(f.decision)}`);
  if (f.app) p.push(`privilege.app : ${kq(f.app)}`);
  if (f.event) p.push(`privilege.event : ${kq(f.event)}`);
  if (f.q) p.push(kq(f.q));
  return p.join(' and ');
}

const rison = (s) => `'${String(s).replace(/!/g, '!!').replace(/'/g, "!'")}'`;
export const KIBANA_DATA_VIEW = 'privilege-logs';
export const KIBANA_HINT = 'kubectl --context <your-context> -n <your-namespace> port-forward svc/kibana-siem 5601:5601';
export function kibanaUrl(origin, { fromMs, toMs, kql }) {
  const g = `(time:(from:${rison(new Date(fromMs).toISOString())},to:${rison(new Date(toMs).toISOString())}))`;
  const a = `(index:${rison(KIBANA_DATA_VIEW)},query:(language:kuery,query:${rison(kql)}))`;
  return `${origin}/app/discover#/?_g=${encodeURIComponent(g)}&_a=${encodeURIComponent(a)}`;
}
