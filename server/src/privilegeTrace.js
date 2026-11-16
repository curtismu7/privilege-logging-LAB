// "What Privilege did" (Rule 25) for this lab: turns what the lab already holds into trace records for the shared GatewayTrace panel.
//   Real: the lab's own hop (mcpRunner.js) keeps every request and answer; the call itself is the exchange shown, the session calls
//         around it (initialize, notifications/initialized) become one line. The gateway reports no per-check detail, so every decision is
//         `inferred` (read from the status) or `observed` (read from the answer), never `checked`.
//   Mock: nothing is sent and the lab has no gateway that runs checks. It replays a transaction recorded on the capture date: the request
//         is the call Real would send, the status and note are the recorded outcome, and the decisions are read from that outcome
//         (`inferred` or `observed`), never `checked`, because this lab computed none of them.
// Nothing secret goes in: the credential is shown masked or shortened, a session id is shortened, cookies are not shown.
import { bearerForDisplay, mockTrace, realTrace, sentHeaders } from './gatewayTrace.js';
import { PROTOCOL_VERSION, notRunnable, parseRpc, rpcFor } from './mcpRunner.js';

export const shortSession = (s) => `${String(s).slice(0, 6)}… (${String(s).length} characters, shortened)`;

// A token-shaped string is shown by its start only: a lab-generated bad token, or one a gateway echoes back, is never shown whole.
const JWT = /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g;
const scrub = (text) => String(text).replace(JWT, (m) => `${m.slice(0, 20)}… (${m.length} characters, shortened)`);

const NEVER_SHOWN = new Set(['cookie', 'set-cookie', 'proxy-authorization']);
const shownAuthorization = (v) => { const m = /^Bearer (.*)$/is.exec(String(v)); return m ? bearerForDisplay(m[1]) : String(v); };
// Headers as the page may show them. The Real client has already masked the agent key and any pasted bearer; this also shortens a
// JWT the lab generated, shortens the session id and drops cookies.
function safeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const name = k.toLowerCase(); const s = String(v);
    if (NEVER_SHOWN.has(name)) out[k] = `<${s.length} characters, not shown>`;
    else if (name === 'mcp-session-id') out[k] = shortSession(s);
    else if (name === 'authorization') out[k] = shownAuthorization(s);
    else out[k] = scrub(s);
  }
  return out;
}
// authorization: null removes the default header, so a call sent without a credential does not show one.
const headersSent = (headers) => ({ authorization: null, ...safeHeaders(headers) });

const asJson = (text) => { try { return JSON.parse(text); } catch { return text; } };
const callName = (c) => `${c.request.method}${c.request.tool ? ` ${String(c.request.tool)}` : ''}`;
const decision = (id, label, outcome, basis, evidence) => ({ id, label, outcome, basis, evidence });

