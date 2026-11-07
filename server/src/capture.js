// The measured capture (server/data/capture.json, schema privilege-logging-capture/1): loader and a strict validator.
// The fixture is data measured on 2026-11-07 and already sanitised to placeholders. This module never edits its meaning.
import fs from 'node:fs';
import { scanHosts } from './safety.js';

export const SCHEMA = 'privilege-logging-capture/1';
export const FIELDS = ['user', 'agent', 'tool', 'decision'];
export const LEVELS = ['met', 'partial', 'missing', 'na'];
export const GROUPS = ['MCP', 'AI Guard', 'Rejected', 'Aggregate', 'A2A', 'LLM', 'Intent'];
// Groups of cases that have NOT been measured yet (realOnly). They have no recorded lines and no score until a Real run produces lines.
export const REAL_ONLY_GROUPS = ['Keys', 'Federated identity', 'Approvals', 'Registry lifecycle'];
export const AUTHS = ['agent-key', 'bearer'];
export const REAL_ONLY_FILE = new URL('../data/real-only-cases.json', import.meta.url);
export const CAPTURE_FILE = new URL('../data/capture.json', import.meta.url);

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const txt = (v, max) => typeof v === 'string' && v.length <= max;

// Returns the list of problems; empty means valid. Never throws. Walks the data with plain loops (no recursion on user data).
export function validateCapture(d) {
  const p = [];
  if (!isObj(d)) return ['capture must be an object'];
  if (d.schema !== SCHEMA) p.push(`schema must be "${SCHEMA}"`);
  if (typeof d.capturedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.capturedOn)) p.push('capturedOn must be YYYY-MM-DD');
  if (!txt(d.sources, 400) || !d.sources) p.push('sources must be short text');
  if (!Array.isArray(d.requirement) || d.requirement.length !== 4 || !d.requirement.every((r) => txt(r, 200) && r)) p.push('requirement must be the four lettered clauses');

  const sinkIds = new Set();
  if (!Array.isArray(d.sinks) || !d.sinks.length || d.sinks.length > 12) p.push('sinks must be a non-empty array (max 12)');
  else for (const [i, s] of d.sinks.entries()) {
    const at = `sink ${i + 1}`;
    if (!isObj(s)) { p.push(`${at} must be an object`); continue; }
    if (typeof s.id !== 'string' || !ID.test(s.id)) p.push(`${at}: bad id`);
    else if (sinkIds.has(s.id)) p.push(`${at}: duplicate id ${s.id}`);
    else sinkIds.add(s.id);
    if (!txt(s.name, 120) || !s.name) p.push(`${at}: name required`);
    if (!txt(s.summary, 600) || !s.summary) p.push(`${at}: summary required`);
    if (s.unverified !== undefined && typeof s.unverified !== 'boolean') p.push(`${at}: unverified must be true or false`);
  }

  const caseIds = new Set();
  if (!Array.isArray(d.cases) || !d.cases.length || d.cases.length > 60) p.push('cases must be a non-empty array (max 60)');
  else for (const [i, c] of d.cases.entries()) {
    const at = `case ${i + 1}`;
    if (!isObj(c)) { p.push(`${at} must be an object`); continue; }
    if (typeof c.id !== 'string' || !ID.test(c.id)) p.push(`${at}: bad id`);
    else if (caseIds.has(c.id)) p.push(`${at}: duplicate id ${c.id}`);
    else caseIds.add(c.id);
    const realOnly = c.realOnly === true;
    if (c.realOnly !== undefined && typeof c.realOnly !== 'boolean') p.push(`${at}: realOnly must be true or false`);
    if (!(realOnly ? REAL_ONLY_GROUPS : GROUPS).includes(c.group)) p.push(`${at}: group must be one of ${(realOnly ? REAL_ONLY_GROUPS : GROUPS).join(', ')}`);
    if (c.needs !== undefined && (!Array.isArray(c.needs) || c.needs.length > 6 || !c.needs.every((n) => txt(n, 48) && n))) p.push(`${at}: needs must be up to 6 short strings`);
    if (isObj(c.request) && c.request.auth !== undefined && !AUTHS.includes(c.request.auth)) p.push(`${at}: request.auth must be one of ${AUTHS.join(', ')}`);
    for (const k of ['consoleAction', 'heldCall']) if (c[k] !== undefined && typeof c[k] !== 'boolean') p.push(`${at}: ${k} must be true or false`);
    if (!txt(c.title, 160) || !c.title) p.push(`${at}: title required`);
    if (!txt(c.identity, 120) || !c.identity) p.push(`${at}: identity required`);
    if (!isObj(c.request) || typeof c.request.method !== 'string') p.push(`${at}: request.method required`);
    if (realOnly) {
      // An unmeasured case carries NO recorded evidence: no outcome, no lines, no score. Anything else would be a fabricated result.
      if (c.outcome !== undefined) p.push(`${at}: a realOnly case must not carry a recorded outcome`);
      if (c.score !== undefined || c.scoreNotes !== undefined) p.push(`${at}: a realOnly case must not carry a score`);
      if (c.logged !== undefined && !(Array.isArray(c.logged) && c.logged.length === 0)) p.push(`${at}: a realOnly case must not carry recorded log lines`);
      if (!Array.isArray(c.needs) || !c.needs.length) p.push(`${at}: a realOnly case must say what it needs`);
      continue;
    }
    if (!isObj(c.outcome) || !Number.isInteger(c.outcome.http) || c.outcome.http < 100 || c.outcome.http > 599 || !txt(c.outcome.note, 300)) p.push(`${at}: outcome needs http 100-599 and a note`);
    if (!Array.isArray(c.logged) || c.logged.length > 12) p.push(`${at}: logged must be an array`);
    else for (const [j, l] of c.logged.entries()) {
      const lat = `${at} logged ${j + 1}`;
      if (!isObj(l) || !sinkIds.has(l.source)) { p.push(`${lat}: source must be a known sink id`); continue; }
      if (!Array.isArray(l.lines) || l.lines.length > 50 || !l.lines.every((x) => txt(x, 4000))) p.push(`${lat}: lines must be up to 50 text lines`);
      if (!txt(l.note, 600)) p.push(`${lat}: note must be text`);
    }
    if (!isObj(c.score) || !FIELDS.every((f) => LEVELS.includes(c.score[f])) || Object.keys(c.score).length !== FIELDS.length) p.push(`${at}: score needs exactly user, agent, tool, decision, each one of ${LEVELS.join('|')}`);
    if (!isObj(c.scoreNotes) || !Object.entries(c.scoreNotes).every(([k, v]) => FIELDS.includes(k) && txt(v, 600))) p.push(`${at}: scoreNotes keys must be fields, values text`);
  }

  // Hygiene on everything shipped: only reserved hosts, no real-looking UUID. (JSON.stringify is iterative over a plain tree of known shape.)
  if (!p.length) {
    const all = JSON.stringify(d);
    // A bare service name with no dot (for example a placeholder app name in a 'failed to dial' line) is not a hostname anyone can resolve.
    const hosts = scanHosts(all).map((h) => h.replace(/\.+$/, '')).filter((h) => h.includes('.'));
    if (hosts.length) p.push(`non-reserved hosts in the capture: ${hosts.join(', ')}`);
    if (UUID.test(all)) p.push('a real-looking UUID is in the capture (must be a <placeholder>)');
  }
  return p;
}

// cases = the MEASURED cases (recorded outcome, lines and score). realOnly = cases that have not been measured: they are listed, never
// replayed in Mock, and have no score until a Real run produces log lines. They live in server/data/real-only-cases.json.
export function loadCapture(file = CAPTURE_FILE, pendingFile = REAL_ONLY_FILE) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = validateCapture(doc);
  if (problems.length) throw new Error(`capture is not ${SCHEMA}: ${problems.slice(0, 5).join('; ')}`);
  let pending = [];
  if (pendingFile) {
    const pdoc = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    const pp = validateCapture({ ...doc, cases: pdoc.cases });
    if (pp.length) throw new Error(`real-only cases are not valid: ${pp.slice(0, 5).join('; ')}`);
    if (!pdoc.cases.every((c) => c.realOnly === true)) throw new Error('every case in real-only-cases.json must set realOnly: true');
    pending = pdoc.cases;
  }
  const ids = new Set(doc.cases.map((c) => c.id));
  if (pending.some((c) => ids.has(c.id))) throw new Error('a real-only case reuses a measured case id');
  return { ...doc, cases: doc.cases.filter((c) => !c.realOnly), realOnly: [...doc.cases.filter((c) => c.realOnly), ...pending] };
}
