import http from 'node:http';
import { createApp, startHttpServer } from '../src/app.js';
import { createHealth } from '../src/health.js';

// Obviously fake. Tests assert this exact string never appears in an API answer.
export const KEY = 'test-agent-key-NOT-REAL-7f3a91c2';
export const NOENV = { STANDALONE_ENV: '/nonexistent/settings.env' };

// env: the settings the app sees (never process.env, never the developer's settings file).
export async function withServer(fn, { env = NOENV, useSettingsFile = false, ...rest } = {}) {
  const health = createHealth({ intervalMs: 3_600_000 });
  await health.ready;
  const { server, url } = await startHttpServer({ port: 0, host: '127.0.0.1', app: createApp({ health, env, useSettingsFile, ...rest }) });
  try { await fn(url.replace(/\/$/, '')); } finally { health.stop(); await new Promise((r) => server.close(r)); }
}

export const post = (url, path, body, headers = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, ...headers }, body: JSON.stringify(body) });
export const get = (url, path, headers = {}) => fetch(`${url}${path}`, { headers });

const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
const listen = async (server) => { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; };

// A FAKE Privilege gateway speaking MCP streamable HTTP on loopback. Never a real gateway.
export async function fakeGateway({ key = KEY, audit = null, redirectTo = null, bigBody = false, hang = false } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (hang) return; // never answers: the client's time cap must fire
    if (redirectTo) { res.writeHead(302, { location: redirectTo }); return res.end(); }
    if (bigBody) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('x'.repeat(2_000_000)); }
    if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }); return res.end(`{"error":"unauthorized","echo":"${req.headers.authorization || ''}"}`); }
    let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400); return res.end('{}'); }
    const json = (obj, headers = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...headers, ...(audit ? { 'x-gw-audit-trail': audit } : {}) }); res.end(JSON.stringify(obj)); };
    if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-gateway', version: '0' } } }, { 'mcp-session-id': 'sess-fake-1' });
    if (req.headers['mcp-session-id'] !== 'sess-fake-1') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"no session"}'); }
    if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    if (msg.method === 'tools/call') {
      if (msg.params.name === 'no_such_tool') return json({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'Forbidden: tool not granted' }] } });
      return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'sunny' }] } });
    }
    if (msg.method === 'tools/list') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'get_weather' }] } })}\n\n`); }
    return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  });
  const base = await listen(server);
  return { base, url: `${base}/demo-mcp-app/mcp`, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

// A FAKE Elasticsearch/OpenSearch-style _search endpoint on loopback. events: [{ '@timestamp', message|... }] (the time range is applied).
export async function fakeSearch({ events = [], status = 200, raw = null } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (raw !== null) { res.writeHead(status, { 'content-type': 'application/json' }); return res.end(raw); }
    let q; try { q = JSON.parse(body); } catch { q = {}; }
    const range = q?.query?.range?.['@timestamp'] || {};
    const hits = events.filter((e) => (!range.gte || e['@timestamp'] >= range.gte) && (!range.lte || e['@timestamp'] <= range.lte)).map((e) => ({ _index: 'x', _source: e }));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hits: { hits } }));
  });
  const base = await listen(server);
  return { base, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

// A bare server that records any request (used to prove a redirect or a second origin is never contacted).
export async function recorder() {
  const requests = [];
  const server = http.createServer(async (req, res) => { requests.push({ method: req.method, url: req.url }); res.writeHead(200); res.end('x'); });
  const base = await listen(server);
  return { base, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

export function realEnv(gw, search) {
  return { ...NOENV, PRIV_LOG_GATEWAY_URL: gw.url, PRIV_LOG_AGENT_KEY: KEY, ...(search ? { PRIV_LOG_SEARCH_URL: search.base, PRIV_LOG_SEARCH_INDEX: 'gateway-events' } : {}) };
}

// fetch cannot set Host; node:http can.
export function rawHttp(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