// ---- Real ---------------------------------------------------------------------------------------------------------------
// mcp: what runMcp returned ({ hops, pending? }). Returns [] when nothing was sent.
export function realExchanges(mcp, c, { at } = {}) {
  const hops = mcp?.hops || [];
  const aroundIt = (except) => hops.filter((h) => h !== except).map((h) => ({ label: h.label, status: h.response?.status ?? null }));
  if (mcp?.pending) {
    // A call held for approval: the request was sent and no answer came within the time cap. It is not a pass and not a failure.
    const rq = mcp.pending.request;
    const trace = {
      source: 'real',
      request: { method: rq.method, url: rq.url, headers: sentHeaders(undefined, headersSent(rq.headers)), body: asJson(rq.body) },
      response: null,
      decisions: [decision('held', 'Answer', 'info', 'observed', 'no answer within the time cap: a call held for human approval waits for the approver, so no decision is shown')],
      record: null, at, setup: aroundIt(null),
    };
    return [{ step: 1, title: `Gateway call: ${callName(c)} (held, no answer yet)`, status: null, trace }];
  }
  const primary = hops.find((h) => h.label === c.request.method) || hops[hops.length - 1];
  if (!primary) return [];
  const { request: rq, response: rs } = primary;
  const raw = scrub(rs.body ?? '');
  const parsed = parseRpc(raw, rs.headers?.['content-type']);
  const stream = /event-stream/i.test(rs.headers?.['content-type'] || '');
  const trace = realTrace({
    url: rq.url, rpc: asJson(rq.body), requestHeaders: headersSent(rq.headers),
    status: rs.status, headers: safeHeaders(rs.headers), body: parsed ?? raw, at,
    requestId: rs.headers?.['x-request-id'] || rs.headers?.['request-id'] || rs.headers?.['x-correlation-id'],
    setup: aroundIt(primary),
  });
  // An event stream is shown as the gateway sent it; the decisions were read from the message inside it.
  if (stream) trace.response.body = raw;
  if (rs.truncated) trace.decisions.push(decision('truncated', 'Response size', 'info', 'observed', 'the answer was cut at the size cap, so the lab read only part of it'));
  const title = primary.label === c.request.method ? `Gateway call: ${callName(c)}` : `Gateway session: ${primary.label} (the call itself was not sent)`;
  return [{ step: 1, title, status: rs.status, trace }];
}

// ---- Mock ---------------------------------------------------------------------------------------------------------------
// The decisions a recorded outcome supports. Only the status and the recorded note exist, so these are read from them, never computed.
function decisionsFromOutcome({ http, note }) {
  const answered = `recorded HTTP ${http}`;
  if (http === 200) {
    return [
      decision('authenticated', 'Agent key', 'pass', 'inferred', `${answered}: the gateway answered, which it does only after authenticating the caller.`),
      decision('grant', 'Grant', 'pass', 'inferred', `${answered}, recorded note: ${note}`),
    ];
  }
  if (http === 401) {
    return [
      decision('authenticated', 'Agent key', 'fail', 'inferred', `${answered}: the caller was not accepted. The recording does not say which check failed; the log lines do.`),
      decision('grant', 'Grant', 'skipped', 'inferred', 'not reached: the caller was not accepted'),
    ];
  }
  if (http === 403) {
    return [
      decision('authenticated', 'Agent key', 'pass', 'inferred', `${answered} is answered after the caller is known.`),
      decision('grant', 'Grant', 'fail', 'inferred', `${answered}, recorded note: ${note}. The recording does not say which part of the grant refused it.`),
    ];
  }
  if (/content_blocked/.test(note)) {
    return [
      decision('authenticated', 'Agent key', 'pass', 'inferred', `${answered} is answered after the caller is known.`),
      decision('guard', 'AI Guard', 'fail', 'observed', `recorded note: ${note}`),
    ];
  }
  return [decision('status', `HTTP ${http}`, 'info', 'observed', `recorded note: ${note}`)];
}

// c: a measured case from the capture. Cases whose route this lab has not measured (A2A, LLM, intent) have no request to show: [].
export function mockExchanges(c, { recordedOn, traceparent } = {}) {
  if (notRunnable(c) !== null || !Number.isInteger(c.outcome?.http)) return [];
  const noCredential = c.id === 'no-credential';
  const trace = mockTrace({
    url: `https://gateway.example.invalid/${c.request.app || 'demo-mcp-app'}/mcp`,
    authorization: noCredential ? undefined : 'Bearer ***',
    requestHeaders: { ...(noCredential ? { authorization: null } : {}), 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-session-id': '(set by initialize)', ...(traceparent ? { traceparent } : {}) },
    rpc: rpcFor(c), status: c.outcome.http, headers: {}, body: { recordedNote: c.outcome.note },
    decisions: decisionsFromOutcome(c.outcome),
    record: `The recorded log lines for this call${recordedOn ? ` (measured ${recordedOn})` : ''} are under "What was logged, per sink" below.`,
  });
  return [{ step: 1, title: `Replay: ${callName(c)}`, status: c.outcome.http, trace }];
}
