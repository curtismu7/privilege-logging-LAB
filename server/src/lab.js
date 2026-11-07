// The lab's behaviour: list the cases, replay one (Mock), drive one through the gateway (Real), score, build the Markdown table.
import { randomBytes } from 'node:crypto';
import { FIELDS } from './capture.js';
import { scoreLines, diffScores } from './scorer.js';
import { newTrace, formatTraceparent } from './trace.js';
import { notRunnable, rpcFor, runMcp } from './mcpRunner.js';
import { searchWindow } from './searchClient.js';

// The sinks the Real mode can add on top of the five measured ones.
export const EXTRA_SINKS = [
  { id: 'search', name: 'Your search endpoint (PRIV_LOG_SEARCH_URL)', summary: 'Events read back from the search endpoint you configured, for the time window of the call. Whatever else was logged in that window is included.' },
  { id: 'pasted', name: 'Pasted log lines', summary: 'Lines you pasted into the paste box. Scored with the same scorer as every other line.' },
];

export const naFields = (c) => FIELDS.filter((f) => c.score[f] === 'na');

export function caseSummary(c) {
  const why = notRunnable(c);
  return { id: c.id, group: c.group, title: c.title, identity: c.identity, request: c.request, realRunnable: why === null, realNote: why };
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

// MOCK: replay the recorded case. The recorded score is the assessment; the scorer is re-run on the sample lines and any difference is shown.
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

// REAL: drive the case through the gateway, then read the log events for the call window (or ask for pasted lines).
export async function realRun(c, { client, cfg, waitMs = 1500, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), rand = randomBytes }) {
  const why = notRunnable(c);
  if (why) { const e = new Error(why); e.code = 'not_runnable'; e.detail = why; e.status = 409; throw e; }
  const trace = newTrace(undefined, rand);
  const t0 = now();
  const mcp = await runMcp({ client, gatewayUrl: cfg.gateway.url.href, key: cfg.key, c, trace });
  const t1 = now();
  const hops = [...mcp.hops];
  const logged = [];
  if (mcp.auditHeader) logged.push({ source: 'response', lines: [mcp.auditHeader], note: 'X-Gw-Audit-Trail header as returned to the caller (UNVERIFIED format).' });
  let searched = false; let searchProblem = null;
  if (cfg.search) {
    if (waitMs > 0) await sleep(waitMs);
    try {
      const s = await searchWindow({ client, searchUrl: cfg.search.url.origin, index: cfg.index, fromMs: t0 - 2000, toMs: now() + 1000, trace });
      hops.push({ ...s.hop, n: hops.length + 1 });
      logged.push({ source: 'search', lines: s.lines, note: `${s.total} event(s) between ${new Date(t0 - 2000).toISOString()} and now. Other traffic in that window is included.` });
      searched = true;
    } catch (e) {
      if (e.hop) hops.push({ ...e.hop, n: hops.length + 1 });
      searchProblem = e.detail || e.message;
    }
  }
  const ctx = { na: naFields(c) };
  const scored = searched;
  const lines = allLines(logged);
  const r = scoreLines(lines, ctx);
  return {
    caseId: c.id, group: c.group, title: c.title, identity: c.identity, source: 'real', ranAt: new Date(t1).toISOString(), recordedOn: null,
    request: c.request, wire: rpcFor(c), outcome: mcp.outcome, response: { http: mcp.outcome.http, note: mcp.outcome.note },
    logged, marks: marksFor(logged, ctx),
    score: scored ? r.score : null, scoreNotes: scored ? noteFrom(r) : {}, recomputed: null, scored, needsPaste: !scored, searchProblem,
    traceId: trace.traceId, hops: hops.map((h, i) => textHop(h, i + 1)),
  };
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

// The scorecard rows for the current mode. rows[] = { id, group, title, score|null, notes, ran }.
export function scorecardRows(capture, runs, source) {
  return capture.cases.map((c) => {
    if (source === 'mock') return { id: c.id, group: c.group, title: c.title, identity: c.identity, score: c.score, notes: c.scoreNotes, ran: true };
    const r = runs.get(c.id);
    return { id: c.id, group: c.group, title: c.title, identity: c.identity, score: r?.scored ? r.score : null, notes: r?.scored ? r.scoreNotes : {}, ran: !!r, needsPaste: !!r && !r.scored };
  });
}

export function toMarkdown(rows, { source, capturedOn, requirement }) {
  const head = source === 'mock'
    ? `Measured on ${capturedOn} (replay of recorded transactions, not a live test). Scored against the requirement: ${requirement.map((r) => r.replace(/^[a-d]\.\s*/i, '')).join('; ')}.`
    : `Real run, scored from the log lines actually returned. Rows not run, or run without log lines, are marked not run. Requirement: ${requirement.map((r) => r.replace(/^[a-d]\.\s*/i, '')).join('; ')}.`;
  const lines = [head, '', '| Use case | Group | User | Agent | Tool | Decision | Notes |', '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const r of rows) {
    const notes = Object.entries(r.notes || {}).map(([f, n]) => `${f}: ${n}`).join(' ');
    lines.push(`| ${cell(r.title)} | ${cell(r.group)} | ${FIELDS.map((f) => chipWord(r.score?.[f])).join(' | ')} | ${cell(notes)} |`);
  }
  lines.push('', 'met = a log line names it; partial = implied or incomplete; missing = not in the log; n/a = not applicable to the use case.');
  return lines.join('\n');
}

// Attach pasted lines to a Real run: the run keeps its other sinks, gets (or replaces) the pasted sink, and is scored from everything.
export function attachPasted(run, c, pastedLines) {
  const ctx = { na: naFields(c) };
  const logged = [...run.logged.filter((l) => l.source !== 'pasted'), { source: 'pasted', lines: pastedLines.slice(0, 500), note: 'Lines you pasted.' }];
  const r = scoreLines(allLines(logged), ctx);
  return { ...run, logged, marks: marksFor(logged, ctx), score: r.score, scoreNotes: noteFrom(r), scored: true, needsPaste: false };
}
