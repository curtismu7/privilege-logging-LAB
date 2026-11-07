// Turns pasted text (or a search response) into the bounded list of lines the scorer reads.
// Accepts: plain log lines (logrus text, JSON records one per line), a JSON array of strings or records, and an
// Elasticsearch/OpenSearch _search response (hits.hits[]._source). Everything is bounded and nothing is evaluated.
import { MAX_LINE, MAX_LINES } from './scorer.js';
import { redactLine } from './redact.js';

export const MAX_PASTE_BYTES = 200_000;

const oneLine = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? null)).replace(/[\r\n]+/g, ' ').slice(0, MAX_LINE);

// A hit becomes one line: its message text when it has one (a shipper's log line), else the whole record as JSON.
export function hitLine(hit) {
  const src = hit && typeof hit === 'object' && hit._source && typeof hit._source === 'object' ? hit._source : hit;
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const k of ['message', 'msg', 'log', 'line']) if (typeof src[k] === 'string' && src[k].trim()) return oneLine(src[k]);
  }
  return oneLine(src);
}

export function parsePaste(text) {
  if (typeof text !== 'string') return { lines: [], problem: 'text must be a string' };
  if (Buffer.byteLength(text, 'utf8') > MAX_PASTE_BYTES) return { lines: [], problem: `pasted text is over ${MAX_PASTE_BYTES} bytes` };
  const t = text.trim();
  if (!t) return { lines: [] };
  if (t[0] === '[' || (t[0] === '{' && t.includes('"hits"'))) {
    try {
      const doc = JSON.parse(t);
      const arr = Array.isArray(doc) ? doc : doc?.hits?.hits;
      if (Array.isArray(arr)) return finish(arr.slice(0, MAX_LINES).map(hitLine));
    } catch { /* fall through: treat as lines */ }
  }
  return finish(t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.slice(0, MAX_LINE)));
}

function finish(all) {
  // Pasted and returned lines are redacted (tokens, JWTs, keys, passwords) before anything scores or shows them.
  const lines = all.slice(0, MAX_LINES).map(redactLine);
  return { lines, truncated: all.length > MAX_LINES };
}
