// The lab's behaviour: list the cases, replay one (Mock), drive one through the gateway (Real), score, build the Markdown table.
import { randomBytes } from 'node:crypto';
import { FIELDS } from './capture.js';
import { scoreLines, diffScores } from './scorer.js';
import { newTrace, formatTraceparent } from './trace.js';
import { makeMarker, notRunnable, rpcFor, rpcWithMarker, runMcp } from './mcpRunner.js';
import { matchEntry } from './matcher.js';
import { redactLine } from './redact.js';
import { readSource, sourcesFrom } from './logSources.js';
import { RealError } from './realClient.js';

// The sinks the Real mode can add on top of the five measured ones.
export const EXTRA_SINKS = [
  { id: 'search', name: 'Your search endpoint (PRIV_LOG_SEARCH_URL)', summary: 'Events read back from the search endpoint you configured, for the time window of the call. Whatever else was logged in that window is included.' },
  { id: 'pasted', name: 'Pasted log lines', summary: 'Lines you pasted into the paste box. Scored with the same scorer as every other line.' },
];

export const naFields = (c) => FIELDS.filter((f) => c.score?.[f] === 'na');

export const REAL_ONLY_NOTE = 'No recorded measurement yet. Real mode only.';

export function caseSummary(c, { bearerConfigured = false } = {}) {
  const why = notRunnable(c);
  return {
    id: c.id, group: c.group, title: c.title, identity: c.identity, request: c.request, realRunnable: why === null, realNote: why,
    realOnly: c.realOnly === true, needs: c.needs || [], consoleAction: c.consoleAction === true, heldCall: c.heldCall === true,
    needsBearer: c.request.auth === 'bearer', bearerConfigured, mockNote: c.realOnly ? REAL_ONLY_NOTE : null,
  };
}

// Marks for the Trace page: for every sink and line, the facts the scorer found in that line (for inline highlighting).
export function marksFor(logged, ctx) {
  const marks = {};
  for (const sink of logged) {
    const r = scoreLines(sink.lines, ctx);
    const bySink = {};
    for (const f of FIELDS) for (const e of r.evidence[f]) (bySink[e.line] ||= []).push({ field: f, level: e.level, start: e.start, end: e.end, why: e.why });
    marks[sink.source] = bySink;
  }
  return marks;
}

// A hop as the page shows it: raw text for the request and the response (the Real client has already redacted the key).
const headerText = (h) => Object.entries(h || {}).map(([k, v]) => `${k}: ${String(v).slice(0, 600)}`).join('\n');
export function textHop(h, n) {
  const rq = h.request; const rs = h.response;
  return {
    n, label: h.label, from: h.from, to: h.to, traceparent: h.traceparent,
    request: typeof rq === 'string' ? rq : `${rq.method} ${rq.url}\n${headerText(rq.headers)}\n\n${String(rq.body ?? '').slice(0, 6000)}`,
    response: typeof rs === 'string' ? rs : `HTTP ${rs.status} (${rs.ms} ms${rs.truncated ? ', truncated at the size cap' : ''}${rs.redirect ? ', redirect NOT followed' : ''})\n${headerText(rs.headers)}\n\n${String(rs.body ?? '').slice(0, 6000)}`,
  };
}

const allLines = (logged) => logged.flatMap((l) => l.lines);

const noteFrom = (r) => Object.fromEntries(FIELDS.filter((f) => r.evidence[f].length).map((f) => [f, r.evidence[f].map((e) => e.why).filter((w, i, a) => a.indexOf(w) === i).slice(0, 3).join('; ')]));

