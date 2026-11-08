// The scorer: a pure function. Given the log lines of ONE call it decides, for each field of the audit requirement
// (a. user, b. agent, c. tool, d. authorization decision), whether the lines carry it:
//   met      a line names the value (a user id, a named agent or key, the tool, an authorization allow/deny verdict);
//   partial  a line carries it weakly or by inference (an app-level permission line, an agent=true flag with no name,
//            an OAuth client id that names a client not an agent, a list that names removed tools but not the called one,
//            a guardrail block, which is a guardrail verdict and not an authorization policy decision);
//   missing  nothing in the lines says it.
// `na` (not applicable) is never decided from lines: the caller passes ctx.na = ['tool', ...] for fields the use case cannot have.
//
// It reads two shapes: logrus-style text lines (key=value, msg="...") and JSON records (also JSON after a text prefix).
// Safety: input is bounded (lines, line length), parsing is a single linear pass with indexOf and a key=value tokenizer, the only
// regexes run on values already capped at 200 characters and are anchored with no nested quantifiers, JSON is walked with an explicit
// stack (depth 5), and nothing is evaluated. Same function for the mock fixture, Real search hits and pasted text.
import { FIELDS } from './capture.js';

export const MAX_LINES = 500;
export const MAX_LINE = 4096;
export const RANK = { missing: 0, partial: 1, met: 2 };

