// Reads back log events from an Elasticsearch/OpenSearch-style endpoint: POST <origin>/<index>/_search with a time-range query.
// Read-only (a search is a POST but changes nothing), through the same Real client, so the same origin pin, SSRF guard, no-redirect,
// time and size caps apply. The timestamp field name "@timestamp" is an assumption (UNVERIFIED for any given index).
import { RealError } from './realClient.js';
import { hitLine } from './logparse.js';
import { MAX_LINES } from './scorer.js';
import { formatTraceparent } from './trace.js';

export async function searchWindow({ client, searchUrl, index, fromMs, toMs, trace, size = 200 }) {
  const path = `${index ? `/${encodeURIComponent(index).replace(/%2C/gi, ',').replace(/%2A/g, '*')}` : ''}/_search`;
  const url = new URL(path, searchUrl).href;
  const span = trace.span();
  const body = JSON.stringify({ size: Math.min(size, MAX_LINES), sort: [{ '@timestamp': 'asc' }], query: { range: { '@timestamp': { gte: new Date(fromMs).toISOString(), lte: new Date(toMs).toISOString() } } } });
  const headers = { 'content-type': 'application/json', accept: 'application/json', traceparent: formatTraceparent(trace.traceId, span) };
  const res = await client.request({ url, method: 'POST', headers, body });
  let hits = null;
  try { hits = JSON.parse(res.text)?.hits?.hits; } catch { /* not JSON */ }
  const hop = { n: 0, label: 'search the log store for the call window', from: 'lab', to: 'search', traceparent: headers.traceparent, request: { method: 'POST', url, headers, body }, response: { status: res.status, headers: res.headers, body: res.text, truncated: res.truncated, ms: res.ms, redirect: res.redirect } };
  if (res.redirect) throw Object.assign(new RealError('redirect_refused', 'the search endpoint answered a redirect; redirects are never followed', 502), { hop });
  if (res.status < 200 || res.status >= 300) throw Object.assign(new RealError('search_failed', `search answered HTTP ${res.status}`, 502), { hop });
  if (!Array.isArray(hits)) throw Object.assign(new RealError('search_bad_shape', 'search answer has no hits.hits array', 502), { hop });
  const lines = hits.slice(0, MAX_LINES).map((h) => {
    const t = h?._source?.['@timestamp'] ?? h?._source?.timestamp;
    const ts = typeof t === 'string' || typeof t === 'number' ? Date.parse(t) : NaN;
    return { text: hitLine(h), ts: Number.isFinite(ts) ? ts : null };
  });
  return { hop, lines, total: hits.length };
}