export function mockRun(c, capture, { rand = randomBytes } = {}) {
  const trace = newTrace(undefined, rand);
  const a = trace.span(); const b = trace.span();
  const ctx = { na: naFields(c) };
  const r = scoreLines(allLines(c.logged), ctx);
  const wire = notRunnable(c) === null ? rpcFor(c) : null;
  return {
    caseId: c.id, group: c.group, title: c.title, identity: c.identity, source: 'mock', ranAt: null, recordedOn: capture.capturedOn,
    request: c.request, wire, outcome: c.outcome, response: { http: c.outcome.http, note: c.outcome.note },
    logged: c.logged, marks: marksFor(c.logged, ctx), score: c.score, scoreNotes: c.scoreNotes,
    recomputed: { score: r.score, diff: diffScores(c.score, r.score) }, scored: true, needsPaste: false,
    traceId: trace.traceId,
    hops: [
      { n: 1, from: 'browser', to: 'lab', label: 'The page asks the lab to replay the case', traceparent: formatTraceparent(trace.traceId, a), request: `POST /api/run {"caseId":"${c.id}"}\ntraceparent: ${formatTraceparent(trace.traceId, a)}`, response: `200 OK: recorded response and ${c.logged.reduce((n, l) => n + l.lines.length, 0)} recorded log line(s)` },
      { n: 2, from: 'lab', to: 'replay', label: 'The lab reads the recorded transaction (in-process, no network)', traceparent: formatTraceparent(trace.traceId, b), request: wire ? `would send (NOT sent): ${JSON.stringify(wire)}` : `case request (NOT sent): ${JSON.stringify(c.request)}`, response: `recorded HTTP ${c.outcome.http}: ${c.outcome.note}` },
    ],
  };
}

// The inferred flags: a field is "inferred" when every line that supports it was matched by the time window, not by the marker.
function inferredFlags(r, logged) {
  const methods = logged.flatMap((l) => l.methods || l.lines.map(() => 'recorded'));
  return Object.fromEntries(FIELDS.map((f) => [f, r.evidence[f].length > 0 && r.evidence[f].every((e) => methods[e.line] === 'window')]));
}

// MOCK, phase 1: "send". Nothing is sent; the recorded transaction is only looked up. The result carries no log lines yet.
export function mockSend(c, capture, { rand = randomBytes } = {}) {
  const full = mockRun(c, capture, { rand });
  return {
    ...full, logged: [], marks: {}, score: null, scoreNotes: {}, recomputed: null, scored: false, needsPaste: false,
    retrieval: { state: 'pending', phase: 'fetching', simulated: true, attempt: 0, method: null, detail: 'Replaying the recorded log entry.' },
  };
}
// MOCK, phase 2: "fetch the log entry": the recorded lines, after a short fixed simulated delay (done by the caller).
export function mockFetch(run, c, capture) {
  const full = mockRun(c, capture);
  return {
    ...run, logged: full.logged.map((l) => ({ ...l, methods: l.lines.map(() => 'recorded') })), marks: full.marks, score: full.score, scoreNotes: full.scoreNotes,
    recomputed: full.recomputed, scored: true, needsPaste: false,
    retrieval: { state: 'found', phase: 'done', simulated: true, attempt: 1, method: 'recorded', detail: 'Recorded sample lines from the 2026-11-07 measurement.' },
  };
}

