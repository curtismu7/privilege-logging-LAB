// Rule 14: W3C Trace Context on every hop. One trace id per query; a valid incoming `traceparent` header continues its trace,
// anything else starts a new one. Values are random and carry no meaning outside this app.
import { randomBytes } from 'node:crypto';

const TP = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO32 = '0'.repeat(32);
const ZERO16 = '0'.repeat(16);

export function parseTraceparent(v) {
  if (typeof v !== 'string' || v.length !== 55) return null;
  const m = TP.exec(v);
  return m && m[1] !== ZERO32 && m[2] !== ZERO16 && m[3] !== 'ff' ? { traceId: m[1], parentId: m[2], flags: m[3] } : null;
}
export const formatTraceparent = (traceId, spanId, flags = '01') => `00-${traceId}-${spanId}-${flags}`;

export function newTrace(incoming, rand = randomBytes) {
  const p = parseTraceparent(incoming);
  const span = () => rand(8).toString('hex').replace(/^0{16}$/, '0000000000000001');
  return { traceId: p ? p.traceId : rand(16).toString('hex').replace(/^0{32}$/, `${'0'.repeat(31)}1`), parentId: p ? p.parentId : null, span };
}

// The two hops of one query with raw request/response text. `real` = a Loki round trip happened; else the store is in-process.
export function buildQueryHops({ trace, queryText, source, count, lokiRequest, lokiResponse, error }) {
  const a = trace.span(); const b = trace.span();
  const tp = (id) => formatTraceparent(trace.traceId, id);
  return [
    { n: 1, from: 'browser', to: 'lab', label: 'The page asks the lab for log lines', traceparent: tp(a),
      request: `GET /api/logs?query=${encodeURIComponent(queryText).slice(0, 300)}\ntraceparent: ${tp(a)}`, response: error ? `error: ${error}` : `200 OK: ${count} line(s), source=${source}` },
    source === 'real'
      ? { n: 2, from: 'lab', to: 'loki', label: 'The lab asks Loki (read-only, loopback)', traceparent: tp(b),
        request: `${lokiRequest.method} ${lokiRequest.path.slice(0, 400)}\nHost: ${lokiRequest.host}\ntraceparent: ${tp(b)}`, response: lokiResponse ? `HTTP ${lokiResponse.status}: ${lokiResponse.streams} stream(s), ${lokiResponse.bytes} bytes` : `error: ${error}` }
      : { n: 2, from: 'lab', to: 'mock-store', label: 'The lab asks the MOCK store (in-process, no network)', traceparent: tp(b),
        request: `matchQuery(${queryText.slice(0, 300)})\ntraceparent: ${tp(b)}`, response: `${count} line(s) from the seeded stream (MOCK)` },
  ];
}
