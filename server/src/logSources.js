// Log source adapters. Each reads raw log lines for a time span through the Real client (so the origin pin, https-or-loopback rule,
// SSRF guard, no redirects, time and size caps and key redaction all apply) and returns { lines: [{ text, ts }], hops, ... }.
// Every shown line is redacted here (tokens, keys, passwords) before anything scores or displays it.
//   k8s-pod : Kubernetes pod log through `kubectl proxy` (loopback). GET /api/v1/namespaces/<ns>/pods/<pod>/log?container=<c>&sinceSeconds=<n>
//             &timestamps=true&tailLines=<n>. A label selector (PRIV_LOG_K8S_POD=app=name) is resolved by listing pods first.
//   search  : an Elasticsearch/OpenSearch-style _search with a time range.
import { RealError } from './realClient.js';
import { hitLine } from './logparse.js';
import { parseTs, MAX_SOURCE_LINES } from './matcher.js';
import { redactLine } from './redact.js';
import { MAX_LINE } from './scorer.js';
import { formatTraceparent } from './trace.js';
import { searchWindow } from './searchClient.js';

export const K8S_MAX_BYTES = 1_048_576;
export const K8S_TAIL_LINES = 3000;
export const MAX_PODS = 3;

export function sourcesFrom(cfg) {
  const out = [];
  if (cfg.k8s) out.push({ id: 'k8s-pod', label: 'Kubernetes pod log (kubectl proxy)', origin: cfg.k8s.origin, host: cfg.k8s.host });
  if (cfg.search) out.push({ id: 'search', label: 'Search endpoint (_search)', origin: cfg.search.origin, host: cfg.search.host });
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
      const res = await client.request({ url, method: 'GET', headers: { accept: 'text/plain', traceparent: formatTraceparent(trace.traceId, span) }, maxBytes: K8S_MAX_BYTES });
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
    return { lines: r.lines.map((l) => ({ text: redactLine(l.text), ts: l.ts })), hops: [hop], truncated: false, notes: '' };
  } catch (e) { throw Object.assign(e, { hops: e.hop ? [e.hop] : [] }); }
}

export async function readSource(src, { client, cfg, fromMs, toMs, now, trace }) {
  if (src.id === 'k8s-pod') return readK8s({ client, k8s: cfg.k8s, fromMs, now, trace });
  return readSearch({ client, search: cfg.search, index: cfg.index, fromMs, toMs, trace });
}