// REAL, phase 1: send the case (marker embedded), note the send and receipt times. Nothing is read yet.
export async function realSend(c, { client, cfg, bearer, now = Date.now, rand = randomBytes, since = null }) {
  const why = notRunnable(c);
  if (why) throw Object.assign(new Error(why), { code: 'not_runnable', detail: why, status: 409 });
  const trace = newTrace(undefined, rand);
  const sources = sourcesFrom(cfg);
  const base = {
    caseId: c.id, group: c.group, title: c.title, identity: c.identity, source: 'real', recordedOn: null, request: c.request, traceId: trace.traceId,
    realOnly: c.realOnly === true, recomputed: null, score: null, scoreNotes: {}, scored: false, marks: {}, logged: [],
  };
  const retrieval = (extra) => ({ phase: sources.length ? 'fetching' : 'none', attempt: 0, method: null, sources: sources.map((s) => ({ id: s.id, label: s.label, state: 'pending' })), ...extra });
  if (c.consoleAction) {
    // A console action: nothing is sent. The lab looks for what the log source recorded since the time given.
    const t = now();
    const from = since ?? t - 15 * 60_000;
    return { ...base, ranAt: new Date(t).toISOString(), wire: null, outcome: { http: null, isError: false, note: 'console action: nothing was sent' }, response: { http: null, note: 'console action: nothing was sent' },
      marker: null, markerWhere: null, timing: { sentAt: t, receivedAt: t, since: from }, hops: [], needsPaste: !sources.length,
      retrieval: sources.length ? retrieval({ state: 'pending', startedAt: t, detail: `Looking for entries since ${new Date(from).toISOString()}.` }) : { state: 'not_configured', phase: 'none', detail: NOT_CONFIGURED, sources: [] } };
  }
  const marker = makeMarker(rand);
  const t0 = now();
  const mcp = await runMcp({ client, gatewayUrl: cfg.gateway.url.href, key: cfg.key, bearer, c, trace, marker });
  const t1 = now();
  const logged = [];
  if (mcp.auditHeader) logged.push({ source: 'response', lines: [mcp.auditHeader], methods: ['response'], note: 'X-Gw-Audit-Trail header as returned to the caller (UNVERIFIED format).' });
  return {
    ...base, ranAt: new Date(t1).toISOString(), wire: mcpWire(c, marker), outcome: mcp.outcome, response: { http: mcp.outcome.http, note: mcp.outcome.note }, logged,
    marker, markerWhere: mcp.markerWhere, timing: { sentAt: t0, receivedAt: t1, since: null }, hops: mcp.hops.map((h, i) => textHop(h, i + 1)), needsPaste: !sources.length,
    retrieval: sources.length ? retrieval({ state: 'pending', startedAt: now(), detail: 'Request sent. Looking for the log entry.' }) : { state: 'not_configured', phase: 'none', detail: NOT_CONFIGURED, sources: [] },
  };
}

export const NOT_CONFIGURED = 'No log source is configured (set PRIV_LOG_K8S_PROXY_URL with PRIV_LOG_K8S_NAMESPACE and PRIV_LOG_K8S_POD, or PRIV_LOG_SEARCH_URL). Paste the gateway log lines below instead.';
const mcpWire = (c, marker) => (c.request.method === 'tools/list' || c.request.method === 'tools/call' ? rpcWithMarker(c, marker).rpc : null);

