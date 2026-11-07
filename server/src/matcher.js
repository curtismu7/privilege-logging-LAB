// The matcher: which of the lines a log source returned belong to ONE call. Pure, bounded, no I/O.
//  1. MARKER first. The run embeds a unique marker (audit-<runid>) in the request; a line that contains it is the call's own line
//     (method "marker"). Other lines written within TIGHT_MS of a marker line, inside the call window, are the same call's neighbours
//     (method "window": inferred, because only the clock ties them to the call).
//  2. No marker line: fall back to the call WINDOW, from just before the send to a few seconds after the receipt, and, when the
//     case names an app, only lines that do not name another app. A Rejected call logs only app, method, path and caller address,
//     so there the lines must also name the app path. Every such line is method "window" (inferred).
// Lines without a timestamp cannot be placed in a window, so they are only ever matched by marker.
import { MAX_LINE } from './scorer.js';

export const WINDOW_BEFORE_MS = 1000; // before the send
export const WINDOW_AFTER_MS = 3000;  // after the receipt
export const TIGHT_MS = 1500;         // around a marker line
export const MAX_SOURCE_LINES = 5000;
export const MAX_SHOWN = 200;

const APP_TOKEN = /(?:path=\/|\bapp=|Application |access to |\{Application )([a-z0-9][a-z0-9-]{0,47})/g;

// Names of apps a line mentions. Linear, anchored on literal prefixes.
export function appsIn(text) {
  const out = new Set();
  for (const m of String(text).slice(0, MAX_LINE).matchAll(APP_TOKEN)) out.add(m[1]);
  return out;
}

// Timestamp of a line, from a leading RFC 3339 token (kubectl --timestamps), a logrus time="..." pair, or the caller (a search hit's @timestamp).
export function parseTs(text) {
  const t = String(text);
  const head = t.slice(0, 40);
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(head)) { const n = Date.parse(head.split(' ')[0]); if (Number.isFinite(n)) return { ts: n, rest: t.slice(t.indexOf(' ') + 1) }; }
  const i = t.indexOf('time="');
  if (i >= 0 && i < 200) { const j = t.indexOf('"', i + 6); if (j > 0 && j - i < 60) { const n = Date.parse(t.slice(i + 6, j)); if (Number.isFinite(n)) return { ts: n, rest: t }; } }
  return { ts: null, rest: t };
}

// lines: [{ text, ts|null }] in log order. Returns { lines: [{ text, method }], state, markerLines, windowLines, ignored }.
//   state: 'marker' | 'window' | 'none'
export function matchEntry({ lines, marker, t0, t1, app = null, rejected = false, windowAllowed = false, since = null }) {
  const input = lines.slice(-MAX_SOURCE_LINES);
  const lo = since !== null ? since : t0 - WINDOW_BEFORE_MS;
  const hi = since !== null ? t1 : t1 + WINDOW_AFTER_MS;
  const inWindow = (l) => l.ts !== null && l.ts >= lo && l.ts <= hi;
  const otherApp = (l) => app !== null && [...appsIn(l.text)].some((a) => a !== app);
  const namesApp = (l) => app !== null && appsIn(l.text).has(app);

  const markerHits = marker ? input.map((l, i) => (l.text.includes(marker) ? i : -1)).filter((i) => i >= 0) : [];
  if (markerHits.length) {
    const anchors = markerHits.map((i) => input[i].ts).filter((x) => x !== null);
    const out = [];
    input.forEach((l, i) => {
      if (markerHits.includes(i)) out.push({ text: l.text, method: 'marker' });
      else if (inWindow(l) && !otherApp(l) && anchors.some((a) => Math.abs(l.ts - a) <= TIGHT_MS)) out.push({ text: l.text, method: 'window' });
    });
    const shown = out.slice(0, MAX_SHOWN);
    return { state: 'marker', lines: shown, markerLines: markerHits.length, windowLines: shown.filter((x) => x.method === 'window').length, ignored: input.length - shown.length };
  }
  if (!windowAllowed) return { state: 'none', lines: [], markerLines: 0, windowLines: 0, ignored: input.length };
  const cand = input.filter((l) => inWindow(l) && !otherApp(l) && (!rejected || namesApp(l)));
  const shown = cand.slice(0, MAX_SHOWN).map((l) => ({ text: l.text, method: 'window' }));
  return { state: shown.length ? 'window' : 'none', lines: shown, markerLines: 0, windowLines: shown.length, ignored: input.length - shown.length };
}
