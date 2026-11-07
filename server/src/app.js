// One Express app. /api = health, info, the Mock/Real toggle (rule 19), cases, run, score, scorecard, sinks, diagrams, story, reset.
// Loopback Host check and same-origin writes on everything. State is per workspace id (X-Workspace). Serves web/dist when it exists.
// Secrets: the agent key is read inside config.js and handed to the Real client; no route returns it, and Real output is redacted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hostCheck, sameOriginWrites } from './safety.js';
import { createHealth } from './health.js';
import { loadCapture } from './capture.js';
import { bearerFromSettings, modeFrom, realConfig } from './config.js';
import { RealError, createRealClient } from './realClient.js';
import { setAllowedHosts } from './netguard.js';
import { EXTRA_SINKS, REAL_ONLY_NOTE, attachPasted, caseSummary, fetchAttempt, mockFetch, mockSend, realSend, scorePasted, scorecardRows, toMarkdown } from './lab.js';
import { sourcesFrom } from './logSources.js';
import { parsePaste } from './logparse.js';
import { buildStory } from './story.js';
import { DIAGRAM_NAMES, buildDiagram } from './diagramData.js';
import { mountShelfRoute } from './shelfLink.js';
import { createWorkspaces, workspaceFrom } from './workspaces.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');

export function createApp({
  health = createHealth(), env = process.env, useSettingsFile = true, now = Date.now, workspaces = createWorkspaces({ now }),
  capture = loadCapture(), lookup, realTimeoutMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  retryMs = 1000, maxMs = 15_000, fallbackMs = 4000, mockDelayMs = 600,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostCheck);
  app.use(sameOriginWrites);
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  const settingsOpts = { file: useSettingsFile };
  const cfg = () => realConfig(env, settingsOpts); // read on every call: editing the settings file shows up without a restart
  let mode = modeFrom(env, settingsOpts);
  const syncGuard = () => { const c = cfg(); setAllowedHosts(mode === 'real' && c.ok ? [c.gateway.host, ...sourcesFrom(c).map((x) => x.host)] : []); };
  const limits = { intervalMs: retryMs, maxMs, fallbackMs };
  syncGuard();
  health.setRuntime?.(() => (mode === 'real' ? 'live' : 'offline'));

  const allCases = [...capture.cases, ...(capture.realOnly || [])];
  const byId = new Map(allCases.map((c) => [c.id, c]));
  const clientFor = (c, bearer) => createRealClient({ origins: [c.gateway.origin, ...sourcesFrom(c).map((x) => x.origin)], secrets: [c.key, bearer].filter(Boolean), lookup, timeoutMs: realTimeoutMs, now });
  const signature = (c) => `${c.gateway.origin}|${c.search ? c.search.origin : ''}|${c.k8s ? c.k8s.origin : ''}`;
  // A per-case credential only the owner has: the write-only field (this tab) wins over PRIV_LOG_BEARER_<CASEID>. Never returned by any API.
  const bearerOf = (ws, id) => workspaces.state(ws).bearers.get(id) || bearerFromSettings(id, env, settingsOpts);
  const sourcesInfo = (c) => (c.ok ? sourcesFrom(c).map((x) => ({ id: x.id, label: x.label, origin: x.origin })) : []);

  const api = express.Router();
  api.use(express.json({ limit: '300kb' }));
  api.use('/health', health.router);
  mountShelfRoute(api, { env });
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  const withWorkspace = (handler) => async (req, res) => {
    const ws = workspaceFrom(req);
    if (!ws) return res.status(400).json({ error: 'bad_workspace' });
    noStore(res);
    try { return await handler(ws, req, res); } catch (e) { return fail(res, e); }
  };
  const fail = (res, e) => {
    if (e instanceof RealError || e?.code === 'not_runnable') {
      const body = { error: e.code, detail: e.detail || e.message };
      return res.status(e.status || 502).json(body);
    }
    return res.status(500).json({ error: 'internal_error' });
  };
  const exactBody = (body, allowed) => body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every((k) => allowed.includes(k));

  api.get('/info', withWorkspace((ws, _req, res) => {
    const c = cfg();
    const confirmed = c.ok && workspaces.state(ws).confirmed === signature(c);
    res.json({
      mode, source: mode, simulated: mode === 'mock', realAvailable: c.ok, realHint: c.ok ? null : c.problem,
      keyConfigured: c.ok, // presence only; the key itself is write-only and never returned
      searchConfigured: c.ok && !!c.search, capturedOn: capture.capturedOn, caseCount: capture.cases.length,
      retrieval: { ...limits, mockDelayMs, sources: sourcesInfo(c) },
      real: c.ok ? { gatewayOrigin: c.gateway.origin, searchOrigin: c.search ? c.search.origin : null, k8sOrigin: c.k8s ? c.k8s.origin : null, k8sTarget: c.k8s ? `${c.k8s.namespace}/${c.k8s.pod || c.k8s.selector}:${c.k8s.container}` : null, index: c.index, confirmed } : null,
    });
  }));
  // Rule 19: exactly { source: "mock"|"real" }; 409 when Real is not configured.
  api.post('/mode', (req, res) => {
    const body = req.body;
    if (!exactBody(body, ['source']) || Object.keys(body).length !== 1 || !['mock', 'real'].includes(body.source)) return res.status(400).json({ error: 'bad_source', detail: 'body must be exactly { source: "mock" | "real" }' });
    const c = cfg();
    if (body.source === 'real' && !c.ok) return res.status(409).json({ error: 'real_not_configured', detail: c.problem });
    mode = body.source;
    syncGuard();
    return res.json({ source: mode });
  });

  api.get('/story', (_req, res) => { noStore(res); res.json(buildStory(capture)); });
  api.get('/cases', withWorkspace((ws, _req, res) => res.json({ groups: [...new Set(allCases.map((c) => c.group))], cases: allCases.map((c) => caseSummary(c, { bearerConfigured: !!bearerOf(ws, c.id) })) })));
  // A write-only credential for one case (a revoked key, a federated token). Stored in memory for this tab only; the answer says only whether one is set.
  api.post('/bearer', withWorkspace((ws, req, res) => {
    if (!exactBody(req.body, ['caseId', 'bearer']) || typeof req.body.caseId !== 'string' || typeof req.body.bearer !== 'string') return res.status(400).json({ error: 'bad_request', detail: 'body must be { caseId, bearer }' });
    const c = byId.get(req.body.caseId);
    if (!c || c.request.auth !== 'bearer') return res.status(404).json({ error: 'unknown_case', detail: 'that case does not take a bearer' });
    const b = req.body.bearer.trim();
    if (b.length > 2048 || /[\s\u0000-\u001f]/.test(b)) return res.status(400).json({ error: 'bad_bearer', detail: 'a bearer is up to 2048 characters with no spaces or control characters' });
    const st = workspaces.state(ws);
    if (b) st.bearers.set(c.id, b); else st.bearers.delete(c.id);
    return res.json({ caseId: c.id, configured: !!bearerOf(ws, c.id) });
  }));
  api.get('/sinks', (_req, res) => {
    noStore(res);
    // Per sink, from the capture: how many cases it was read for, how many held lines, and how many lines in all.
    const usage = Object.fromEntries(capture.sinks.map((s) => {
      const entries = capture.cases.map((c) => c.logged.find((l) => l.source === s.id)).filter(Boolean);
      return [s.id, { casesRead: entries.length, casesWithLines: entries.filter((e) => e.lines.length).length, lines: entries.reduce((n, e) => n + e.lines.length, 0), totalCases: capture.cases.length }];
    }));
    res.json({ requirement: capture.requirement, sinks: capture.sinks, extraSinks: EXTRA_SINKS, usage, capturedOn: capture.capturedOn });
  });
  api.get('/diagram', (req, res) => { noStore(res); res.json({ names: DIAGRAM_NAMES, ...buildDiagram(DIAGRAM_NAMES.includes(req.query.name) ? req.query.name : undefined) }); });

  api.get('/runs', withWorkspace((ws, _req, res) => res.json({ source: mode, runs: workspaces.listRuns(ws, mode) })));

  // Real: the first send to a configured gateway needs an explicit confirmation of the origins (per workspace).
  api.post('/confirm', withWorkspace((ws, req, res) => {
    if (mode !== 'real') return res.status(409).json({ error: 'mock_mode', detail: 'Nothing is sent in Mock mode, so there is nothing to confirm.' });
    const c = cfg();
    if (!c.ok) return res.status(409).json({ error: 'real_not_configured', detail: c.problem });
    if (!exactBody(req.body, ['gateway']) || req.body.gateway !== c.gateway.origin) return res.status(400).json({ error: 'bad_confirm', detail: `confirm by sending { "gateway": "${c.gateway.origin}" }` });
    workspaces.state(ws).confirmed = signature(c);
    return res.json({ confirmed: true, gatewayOrigin: c.gateway.origin, searchOrigin: c.search ? c.search.origin : null });
  }));

  // Phase 1 of a run: send (Real) or look up the recording (Mock). The log entry is fetched by phase 2 (/api/fetch-log).
  api.post('/run', withWorkspace(async (ws, req, res) => {
    if (!exactBody(req.body, ['caseId', 'since']) || typeof req.body.caseId !== 'string') return res.status(400).json({ error: 'bad_request', detail: 'body must be { caseId, since? }' });
    const c = byId.get(req.body.caseId);
    if (!c) return res.status(404).json({ error: 'unknown_case' });
    let since = null;
    if (req.body.since !== undefined) {
      since = typeof req.body.since === 'string' ? Date.parse(req.body.since) : NaN;
      if (!Number.isFinite(since) || since > now() + 60_000 || since < now() - 86_400_000) return res.status(400).json({ error: 'bad_since', detail: 'since must be an ISO time within the last 24 hours' });
    }
    if (mode === 'mock') {
      if (c.realOnly) return res.status(409).json({ error: 'real_only', detail: REAL_ONLY_NOTE });
      const result = mockSend(c, capture);
      workspaces.putRun(ws, result);
      return res.json(result);
    }
    const conf = cfg();
    if (!conf.ok) return res.status(409).json({ error: 'real_not_configured', detail: conf.problem });
    if (workspaces.state(ws).confirmed !== signature(conf)) {
      return res.status(412).json({ error: 'confirm_required', detail: 'Real mode sends requests to your gateway. Confirm the origins first.', gatewayOrigin: conf.gateway.origin, searchOrigin: conf.search ? conf.search.origin : null, k8sOrigin: conf.k8s ? conf.k8s.origin : null });
    }
    const bearer = c.request.auth === 'bearer' ? bearerOf(ws, c.id) : undefined;
    const client = clientFor(conf, bearer);
    try {
      const result = await realSend(c, { client, cfg: conf, bearer, now, since });
      workspaces.putRun(ws, result);
      return res.json(result);
    } catch (e) {
      if (e instanceof RealError || e?.code === 'not_runnable') {
        const hops = (e.hops || []).map((h, i) => ({ n: i + 1, label: h.label, from: h.from, to: h.to, traceparent: h.traceparent, request: `${h.request.method} ${h.request.url}\n${JSON.stringify(h.request.headers)}\n\n${h.request.body}`, response: `HTTP ${h.response.status}\n${h.response.body.slice(0, 2000)}` }));
        return res.status(e.status || 502).json({ error: e.code, detail: client.redact(e.detail || e.message), hops });
      }
      throw e;
    }
  }));

  // Phase 2: ONE attempt to fetch the call's log entry. The page repeats it about once a second while the answer is retrieval.state "pending".
  api.post('/fetch-log', withWorkspace(async (ws, req, res) => {
    if (!exactBody(req.body, ['caseId', 'restart']) || typeof req.body.caseId !== 'string' || (req.body.restart !== undefined && typeof req.body.restart !== 'boolean')) return res.status(400).json({ error: 'bad_request', detail: 'body must be { caseId, restart? }' });
    const c = byId.get(req.body.caseId);
    if (!c) return res.status(404).json({ error: 'unknown_case' });
    const run = workspaces.getRun(ws, mode, c.id);
    if (!run) return res.status(409).json({ error: 'no_run', detail: 'Run the case first.' });
    if (mode === 'mock') {
      if (run.scored) return res.json(run);
      if (mockDelayMs > 0) await sleep(mockDelayMs); // a short fixed simulated delay, so Mock shows the same two phases as Real
      const out = mockFetch(run, c, capture);
      workspaces.putRun(ws, out);
      return res.json(out);
    }
    const conf = cfg();
    if (!conf.ok) return res.status(409).json({ error: 'real_not_configured', detail: conf.problem });
    if (workspaces.state(ws).confirmed !== signature(conf)) return res.status(412).json({ error: 'confirm_required', detail: 'Confirm the origins first.' });
    const bearer = c.request.auth === 'bearer' ? bearerOf(ws, c.id) : undefined;
    const client = clientFor(conf, bearer);
    const out = await fetchAttempt(run, c, { client, cfg: conf, now, limits, restart: req.body.restart === true });
    workspaces.putRun(ws, out);
    return res.json(out);
  }));

  // Pure scoring of pasted lines (works in both modes). With a caseId in Real mode and an existing run, the lines are attached to that run.
  api.post('/score', withWorkspace((ws, req, res) => {
    if (!exactBody(req.body, ['text', 'caseId']) || typeof req.body.text !== 'string') return res.status(400).json({ error: 'bad_request', detail: 'body must be { text, caseId? }' });
    const c = req.body.caseId === undefined ? null : byId.get(req.body.caseId);
    if (req.body.caseId !== undefined && !c) return res.status(404).json({ error: 'unknown_case' });
    const parsed = parsePaste(req.body.text);
    if (parsed.problem) return res.status(413).json({ error: 'paste_too_large', detail: parsed.problem });
    const out = scorePasted(parsed.lines, c);
    let attached = false;
    if (mode === 'real' && c) {
      const run = workspaces.getRun(ws, 'real', c.id);
      if (run) { workspaces.putRun(ws, attachPasted(run, c, parsed.lines)); attached = true; }
    }
    return res.json({ ...out, attached, caseId: c ? c.id : null });
  }));

  api.get('/scorecard', withWorkspace((ws, _req, res) => {
    const rows = scorecardRows(capture, (id) => workspaces.getRun(ws, 'real', id), mode);
    const markdown = toMarkdown(rows, { source: mode, capturedOn: capture.capturedOn, requirement: capture.requirement });
    res.json({ source: mode, capturedOn: capture.capturedOn, requirement: capture.requirement, rows, markdown });
  }));

  // Reset clears this workspace's runs and its Real confirmation (the mode stays).
  api.post('/reset', withWorkspace((ws, _req, res) => { workspaces.resetWorkspace(ws); res.json({ reset: 'ok', workspace: ws }); }));
  api.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use('/api', api);
  // Errors become short JSON. Express's default handler would send an HTML stack trace with absolute file paths.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = Number(err?.status || err?.statusCode);
    if (status === 413) return res.status(413).json({ error: 'payload_too_large' });
    if (status >= 400 && status < 500) return res.status(status).json({ error: 'bad_request' });
    return res.status(500).json({ error: 'internal_error' });
  });

  if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  }
  return app;
}

export function startHttpServer({ port, host, app = createApp() } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}/` }));
    server.once('error', reject);
  });
}