// REAL, phase 2: ONE attempt to find the call's log entry. The page calls this about once a second until the state is not "pending".
//   found       lines matched by marker (and, near it, by time window)
//   pending     nothing yet (or only window candidates while the marker still has time to appear); the page retries
//   timeout     nothing within maxMs of the retrieval start; the page offers Retry
//   unreachable every configured source failed; the page offers Retry
export async function fetchAttempt(run, c, { client, cfg, now = Date.now, limits, rand = randomBytes, restart = false }) {
  const sources = sourcesFrom(cfg);
  if (!sources.length) return { ...run, retrieval: { state: 'not_configured', phase: 'none', detail: NOT_CONFIGURED, sources: [] } };
  const prev = run.retrieval || {};
  const startedAt = restart || !prev.startedAt ? now() : prev.startedAt;
  const attempt = restart ? 1 : (prev.attempt || 0) + 1;
  const elapsedMs = now() - startedAt;
  const trace = newTrace(undefined, rand);
  const { sentAt, receivedAt, since } = run.timing;
  const fromMs = since ?? sentAt - 2000;
  const results = []; const hops = []; const srcState = [];
  for (const src of sources) {
    try {
      const r = await readSource(src, { client, cfg, fromMs, toMs: now() + 1000, now: now(), trace });
      hops.push(...r.hops);
      results.push({ src, lines: r.lines, truncated: r.truncated, notes: r.notes });
      srcState.push({ id: src.id, label: src.label, state: 'ok', lines: r.lines.length, note: r.notes || (r.truncated ? 'the response was cut at the size cap' : '') });
    } catch (e) {
      if (e.hops) hops.push(...e.hops); else if (e.hop) hops.push(e.hop);
      srcState.push({ id: src.id, label: src.label, state: 'error', lines: 0, error: client.redact(e.detail || e.message), code: e.code });
    }
  }
  const safe = (h) => (typeof h.response === 'object' ? { ...h, response: { ...h.response, body: redactLine(String(h.response.body ?? '')) } } : h);
  const newHops = hops.map(safe).map((h, i) => textHop(h, (run.hops?.filter((x) => x.to !== 'log-source').length || 0) + i + 1));
  const keepHops = [...(run.hops || []).filter((h) => h.to !== 'log-source'), ...newHops];
  const base = { ...run, hops: keepHops };
  if (!results.length) {
    return { ...base, retrieval: { ...prev, state: 'unreachable', phase: 'failed', attempt, startedAt, elapsedMs, sources: srcState, detail: `Log source not reachable: ${srcState[0].error}` } };
  }
  const windowAllowed = elapsedMs >= limits.fallbackMs || run.group === 'Rejected' || !!since || !run.marker;
  const app = run.request.app || appFromGateway(cfg);
  const logged = run.logged.filter((l) => l.source === 'response');
  let method = null; let markerLines = 0; let windowLines = 0; let ignored = 0;
  for (const r of results) {
    const m = matchEntry({ lines: r.lines, marker: run.marker, t0: sentAt, t1: receivedAt, app, rejected: run.group === 'Rejected', windowAllowed, since });
    markerLines += m.markerLines; windowLines += m.windowLines; ignored += m.ignored;
    if (m.lines.length) {
      logged.push({ source: r.src.id, lines: m.lines.map((x) => x.text), methods: m.lines.map((x) => x.method), note: matchNote(m, r, run) });
      if (m.state === 'marker') method = 'marker'; else if (!method) method = 'window';
    }
  }
  const sourceLogged = logged.filter((l) => l.source !== 'response');
  if (!sourceLogged.length) {
    const timedOut = elapsedMs >= limits.maxMs;
    return { ...base, retrieval: { ...prev, state: timedOut ? 'timeout' : 'pending', phase: timedOut ? 'failed' : 'fetching', attempt, startedAt, elapsedMs, maxMs: limits.maxMs, sources: srcState, ignored,
      detail: timedOut ? `No entry found within ${Math.round(limits.maxMs / 1000)} s.` : `No entry found yet after ${Math.round(elapsedMs / 1000)} s (retrying until ${Math.round(limits.maxMs / 1000)} s).` } };
  }
  const ctx = { na: naFields(c) };
  const r = scoreLines(allLines(logged), ctx);
  return {
    ...base, logged, marks: marksFor(logged, ctx), score: r.score, scoreNotes: noteFrom(r), scoreInferred: inferredFlags(r, logged), scored: true, needsPaste: false,
    retrieval: { ...prev, state: 'found', phase: 'done', attempt, startedAt, elapsedMs, method, markerLines, windowLines, ignored, sources: srcState,
      detail: method === 'marker' ? `Found by the run marker ${run.marker}${windowLines ? `, plus ${windowLines} neighbouring line(s) by time window (inferred)` : ''}.` : `The marker was not logged; matched by time window and app path (inferred).` },
  };
}

function appFromGateway(cfg) { const m = /^\/([^/]+)\/mcp\/?$/.exec(cfg.gateway.url.pathname); return m ? m[1] : null; }
function matchNote(m, r, run) {
  const parts = [`${m.markerLines} line(s) matched by the marker, ${m.windowLines} by time window (inferred)`];
  if (m.ignored) parts.push(`${m.ignored} other line(s) in the span ignored`);
  if (r.notes) parts.push(r.notes);
  if (run.timing.since) parts.push('console action: every line since the chosen time is shown (inferred)');
  return `${parts.join('; ')}.`;
}

