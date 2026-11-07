// The measured capture (server/data/capture.json, schema privilege-logging-capture/1): loader and a strict validator.
// The fixture is data measured on 2026-11-07 and already sanitised to placeholders. This module never edits its meaning.
import fs from 'node:fs';
import { scanHosts } from './safety.js';

export const SCHEMA = 'privilege-logging-capture/1';
export const FIELDS = ['user', 'agent', 'tool', 'decision'];
export const LEVELS = ['met', 'partial', 'missing', 'na'];
export const GROUPS = ['MCP', 'AI Guard', 'Rejected', 'Aggregate', 'A2A', 'LLM', 'Intent'];
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
    if (!GROUPS.includes(c.group)) p.push(`${at}: group must be one of ${GROUPS.join(', ')}`);
    if (!txt(c.title, 160) || !c.title) p.push(`${at}: title required`);
    if (!txt(c.identity, 120) || !c.identity) p.push(`${at}: identity required`);
    if (!isObj(c.request) || typeof c.request.method !== 'string') p.push(`${at}: request.method required`);
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

export function loadCapture(file = CAPTURE_FILE) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = validateCapture(doc);
  if (problems.length) throw new Error(`capture is not ${SCHEMA}: ${problems.slice(0, 5).join('; ')}`);
  return doc;
}
