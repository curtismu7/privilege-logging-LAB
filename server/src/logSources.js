// Log source adapters. Each reads raw log lines for a time span through the Real client (so the origin pin, https-or-loopback rule,
// SSRF guard, no redirects, time and size caps and key redaction all apply) and returns { lines: [{ text, ts }], hops, ... }.
// Every shown line is redacted here (tokens, keys, passwords) before anything scores or displays it.
//   k8s-pod : Kubernetes pod log through `kubectl proxy` (loopback). GET /api/v1/namespaces/<ns>/pods/<pod>/log?container=<c>&sinceSeconds=<n>
//             &timestamps=true&tailLines=<n>. A label selector (PRIV_LOG_K8S_POD=app=name) is resolved by listing pods first.
//   search  : an Elasticsearch/OpenSearch-style _search with a time range.
//   privilege-hosted : Privilege's own logs in its hosted Elasticsearch, read through the console's elasticlog API
//             (POST <console>/api/<tenant>/v1/elasticlog; the answer wraps the search result in base64): the runtime indices
//             policy-decision-log, aiguard-log, proxy-audit-log, agent-approval-log, proxy-event-log and the console indices audit-log,
//             event-log. Every entry keeps its index, which says whether it is a console or a runtime event.
import { randomUUID } from 'node:crypto';
import { RealError } from './realClient.js';
import { hitLine } from './logparse.js';
import { parseTs, MAX_SOURCE_LINES } from './matcher.js';
import { redactLine } from './redact.js';
import { MAX_LINE, MAX_LINES } from './scorer.js';
import { formatTraceparent } from './trace.js';
import { PRIVILEGE_INDICES, kindOf } from './eventKind.js';
import { searchWindow } from './searchClient.js';

export const K8S_MAX_BYTES = 1_048_576;
export const K8S_TAIL_LINES = 3000;
export const MAX_PODS = 3;

export function sourcesFrom(cfg) {
  const out = [];
  if (cfg.k8s) out.push({ id: 'k8s-pod', label: 'Kubernetes pod log (kubectl proxy)', origin: cfg.k8s.origin, host: cfg.k8s.host });
  if (cfg.search) out.push({ id: 'search', label: 'Search endpoint (_search)', origin: cfg.search.origin, host: cfg.search.host });
  if (cfg.decisions) out.push({ id: 'privilege-hosted', label: 'Privilege logs, read through the console (elasticlog)', origin: cfg.decisions.origin, host: cfg.decisions.host });
  return out;
}

const enc = encodeURIComponent;

function hopOf(label, trace, span, url, method, res, extraHeaders = {}) {
  const tp = formatTraceparent(trace.traceId, span);
  return { n: 0, label, from: 'lab', to: 'log-source', traceparent: tp, request: { method, url, headers: { traceparent: tp, ...extraHeaders }, body: '' }, response: { status: res.status, headers: res.headers, body: redactLine(res.text.slice(0, 4000)), truncated: res.truncated, ms: res.ms, redirect: res.redirect } };
}

const fail = (code, detail, hop, status = 502) => Object.assign(new RealError(code, detail, status), { hop });

// Plain log text -> [{ text (redacted, prefix timestamp removed), ts }]. Keeps the newest MAX_SOURCE_LINES.
export function linesFromText(text) {
  const raw = String(text).split('\n').filter((l) => l.trim());
  return raw.slice(-MAX_SOURCE_LINES).map((l) => { const { ts, rest } = parseTs(l.slice(0, MAX_LINE + 40)); return { text: redactLine(rest), ts }; });
}

export async function readK8s({ client, k8s, fromMs, now, trace }) {
  const hops = [];
  const base = k8s.url.origin;
  const sinceSeconds = Math.min(86_400, Math.max(5, Math.ceil((now - fromMs) / 1000) + 5));
  let pods = [k8s.pod];
  if (k8s.selector) {
    const url = `${base}/api/v1/namespaces/${enc(k8s.namespace)}/pods?labelSelector=${enc(k8s.selector)}&limit=20`;
    const res = await client.request({ url, method: 'GET', headers: { accept: 'application/json', traceparent: formatTraceparent(trace.traceId, trace.span()) }, maxBytes: 262_144 });
    const hop = hopOf('list pods by label selector', trace, trace.span(), url, 'GET', res);
    hops.push(hop);
    if (res.status !== 200) throw Object.assign(fail('source_http_error', `kubectl proxy answered HTTP ${res.status} listing pods`, hop), { hops });
    let items = null;
    try { items = JSON.parse(res.text)?.items; } catch { /* not JSON */ }
    if (!Array.isArray(items)) throw Object.assign(fail('source_bad_shape', 'the pod list is not a Kubernetes PodList', hop), { hops });
    pods = items.filter((p) => p?.status?.phase === 'Running' && typeof p?.metadata?.name === 'string' && /^[a-z0-9][-a-z0-9.]{0,251}$/.test(p.metadata.name))
      .sort((a, b) => String(b.metadata.creationTimestamp).localeCompare(String(a.metadata.creationTimestamp))).slice(0, MAX_PODS).map((p) => p.metadata.name);
    if (!pods.length) throw Object.assign(fail('source_no_pod', `no Running pod matches the selector ${k8s.selector}`, hop, 404), { hops });
  }
  const lines = []; let truncated = false; const problems = [];
  for (const pod of pods) {
    const url = `${base}/api/v1/namespaces/${enc(k8s.namespace)}/pods/${enc(pod)}/log?container=${enc(k8s.container)}&sinceSeconds=${sinceSeconds}&timestamps=true&tailLines=${K8S_TAIL_LINES}`;
    const span = trace.span();
    try {
      const res = await client.request({ url, method: 'GET', headers: { accept: '*/*', traceparent: formatTraceparent(trace.traceId, span) }, maxBytes: K8S_MAX_BYTES });
      const hop = hopOf(`read the pod log (${pod})`, trace, span, url, 'GET', res);
      hops.push(hop);
      if (res.redirect) throw fail('redirect_refused', 'kubectl proxy answered a redirect; redirects are never followed', hop);
      if (res.status !== 200) throw fail('source_http_error', res.status === 404 ? `kubectl proxy answered 404: pod ${pod} or container ${k8s.container} not found in namespace ${k8s.namespace}` : `kubectl proxy answered HTTP ${res.status}`, hop);
      if (res.truncated) truncated = true;
      lines.push(...linesFromText(res.text));
    } catch (e) { if (e.hop && !hops.includes(e.hop)) hops.push(e.hop); problems.push(e.detail || e.message); }
  }
  if (problems.length === pods.length) throw Object.assign(new RealError('source_unreachable', problems[0], 502), { hops });
  return { lines: lines.slice(-MAX_SOURCE_LINES), hops, truncated, notes: problems.length ? `${problems.length} of ${pods.length} pod(s) could not be read: ${problems[0]}` : '' };
}

