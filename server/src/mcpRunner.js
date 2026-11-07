// Sends one use case to the configured gateway as MCP streamable HTTP: initialize, notifications/initialized, then the call, carrying
// Mcp-Session-Id, with a W3C traceparent on every hop (rule 14). Returns the raw requests and responses with the key redacted.
// Only MCP cases can be driven (tools/call, tools/list). A2A, LLM and intent cases need routes this lab has not measured: they are
// reported as not runnable in Real (paste log lines for them instead). The key is sent as `Authorization: Bearer <key>` (UNVERIFIED
// for every gateway build: the capture does not record how the measured agent key was presented).
import { randomBytes } from 'node:crypto';
import { RealError } from './realClient.js';
import { formatTraceparent } from './trace.js';

export const PROTOCOL_VERSION = '2025-06-18';
const APP = /^[a-z0-9][a-z0-9-]{0,47}$/;

// Why a case cannot be driven in Real, or null.
export function notRunnable(c) {
  const m = c.request.method;
  if (m === 'tools/call' || m === 'tools/list') return null;
  if (c.consoleAction) return null; // nothing is sent: the lab only looks for entries since a time
  if (m === 'message/send') return 'A2A route and message shape are not measured in this lab (UNVERIFIED). Paste the gateway log lines for an A2A call you made yourself.';
  if (/^POST \/llm\//.test(m)) return 'The LLM route needs a provider path this lab does not know (UNVERIFIED). Paste the log lines for an LLM call you made yourself.';
  return 'This case is a gateway configuration condition, not a call this lab can make. Paste the log lines instead.';
}

// How the case authenticates: the agent key, none, or a deliberately bad credential (the Rejected cases).
export function authFor(c, key, bearer) {
  if (c.id === 'no-credential') return null;
  if (c.id === 'unknown-key') return `Bearer lab-unknown-${randomBytes(6).toString('hex')}`;
  if (c.id === 'malformed-token') return 'Bearer ..not.a.token..';
  if (c.request.auth === 'bearer') {
    if (!bearer) throw new RealError('bearer_needed', `This case sends a credential only you have (${(c.needs || []).join(', ') || 'a bearer'}). Paste it in the write-only field on this case, or set PRIV_LOG_BEARER_${bearerEnvName(c.id)}.`, 409);
    return `Bearer ${bearer}`;
  }
  return `Bearer ${key}`;
}
export const bearerEnvName = (caseId) => String(caseId).toUpperCase().replace(/[^A-Z0-9]/g, '_');

// A unique run marker (audit-<8 hex>) the logs can be searched for.
export const makeMarker = (rand = randomBytes) => `audit-${rand(4).toString('hex')}`;

// The JSON-RPC message for a case with the marker embedded where the case allows it: the first string tool argument (replaced, or
// appended when it is a long sentence such as an injection test), an extra argument for a call with none (a tool that is not granted
// takes no real arguments), or params._meta for tools/list. Returns { rpc, where }.
export function rpcWithMarker(c, marker) {
  if (c.request.method === 'tools/list') return { rpc: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { 'lab/run': marker } } }, where: 'params._meta' };
  const args = { ...(c.request.arguments ?? {}) };
  const key = Object.keys(args).find((k) => typeof args[k] === 'string');
  let where;
  if (key) { args[key] = args[key].length > 20 ? `${args[key]} ${marker}` : marker; where = `params.arguments.${key}`; }
  else { args.lab_run = marker; where = 'params.arguments.lab_run'; }
  return { rpc: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: String(c.request.tool ?? ''), arguments: args } }, where };
}

export function endpointFor(gatewayUrl, c) {
  const app = c.request.app;
  const u = new URL(gatewayUrl);
  if (!app) return u.href;
  if (!APP.test(app)) throw new RealError('bad_case', 'case app name is not a plain slug', 400);
  u.pathname = `/${app}/mcp`; // the app segment is the case's; any other path on the configured URL is replaced
  return u.href;
}