// Pasted lines: score them (and, in Real, attach them to a run). Returns the scorer output plus marks.
export function scorePasted(lines, c) {
  const ctx = { na: c ? naFields(c) : [] };
  const r = scoreLines(lines, ctx);
  const logged = [{ source: 'pasted', lines: lines.slice(0, 500), note: 'Lines you pasted.' }];
  return { score: r.score, scoreNotes: noteFrom(r), evidence: r.evidence, marks: marksFor(logged, ctx), lines: r.lines, truncated: r.truncated, logged };
}

const cell = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
const chipWord = (l) => (l === 'na' ? 'n/a' : l ?? 'not run');
const scoreWord = (r, f) => (r.score ? chipWord(r.score[f]) + (r.inferred?.[f] ? ' (inferred)' : '') : r.notMeasured ? 'not measured' : 'not run');

// The scorecard rows for the current mode. rows[] = { id, group, title, score|null, notes, ran }.
export function scorecardRows(capture, getRun, source) {
  const measured = capture.cases.map((c) => {
    if (source === 'mock') return { id: c.id, group: c.group, title: c.title, identity: c.identity, score: c.score, notes: c.scoreNotes, ran: true, realOnly: false };
    const r = getRun(c.id);
    return { id: c.id, group: c.group, title: c.title, identity: c.identity, score: r?.scored ? r.score : null, notes: r?.scored ? r.scoreNotes : {}, inferred: r?.scored ? r.scoreInferred : undefined, ran: !!r, needsPaste: !!r && !r.scored, realOnly: false };
  });
  // Cases never measured: "not measured" in Mock, and until a Real run produces log lines. Never a fabricated result.
  const pending = (capture.realOnly || []).map((c) => {
    const r = source === 'real' ? getRun(c.id) : null;
    return { id: c.id, group: c.group, title: c.title, identity: c.identity, score: r?.scored ? r.score : null, notes: r?.scored ? r.scoreNotes : {}, inferred: r?.scored ? r.scoreInferred : undefined, ran: !!r, needsPaste: !!r && !r.scored, realOnly: true, notMeasured: !r?.scored, needs: c.needs };
  });
  return [...measured, ...pending];
}

export function toMarkdown(rows, { source, capturedOn, requirement }) {
  const head = source === 'mock'
    ? `Measured on ${capturedOn} (replay of recorded transactions, not a live test). Scored against the requirement: ${requirement.map((r) => r.replace(/^[a-d]\.\s*/i, '')).join('; ')}.`
    : `Real run, scored from the log lines actually returned. Rows not run, or run without log lines, are marked not run. Requirement: ${requirement.map((r) => r.replace(/^[a-d]\.\s*/i, '')).join('; ')}.`;
  const lines = [head, '', '| Use case | Group | User | Agent | Tool | Decision | Notes |', '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const r of rows) {
    const notes = Object.entries(r.notes || {}).map(([f, n]) => `${f}: ${n}`).join(' ');
    lines.push(`| ${cell(r.title)} | ${cell(r.group)} | ${FIELDS.map((f) => scoreWord(r, f)).join(' | ')} | ${cell(notes)} |`);
  }
  lines.push('', 'met = a log line names it; partial = implied or incomplete; missing = not in the log; n/a = not applicable to the use case; not measured = no recorded measurement yet (Real mode only); (inferred) = matched by time window, not by the run marker.');
  return lines.join('\n');
}

// Attach pasted lines to a Real run: the run keeps its other sinks, gets (or replaces) the pasted sink, and is scored from everything.
export function attachPasted(run, c, pastedLines) {
  const ctx = { na: naFields(c) };
  const logged = [...run.logged.filter((l) => l.source !== 'pasted'), { source: 'pasted', lines: pastedLines.slice(0, 500), note: 'Lines you pasted.' }];
  const r = scoreLines(allLines(logged), ctx);
  return { ...run, logged, marks: marksFor(logged, ctx), score: r.score, scoreNotes: noteFrom(r), scored: true, needsPaste: false };
}
