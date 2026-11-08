// Requirement 9 (the customer's audit-trail clause) mapped onto Privilege's own records: which part of a-d each policy decision record
// carries, one selected record with its linked records, and a ledger of examples chosen to show each pattern. Pure: entries in (already
// parsed and redacted by privilegeExplorer.entryOf), plain data out. Nothing here reads a log source or keeps a value.
export const REQ9_INDICES = ['policy-decision-log', 'proxy-audit-log'];
export const RID = /^[A-Za-z0-9_-]{1,64}$/;
export const LINK_MS = 10 * 60_000;
export const PICKER_MAX = 500;
export const WINDOW_DAYS = 90;
export const PARTS = {
  a: { label: 'user', question: 'User on whose behalf the MCP tool call was made', fields: 'Data.User, Data.PrincipalKind' },
  b: { label: 'agent', question: 'Agent identity acting on behalf of the user', fields: 'Data.AgentKey' },
  c: { label: 'tool', question: 'Which tool was called', fields: 'Data.Target, Data.Method, Data.App' },
  d: { label: 'decision', question: 'What was the authorization policy decision', fields: 'Data.Decision, Data.Reason, Data.PolicyIDs' },
};
const REQUIRED = 'policy_approval_required';
const RELEASED = 'policy_approval_released';
const DECISION = 'policy_decision';

const t = (e) => (e.at ? Date.parse(e.at) : NaN);
const newestFirst = (a, b) => (b.at || '').localeCompare(a.at || '');

// One decision record as the tab shows it. The agent is the agent access key only (Data.AgentKey), the field requirement b names.
export function recordOf(e) {
  const f = e.fields;
  return {
    at: e.at, index: e.index, event: f.event, requestId: f.requestId, user: f.user, principalKind: f.principalKind,
    agent: f.agentFrom === 'agent key' ? f.agent : null, tool: f.tool, app: f.app, method: f.method, decision: f.decision, reason: f.reason, policyIds: f.policyIds,
  };
}
const httpOf = (e) => ({ at: e.at, index: e.index, user: e.fields.user, method: e.fields.method, path: e.fields.path, requestId: e.fields.requestId });

const status = (n, total) => (total === 0 || n === 0 ? 'missing' : n === total ? 'met' : 'partial');

export function coverageOf(decisions, http) {
  const n = (p) => decisions.filter(p).length;
  const total = decisions.length;
  const counts = { a: n((r) => r.user), b: n((r) => r.agent), c: n((r) => r.tool), d: n((r) => r.decision) };
  const byDecision = { deny: n((r) => r.decision === 'deny'), hitl: n((r) => r.decision === 'hitl'), allow: n((r) => r.decision === 'allow') };
  const byEvent = { [DECISION]: n((r) => r.event === DECISION), [REQUIRED]: n((r) => r.event === REQUIRED), [RELEASED]: n((r) => r.event === RELEASED) };
  const out = {};
  for (const k of Object.keys(PARTS)) out[k] = { ...PARTS[k], count: counts[k], total, status: status(counts[k], total) };
  // d: every decision record names its decision, but a plain allowed call writes no decision record at all (no allow record outside
  // an approval release while HTTP records exist), so the part is only partly met.
  const plainAllow = decisions.filter((r) => r.decision === 'allow' && r.event !== RELEASED).length;
  if (out.d.status === 'met' && http.length > 0 && plainAllow === 0) out.d.status = 'partial';
  return { total, parts: out, byDecision, byEvent, noAgent: total - counts.b, nonHuman: n((r) => r.principalKind === 'NonHumanIdentity'), http: { records: http.length, withTool: http.filter((h) => h.tool).length }, plainAllow };
}

// The records a reader picks from: every decision record, except an approval_required record whose RequestID also has its
// policy_decision (that one is shown as linked to the decision instead). Newest first, at most PICKER_MAX.
export function pickerOf(decisions) {
  const decided = new Set(decisions.filter((r) => r.event === DECISION && r.requestId).map((r) => r.requestId));
  return decisions.filter((r) => !(r.event === REQUIRED && decided.has(r.requestId))).sort(newestFirst).slice(0, PICKER_MAX);
}