const STOP = new Set([',', ' ', '"', '}', '\\', '\n', '\r', '\t', ')']);
const VALUE_END = new Set([' ', ')', ',', ';', '}', '\t']);
const EMPTY = new Set(['', '<empty>', 'null', 'none', 'nil', '-', 'anonymous', 'unknown', 'n/a', 'undefined']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONGHEX = /^[0-9a-f]{24,64}$/i;

const USER_KEYS = new Set(['user', 'userid', 'user_id', 'username', 'sub', 'principal', 'upn', 'custodian']);
const AGENT_KEYS = new Set(['client', 'clientid', 'client_id', 'agent', 'agentid', 'agent_id', 'actor', 'act', 'keyname', 'key_name', 'agentkey']);
// target: the tool on a Privilege policy decision record (Data.Target).
const TOOL_KEYS = new Set(['tool', 'toolname', 'tool_name', 'target_tool', 'target']);
const DECISION_KEYS = new Set(['decision', 'policy_decision', 'policydecision', 'verdict', 'authz', 'authorization_decision', 'allowed', 'effect']);

// True when a client value names an OAuth client rather than an agent or key: a UUID, a long hex id, or a placeholder/name that says "oauth".
export function looksLikeOAuthClient(v) {
  const s = String(v).slice(0, 200);
  return UUID.test(s) || LONGHEX.test(s) || /oauth/i.test(s) || /^<[^>]{0,60}client[^>]{0,60}>$/i.test(s);
}

const clean = (v) => String(v).slice(0, 200).trim();

// The facts one line carries. Each: { field, level, why, start, end } where start/end locate the value in the line (or -1).
function factsOf(line) {
  const out = [];
  const add = (field, level, why, start, end) => out.push({ field, level, why, start: start ?? -1, end: end ?? -1 });
  const at = (marker) => line.indexOf(marker);
  const take = (from) => { let j = from; while (j < line.length && !STOP.has(line[j])) j += 1; return j; };

  const userValue = (value, start, end, why) => { if (!EMPTY.has(clean(value).toLowerCase())) add('user', 'met', why, start, end); };
  const agentValue = (value, start, end, why) => {
    const v = clean(value);
    if (EMPTY.has(v.toLowerCase()) || v.toLowerCase() === 'false') return;
    if (v.toLowerCase() === 'true') add('agent', 'partial', `${why}: a flag, no agent name`, start, end);
    else if (looksLikeOAuthClient(v)) add('agent', 'partial', `${why}: names the OAuth client, not an agent`, start, end);
    else add('agent', 'met', `${why}: a named client, taken as the agent or key (a log line cannot prove the client is an agent)`, start, end);
  };

  // 1. Known gateway line shapes (text markers).
  let i = at('Access token found for user: ');
  if (i >= 0) {
    const s = i + 'Access token found for user: '.length; const e = take(s);
    userValue(line.slice(s, e), s, e, 'access-token line names the user');
    const c = line.indexOf('client: ', e);
    if (c >= 0) { const cs = c + 'client: '.length; const ce = take(cs); agentValue(line.slice(cs, ce), cs, ce, 'client on the access-token line'); }
  }
  i = at('Principal {User ');
  if (i >= 0) { const s = i + 'Principal {User '.length; const e = line.indexOf('}', s); userValue(line.slice(s, e < 0 ? s : e), s, e < 0 ? s : e, 'principal line names the user'); }
  for (const phrase of ['has permission for', 'has policy based capabilities for']) {
    i = at(phrase);
    if (i >= 0) add('decision', 'partial', 'app-level permission line: the decision is implied, there is no per-call allow line', i, i + phrase.length);
  }
  i = at('policy denied ');
  if (i >= 0) {
    const s = i + 'policy denied '.length; const e = take(s);
    userValue(line.slice(s, e), s, e, 'denial line names the user');
    add('decision', 'met', 'explicit policy denial', i, i + 'policy denied'.length);
    const a = line.indexOf('(agent=', e);
    if (a >= 0) { const as = a + '(agent='.length; const ae = line.indexOf(')', as); const end = ae < 0 ? as : ae; agentValue(line.slice(as, end), as, end, 'denial line flags agent'); }
  }
  // "Access Denied" is a policy verdict only on a gateway line ([mcpgw]); the same words anywhere else say a refusal happened, not which policy decided.
  i = at('Access Denied');
  if (i >= 0) {
    if (line.includes('[mcpgw]')) add('decision', 'met', 'access denied on a gateway policy line', i, i + 'Access Denied'.length);
    else add('decision', 'partial', 'access denied text outside a gateway policy line: a refusal, not a recorded policy decision', i, i + 'Access Denied'.length);
  }
  i = at('MCP call detected for method tools with target: ');
  if (i >= 0) { const s = i + 'MCP call detected for method tools with target: '.length; const e = take(s); if (e > s) add('tool', 'met', 'MCP call line names the tool', s, e); }
  for (const phrase of ['Removing unauthorized tool from MCP response: ', 'Removing unauthorized prompt from MCP response: ']) {
    i = at(phrase);
    if (i >= 0) {
      const s = i + phrase.length; const e = take(s);
      if (phrase.includes('tool')) add('tool', 'partial', 'names a tool removed from a list, not a tool that was called', s, e);
      add('decision', 'partial', 'filtering implies a decision per item, no allow/deny line', i, i + phrase.length - 2);
    }
  }
  i = at('aiguard: blocked');
  if (i >= 0) add('decision', 'partial', 'guardrail verdict, no authorization decision line', i, i + 'aiguard: blocked'.length);
  i = at('auth rejected');
  if (i >= 0) add('decision', 'partial', 'authentication refusal: says the call was rejected, not which policy decided', i, i + 'auth rejected'.length);
  // An "aiintent: ... unavailable" warning says the intent check could not run: it carries no allow or deny verdict, so it is no decision evidence.

  // 2. key=value pairs (logrus/logfmt), one linear pass.
  if (line.includes('=')) {
    let p = 0;
    while (p < line.length) {
      const eq = line.indexOf('=', p);
      if (eq < 0) break;
      let ks = eq; while (ks > p && /[A-Za-z0-9_.-]/.test(line[ks - 1])) ks -= 1;
      const key = line.slice(ks, eq).toLowerCase();
      let vs = eq + 1; let ve;
      if (line[vs] === '"') { vs += 1; ve = vs; while (ve < line.length && line[ve] !== '"' && ve - vs < 1000) ve += (line[ve] === '\\' ? 2 : 1); }
      else { ve = vs; while (ve < line.length && !VALUE_END.has(line[ve]) && ve - vs < 1000) ve += 1; }
      if (key && key.length <= 40) applyKey(key, line.slice(vs, ve), vs, ve, 'key');
      p = Math.max(ve, eq + 1);
    }
  }

  // 3. JSON records: whole line, or from the first "{" (a text prefix before the record).
  const b = line.indexOf('{');
  if (b >= 0 && line.length <= MAX_LINE) {
    const e = line.lastIndexOf('}');
    if (e > b) {
      let doc = null;
      try { doc = JSON.parse(line.slice(b, e + 1)); } catch { /* not JSON */ }
      if (doc && typeof doc === 'object') walkJson(doc);
    }
  }

  function applyKey(key, raw, start, end, via) {
    const v = typeof raw === 'string' ? raw : String(raw);
    const why = `${via} ${key}`;
    if (USER_KEYS.has(key)) userValue(v, start, end, why);
    else if (AGENT_KEYS.has(key)) agentValue(v, start, end, why);
    else if (TOOL_KEYS.has(key)) { if (!EMPTY.has(clean(v).toLowerCase())) add('tool', 'met', why, start, end); }
    else if (DECISION_KEYS.has(key)) {
      const d = clean(v).toLowerCase();
      if (EMPTY.has(d)) return;
      add('decision', /^(allow|allowed|deny|denied|permit|permitted|forbid|forbidden|block|blocked|true|false|permit_|deny_|hitl|approval_required|held)/.test(d) ? 'met' : 'partial', why, start, end);
    } else if (key === 'event') {
      // A denied/forbidden event is a policy verdict; a blocked/rejected event (a guardrail block, a credential refusal) says the call was stopped, not which authorization policy decided.
      const ev = v.slice(0, 80);
      if (/(denied|forbidden)/i.test(ev)) add('decision', 'met', `${via} event ${v.slice(0, 40)}: a denial event`, start, end);
      else if (/(blocked|rejected)/i.test(ev)) add('decision', 'partial', `${via} event ${v.slice(0, 40)}: a block event, not an authorization decision`, start, end);
    }
  }

  // Explicit stack, depth <= 5, at most 400 nodes: a hostile deeply nested or huge record cannot blow the stack or the time.
  function walkJson(root) {
    const stack = [[root, 0]]; let budget = 400;
    while (stack.length && budget > 0) {
      const [node, depth] = stack.pop(); budget -= 1;
      if (Array.isArray(node)) { if (depth < 5) for (const x of node.slice(0, 50)) if (x && typeof x === 'object') stack.push([x, depth + 1]); continue; }
      const method = typeof node.method === 'string' ? node.method : null;
      if (method === 'tools/call' && node.params && typeof node.params === 'object' && typeof node.params.name === 'string') {
        const name = node.params.name; const s = line.indexOf(name);
        if (name) add('tool', 'met', 'tools/call payload names the tool', s, s < 0 ? -1 : s + name.length);
      }
      for (const [k, v] of Object.entries(node).slice(0, 60)) {
        if (v && typeof v === 'object') { if (depth < 5) stack.push([v, depth + 1]); continue; }
        if (typeof v !== 'string' && typeof v !== 'boolean') continue;
        const text = String(v); const s = typeof v === 'string' ? line.indexOf(`"${text}"`) + 1 : -1;
        applyKey(k.toLowerCase(), text, s > 0 ? s : -1, s > 0 ? s + text.length : -1, 'json');
      }
    }
  }
  return out;
}

// scoreLines(lines, ctx) -> { score, evidence, lines, truncated }
//   evidence[field] = [{ line, start, end, level, why }]  (line = index into the (bounded) lines array)
export function scoreLines(lines, ctx = {}) {
  const na = new Set((ctx.na || []).filter((f) => FIELDS.includes(f)));
  const input = Array.isArray(lines) ? lines.slice(0, MAX_LINES) : [];
  const evidence = Object.fromEntries(FIELDS.map((f) => [f, []]));
  input.forEach((raw, idx) => {
    const line = typeof raw === 'string' ? raw.slice(0, MAX_LINE) : '';
    for (const f of factsOf(line)) evidence[f.field].push({ line: idx, start: f.start, end: f.end, level: f.level, why: f.why });
  });
  const score = {};
  for (const f of FIELDS) {
    if (na.has(f)) { score[f] = 'na'; evidence[f] = []; continue; }
    score[f] = evidence[f].reduce((best, e) => (RANK[e.level] > RANK[best] ? e.level : best), 'missing');
  }
  return { score, evidence, lines: input.length, truncated: Array.isArray(lines) && lines.length > MAX_LINES };
}

// Fields whose recomputed level differs from a recorded one: { field: [recorded, recomputed] }.
export function diffScores(recorded, recomputed) {
  return Object.fromEntries(FIELDS.filter((f) => recorded[f] !== recomputed[f]).map((f) => [f, [recorded[f], recomputed[f]]]));
}
