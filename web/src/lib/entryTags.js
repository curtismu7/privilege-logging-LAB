// Tags for one log entry, so the Trace can filter on them. Four groups:
//   type     what the line is about (auth, policy, routing, MCP request, response filter, guardrail, other), from its text
//   match    how it was tied to the call (this call = run marker; nearby = time window, inferred; recorded; pasted)
//   label    the labels already shown: source, runtime/console, and the requirement fields the scorer found
//   identity the keys, users, clients, apps and identities the line names (Privilege RefIDs decoded to their last segment)
// A tag is { group, value }; its id is `${group}:${value}`. Pure: text in, tags out.

const TYPES = [
  ['auth', /workload token (accepted|rejected)|Access token found|auth rejected|token_not_found|invalid virtual key|Bearer token required|unauthori[sz]ed/i],
  ['policy', /is in list|has permission|policy based capabilities|policy denied|AuthorizationReqCheck|RBAC check|polattr|Access Denied|"?Decision"?\s*[:=]|PolicyDecision/i],
  ['routing', /resolved host|Finding frontend|Proxying to|backend node|Domain .* not found/i],
  ['MCP request', /incoming request|MCP call detected|tools\/call|tools\/list|"method"\s*:/i],
  ['response filter', /mcpfilter|modifyMCPResponse/i],
  ['guardrail', /aiguard|guardrail|content_blocked|blocked by security|inspection|jailbreak|prompt injection/i],
];
export const MATCH = { marker: 'this call', window: 'nearby (time window)', recorded: 'recorded sample', pasted: 'pasted', response: 'response header' };
const KIND = { runtime: 'runtime event', console: 'console event' };
const FIELD = { user: 'has user', agent: 'has agent', tool: 'has tool', decision: 'has decision' };

const lastSegment = (b64) => {
  try { const s = atob(b64); return s.includes('@@@') ? s.split('@@@').pop() : null; } catch { return null; }
};
const short = (v) => String(v).replace(/[",}\]]+$/, '').slice(0, 60);

export function identitiesOf(line) {
  const out = [];
  const add = (kind, v) => { if (v) out.push(`${kind} ${short(v)}`); };
  let m;
  const t = String(line);
  if ((m = /workload token (?:accepted|rejected) for key (\S+)(?: issuer=(\S+))?(?: subject=(\S+))?/.exec(t))) { add('key', m[1]); add('subject', m[3]); }
  if ((m = /Access token found for user: ([^,]+), client: ([^\s"]+)/.exec(t))) { add('user', m[1].trim()); add('key', m[2]); }
  if ((m = /resolved host for app ([^\s:]+)/.exec(t))) add('app', m[1]);
  if ((m = /\bapp=([A-Za-z0-9._-]+)/.exec(t))) add('app', m[1]);
  for (const r of t.matchAll(/RefKind:(NonHumanIdentity|User|Application|Group) RefID:([A-Za-z0-9+/=]{8,})/g)) {
    const name = lastSegment(r[2]);
    add({ NonHumanIdentity: 'identity', User: 'user', Application: 'app', Group: 'group' }[r[1]], name);
  }
  for (const [k, kind] of [['AgentKey', 'key'], ['Target', 'app'], ['User', 'user']]) {
    const j = new RegExp(`"${k}"\\s*:\\s*"([^"]{1,80})"`).exec(t);
    if (j) add(kind, j[1]);
  }
  return [...new Set(out)];
}

// line: the raw text; method, kind, from: what LogEntries already knows; fields: the requirement fields the scorer marked.
export function tagsFor(line, { method, kind, from, fields = [] } = {}) {
  const tags = [];
  const types = TYPES.filter(([, re]) => re.test(String(line))).map(([n]) => n);
  for (const n of types.length ? types : ['other']) tags.push({ group: 'type', value: n });
  // Order = what an entry shows first (at most six pills, then "+N more"): type, match, identity, then the labels.
  if (MATCH[method]) tags.push({ group: 'match', value: MATCH[method] });
  for (const i of identitiesOf(line)) tags.push({ group: 'identity', value: i });
  if (from) tags.push({ group: 'label', value: `from ${from}` });
  if (KIND[kind]) tags.push({ group: 'label', value: KIND[kind] });
  for (const f of fields) if (FIELD[f]) tags.push({ group: 'label', value: FIELD[f] });
  return tags;
}

export const tagId = (t) => `${t.group}:${t.value}`;

// An entry passes when, for every group with a selection, it carries at least one of that group's selected tags
// (auth + policy = lines about either; auth + "this call" = auth lines from this call).
export function matchesAll(tags, selected) {
  const byGroup = new Map();
  for (const id of selected) { const g = id.slice(0, id.indexOf(':')); (byGroup.get(g) || byGroup.set(g, new Set()).get(g)).add(id); }
  const mine = new Set(tags.map(tagId));
  return [...byGroup.values()].every((ids) => [...ids].some((id) => mine.has(id)));
}