export async function readSearch({ client, search, index, fromMs, toMs, trace }) {
  try {
    const r = await searchWindow({ client, searchUrl: search.origin, index, fromMs, toMs, trace });
    const hop = { ...r.hop, response: { ...r.hop.response, body: redactLine(String(r.hop.response.body).slice(0, 4000)) } };
    return { lines: r.lines.map((l) => { const text = redactLine(l.text); return { text, ts: l.ts, kind: kindOf({ text }) }; }), hops: [hop], truncated: false, notes: '' };
  } catch (e) { throw Object.assign(e, { hops: e.hop ? [e.hop] : [] }); }
}

export const DECISION_MAX_BYTES = 1_048_576;

// The request the console's own pages send, for all seven indices at once. The console wants an x-procyon-session-id header; the local
// console does not check its value (a fresh random one is sent each time). Records do not carry the run marker, so they are matched to
// the call by time window and app (inferred). Decision records carry User, AgentKey, Target (the tool), Decision, Reason and PolicyIDs.
export async function readDecisions({ client, decisions, fromMs, toMs, trace }) {
  const url = `${decisions.url.origin}/api/${enc(decisions.tenant)}/v1/elasticlog`;
  const span = trace.span(); const tp = formatTraceparent(trace.traceId, span);
  const body = JSON.stringify({ Indices: { Elems: PRIVILEGE_INDICES }, Filters: { UserName: '', DeviceName: '', ResourceName: '', RequestID: '' }, Size: 200,
    StartTime: new Date(fromMs).toISOString(), EndTime: new Date(toMs).toISOString(), From: 0, Attributes: { Map: { track_total_hits: 'true' } }, ObjectMeta: { Namespace: 'default', Tenant: decisions.tenant } });
  const headers = { 'content-type': 'application/json', accept: 'application/json', 'x-procyon-session-id': randomUUID(), traceparent: tp };
  const res = await client.request({ url, method: 'POST', headers, body, maxBytes: DECISION_MAX_BYTES });
  const hop = { n: 0, label: 'read Privilege\'s logs through the console', from: 'lab', to: 'log-source', traceparent: tp, request: { method: 'POST', url, headers, body },
    // The answer's Response field is the search result in base64: it would carry every record (and any key in it) past the redactor,
    // so the raw hop shows its size only. The decoded, redacted records are the entries.
    response: { status: res.status, headers: res.headers, body: redactLine(res.text.replace(/"Response"\s*:\s*"[A-Za-z0-9+/=]*"/, (m) => `"Response":"<base64 search result, ${m.length} bytes: decoded and redacted into the entries, not shown here>"`).slice(0, 4000)), truncated: res.truncated, ms: res.ms, redirect: res.redirect } };
  if (res.redirect) throw fail('redirect_refused', 'the console answered a redirect; redirects are never followed', hop);
  if (res.status !== 200) throw fail('source_http_error', `the console answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (is the PingOne Privilege desktop app running and signed in?)' : ''}`, hop);
  let hits = null;
  try {
    const outer = JSON.parse(res.text);
    const inner = typeof outer?.Response === 'string' ? JSON.parse(Buffer.from(outer.Response.slice(0, DECISION_MAX_BYTES * 2), 'base64').toString('utf8')) : outer?.Response;
    hits = inner?.hits?.hits;
  } catch { /* not the console's shape */ }
  if (!Array.isArray(hits)) throw fail('source_bad_shape', 'the console answer holds no log records (Response.hits.hits)', hop);
  const lines = hits.slice(0, MAX_LINES).map((h) => {
    const t = h?._source?.['@timestamp']; const ts = typeof t === 'string' ? Date.parse(t) : NaN;
    const index = typeof h?._index === 'string' && PRIVILEGE_INDICES.includes(h._index) ? h._index : null;
    const text = redactLine(hitLine(h));
    return { text, ts: Number.isFinite(ts) ? ts : null, index, kind: kindOf({ index, text }) };
  });
  return { lines, hops: [hop], truncated: res.truncated, notes: res.truncated ? 'the console answer was cut at the size cap' : '' };
}

export async function readSource(src, { client, cfg, fromMs, toMs, now, trace }) {
  if (src.id === 'k8s-pod') return readK8s({ client, k8s: cfg.k8s, fromMs, now, trace });
  if (src.id === 'privilege-hosted') return readDecisions({ client, decisions: cfg.decisions, fromMs, toMs, trace });
  return readSearch({ client, search: cfg.search, index: cfg.index, fromMs, toMs, trace });
}