// Records linked to one decision record: the same RequestID within +/-10 minutes (any of the two indices), then the approval release
// for a hold (or the hold for a release) by the same user and tool within 10 minutes, which Privilege logs under a NEW RequestID.
export function linkedOf(sel, decisions, http) {
  if (!sel) return [];
  const at = t(sel); const out = [];
  const near = (r) => Math.abs(t(r) - at) <= LINK_MS;
  for (const r of decisions) if (r !== sel && sel.requestId && r.requestId === sel.requestId && near(r)) out.push({ ...r, via: 'same RequestID' });
  for (const h of http) if (sel.requestId && h.requestId === sel.requestId && near(h)) out.push({ ...h, via: 'same RequestID' });
  const same = (r) => r !== sel && r.user && r.user === sel.user && r.tool && r.tool === sel.tool && r.requestId !== sel.requestId;
  if (sel.decision === 'hitl' && sel.event !== RELEASED) {
    const rel = decisions.filter((r) => same(r) && r.event === RELEASED && t(r) > at && t(r) - at <= LINK_MS).sort((a, b) => t(a) - t(b))[0];
    if (rel) out.push({ ...rel, via: 'matched by user, tool and time' });
  }
  if (sel.event === RELEASED) {
    const hold = decisions.filter((r) => same(r) && r.event === DECISION && r.decision === 'hitl' && t(r) < at && at - t(r) <= LINK_MS).sort((a, b) => t(b) - t(a))[0];
    if (hold) out.push({ ...hold, via: 'matched by user, tool and time' });
  }
  return out.sort((a, b) => (a.at || '').localeCompare(b.at || ''));
}

// One example per pattern, newest first; a pattern not seen in the window says so instead of inventing a row.
export function ledgerOf(picker, decisions, http, cov) {
  const find = (p) => picker.find(p) || null;
  const releasedNew = find((r) => r.event === RELEASED && linkedOf(r, decisions, http).some((l) => l.via === 'matched by user, tool and time'));
  const rows = [
    { id: 'full-held', title: 'All four, held for approval', record: find((r) => r.event === DECISION && r.decision === 'hitl' && r.user && r.agent && r.tool), count: cov.byDecision.hitl },
    { id: 'full-denied', title: 'All four, denied', record: find((r) => r.decision === 'deny' && r.user && r.agent && r.tool && r.principalKind !== 'NonHumanIdentity'), count: cov.byDecision.deny },
    { id: 'non-human', title: 'Non-human caller', record: find((r) => r.principalKind === 'NonHumanIdentity'), count: cov.nonHuman },
    { id: 'no-agent', title: 'No agent named', record: find((r) => !r.agent && r.event !== RELEASED), count: cov.noAgent },
    { id: 'released-new-rid', title: 'Approval released under a new RequestID', record: releasedNew || find((r) => r.event === RELEASED), count: cov.byEvent[RELEASED] },
  ].map((row) => ({ ...row, kind: 'decision', found: !!row.record, missing: row.record ? missingOf(row.record) : [], linked: row.record ? linkedOf(row.record, decisions, http) : [] }));
  const plain = http.find((h) => /\/mcp$/.test(h.path || '')) || http[0] || null;
  rows.push({ id: 'plain-allowed', title: 'Plain allowed call', kind: 'http', record: plain, found: !!plain, count: cov.http.records, missing: plain ? ['b', 'c', 'd'] : [], linked: [] });
  return rows;
}
export const missingOf = (r) => [['a', r.user], ['b', r.agent], ['c', r.tool], ['d', r.decision]].filter(([, v]) => !v).map(([k]) => k);

export function gapsOf(cov) {
  return [
    { id: 'agent', title: 'The agent', text: `When the agent calls with the user's own token instead of an agent key, the record has no agent identity. ${cov.noAgent} of ${cov.total} decision records look like this.` },
    { id: 'allowed', title: 'Allowed calls', text: `A call that no policy denies or holds writes no decision record. The gateway's HTTP log (${cov.http.records} records here) shows the user and the MCP endpoint, but not the tool or a decision. Closing this needs Privilege to log allow decisions, which is a question for Ping.` },
    { id: 'release', title: 'The release', text: `An approval release is logged under a new RequestID (${cov.byEvent[RELEASED]} releases here), so tying it to the original hold needs the user, the tool and the time.` },
  ];
}

// entries (privilegeExplorer.entryOf, newest first or not) + an optional requested RequestID -> the whole tab.
export function buildReq9(entries, { rid = null } = {}) {
  const decisions = entries.filter((e) => e.index === 'policy-decision-log').map(recordOf);
  const http = entries.filter((e) => e.index === 'proxy-audit-log').map((e) => ({ ...httpOf(e), tool: e.fields.tool })).sort(newestFirst);
  const cov = coverageOf(decisions, http);
  const picker = pickerOf(decisions);
  let sel = null; let note = null;
  if (rid) {
    sel = picker.find((r) => r.requestId === rid) || decisions.find((r) => r.requestId === rid) || null;
    if (!sel) note = `RequestID ${rid} is not among the decision records read; showing the newest record instead.`;
  }
  if (!sel) sel = picker[0] || null;
  if (!sel && !note) note = 'No policy decision record in this window.';
  return {
    parts: PARTS, coverage: cov, records: picker, recordsTotal: decisions.length,
    selected: { record: sel, requested: rid, found: !!rid && !!sel && sel.requestId === rid, note, linked: linkedOf(sel, decisions, http), missing: sel ? missingOf(sel) : [] },
    ledger: ledgerOf(picker, decisions, http, cov), gaps: gapsOf(cov),
  };
}