export function rpcFor(c) {
  if (c.request.method === 'tools/list') return { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} };
  return { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: String(c.request.tool ?? ''), arguments: c.request.arguments ?? {} } };
}

// SSE or JSON body -> the JSON-RPC message, or null. Bounded by the client's body cap; no eval.
export function parseRpc(text, contentType = '') {
  const t = String(text);
  const tryJson = (s) => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { return null; } };
  if (/event-stream/i.test(contentType)) {
    let last = null;
    for (const line of t.split('\n')) if (line.startsWith('data:')) { const v = tryJson(line.slice(5).trim()); if (v) last = v; }
    return last;
  }
  return tryJson(t.trim());
}

const clip = (s, n = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);

export async function runMcp({ client, gatewayUrl, key, bearer, c, trace, marker }) {
  const endpoint = endpointFor(gatewayUrl, c);
  const auth = authFor(c, key, bearer);
  const embedded = marker ? rpcWithMarker(c, marker) : { rpc: rpcFor(c), where: null };
  const hops = [];
  let session = null;
  const send = async (label, body, extra = {}) => {
    const span = trace.span();
    const headers = {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION,
      traceparent: formatTraceparent(trace.traceId, span), ...(auth ? { authorization: auth } : {}), ...(session ? { 'mcp-session-id': session } : {}),
    };
    const text = JSON.stringify(body);
    const res = await client.request({ url: endpoint, method: 'POST', headers, body: text });
    const hop = {
      n: hops.length + 1, label, from: 'lab', to: 'gateway', traceparent: headers.traceparent,
      request: { method: 'POST', url: endpoint, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, client.redact(v)])), body: client.redact(text) },
      response: { status: res.status, headers: res.headers, body: res.text, truncated: res.truncated, ms: res.ms, redirect: res.redirect },
      ...extra,
    };
    hops.push(hop);
    return { res, hop };
  };
  const base = { jsonrpc: '2.0' };
  const summarise = (last) => {
    const rpc = parseRpc(last.text, last.headers['content-type']);
    const isError = !!(rpc && (rpc.error || rpc.result?.isError === true));
    const note = rpc?.error ? `JSON-RPC error ${clip(rpc.error.code, 12)}: ${clip(rpc.error.message)}`
      : rpc?.result?.isError ? 'tool result flagged isError'
        : last.redirect ? 'redirect not followed'
          : last.status >= 200 && last.status < 300 ? 'call answered' : clip(last.text, 120);
    return {
      hops, endpoint, marker: marker || null, markerWhere: embedded.where, sessionId: session ? '(set)' : null,
      outcome: { http: last.status, isError, note },
      auditHeader: hops.map((h) => h.response.headers['x-gw-audit-trail']).filter(Boolean).map((v) => clip(v, 4000)).slice(-1)[0] || null,
    };
  };
  try {
    let last = (await send('initialize', { ...base, id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'privilege-logging-lab', version: '0.1.0' } } })).res;
    if (last.status >= 200 && last.status < 300 && !last.redirect) {
      session = last.headers['mcp-session-id'] || null;
      last = (await send('notifications/initialized', { ...base, method: 'notifications/initialized' })).res;
      if (last.status >= 200 && last.status < 300) {
        try { last = (await send(c.request.method, embedded.rpc)).res; } catch (e) {
          // A call held for human approval may not answer within the time cap: that is a result, not a failure. The log is still read.
          if (!(c.heldCall && e instanceof RealError && e.code === 'timeout')) throw e;
          return { ...summarise({ status: null, headers: {}, text: '' }), outcome: { http: null, isError: false, note: 'no answer within the time cap: a call held for approval waits for the approver. The log is still read.' } };
        }
      }
    }
    return summarise(last);
  } catch (e) { e.hops = hops; throw e; } // the hops sent so far are still worth showing
}
