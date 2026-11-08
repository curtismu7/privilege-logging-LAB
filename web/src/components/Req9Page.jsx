import { useEffect, useMemo, useRef, useState } from "react";
import { getJson } from "../api";
import { Chip } from "./Chips";
import PatternDiagram from "./PatternDiagram";

// Requirement 9, the audit map: which part of the customer's clause (a user, b agent, c tool, d decision) Privilege's own records carry.
// One selected decision record fills the relationship diagram (pick another from the list, or open #req9/<RequestID>); coverage tiles
// count the parts over every decision record read; a ledger shows one example per pattern with a dashed box where a part is absent.
// The server reads, redacts and computes everything (GET /api/req9); this page only shows it, as React text.
export const RID = /^[A-Za-z0-9_-]{1,64}$/;
const PART_KEYS = ["a", "b", "c", "d"];
// The requirement's own wording, so the list reads the same before the logs load or when a read fails.
const QUESTIONS = {
  a: "User on whose behalf the MCP tool call was made",
  b: "Agent identity acting on behalf of the user",
  c: "Which tool was called",
  d: "What was the authorization policy decision",
};
const DECISION = { allow: "ok", deny: "danger", hitl: "warn" };
const STATUS = { met: ["ok", "MET ON DECISIONS"], partial: ["warn", "PARTIAL"], missing: ["danger", "MISSING"] };
const shortTime = (iso) => (iso ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z") : "no time");
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || "");
export const shortUser = (u) => (!u ? "no user" : /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(u) ? `${u.slice(0, 8)}…` : clip(u, 18));
export function matches(r, q) {
  const s = q.trim().toLowerCase();
  return !s || [r.requestId, r.user, r.agent, r.tool, r.app].some((v) => v && v.toLowerCase().includes(s));
}

function DecisionChip({ value }) {
  return <Chip kind={DECISION[value] || "neutral"}>{value || "none"}</Chip>;
}

// The diagram-studio data (field names) with the selected record's values put into each box. A part the record lacks turns dashed red.
function fill(diagram, sel, linked) {
  if (!diagram) return null;
  const approval = linked.find((l) => l.via === "same RequestID" && l.event === "policy_approval_required");
  const value = {
    user: sel ? [sel.user || "no user", `PrincipalKind ${sel.principalKind || "not given"}`] : null,
    agent: sel ? [sel.agent || "no agent key", sel.agent ? "Data.AgentKey" : "called with the user's own token"] : null,
    tool: sel ? [sel.tool || "no tool", `${sel.method || "?"} on ${sel.app || "?"}`] : null,
    decision: sel ? [sel.decision || "no decision", clip(`${sel.policyIds || "no policy id"} · ${sel.reason || ""}`, 110)] : null,
    approval: sel ? (approval ? [shortTime(approval.at), "same Data.RequestID"] : ["none linked", "no hold with this RequestID"]) : null,
  };
  const lacks = { user: !sel?.user, agent: !sel?.agent, tool: !sel?.tool, decision: !sel?.decision, approval: !approval };
  return {
    ...diagram,
    nodes: diagram.nodes.map((n) => ({ ...n, sub: value[n.id] ? value[n.id].map((s) => clip(s, 120)) : n.sub, kind: sel && lacks[n.id] ? (n.id === "approval" ? "unverified" : "missing") : n.kind })),
  };
}

function Lane({ part, row }) {
  const r = row.record;
  const http = row.kind === "http";
  const missing = row.missing.includes(part);
  let v; let s;
  if (part === "a") { v = r.user || "no user"; s = http ? "Data.User" : `PrincipalKind ${r.principalKind || "not given"}`; }
  if (part === "b") { v = missing ? (http ? "not in this record" : "no agent key") : r.agent; s = missing ? (http ? "no agent field" : "called with the user's own token") : "agent access key"; }
  if (part === "c") { v = missing ? "not in this record" : r.tool; s = missing ? `only ${r.method || "?"} ${clip(r.path || "", 60)}` : `${r.method || "?"} on ${r.app || "?"}`; }
  if (part === "d") { v = missing ? "no decision written" : r.decision; s = missing ? "allowed calls are not logged as decisions" : clip(`${r.policyIds || "no policy id"} · "${r.reason || ""}"`, 140); }
  const tone = missing ? " req9-node--missing" : part === "d" ? ` req9-node--${DECISION[r.decision] || "neutral"}` : "";
  return (
    <div className={`req9-node${tone}`} data-testid={`req9-lane-${row.id}-${part}`} data-missing={missing ? "true" : undefined}>
      <span className="req9-node__k">{part}</span>
      <span className="req9-node__v">{v}</span>
      <span className="req9-node__s">{s}</span>
    </div>
  );
}

export default function Req9Page({ info, signal, rid, onSelect, onConfirmNeeded }) {
  const confirmNeeded = useRef(onConfirmNeeded);
  confirmNeeded.current = onConfirmNeeded;
  const valid = !!rid && RID.test(rid);
  const [data, setData] = useState(null);
  const [diagram, setDiagram] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => { getJson("/api/diagram?name=req9").then(setDiagram, () => setDiagram(null)); }, []);
  useEffect(() => {
    let live = true;
    setLoading(true); setError("");
    getJson(`/api/req9${valid ? `?rid=${encodeURIComponent(rid)}` : ""}`)
      .then((d) => { if (live) setData(d); }, (e) => { if (!live) return; setData(null); if (e.status === 412) confirmNeeded.current?.(); setError(e.message || "Could not read Privilege's logs."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [rid, valid, signal, info?.source]);

  const sel = data?.selected?.record || null;
  const linked = data?.selected?.linked || [];
  const pattern = useMemo(() => fill(diagram, sel, linked), [diagram, sel, linked]);
  const list = useMemo(() => (data?.records || []).filter((r) => matches(r, q)), [data, q]);
  const at = sel ? list.findIndex((r) => r === sel || (r.requestId === sel.requestId && r.at === sel.at)) : -1;
  const pick = (r) => { if (r?.requestId && RID.test(r.requestId)) onSelect?.(r.requestId); };
  const note = rid && !valid ? "That link's RequestID is not a valid one (letters, digits, _ or -, up to 64); showing the newest record instead." : data?.selected?.note;
  const cov = data?.coverage;

  return (
    <div data-testid="req9-page">
      <p className="channel channel--privilege-es" data-testid="req9-channel">PRIVILEGE -&gt; ELASTICSEARCH ONLY: {data?.channel || "Privilege -> Elasticsearch (Privilege hosted), read through the console"}. Indices policy-decision-log and proxy-audit-log{data ? `, ${shortTime(data.from)} to ${shortTime(data.to)}` : ", the last 90 days"}.</p>
      <blockquote className="req9-quote" data-testid="req9-requirement">
        Gateway is able to provide an end to end audit trail for all the MCP interactions. The audit trail should clearly emit:
        <ol type="a">{PART_KEYS.map((k) => <li key={k}>{data?.parts?.[k]?.question || QUESTIONS[k]}</li>)}</ol>
      </blockquote>
      {data?.note && <p className="muted" data-testid="req9-mock-note">Mock: {data.note}</p>}
      {data?.limit && <p className="notice" data-testid="req9-limit">{data.limit}</p>}
      {error && <p className="field-error" role="alert" data-testid="req9-error">Could not read Privilege&apos;s logs ({error}).</p>}
      {note && <p className="notice" role="status" data-testid="req9-note">{note}</p>}
      {loading && <p className="muted" data-testid="req9-busy">Reading...</p>}

      {data && (
        <>
          <section className="req9-pick" aria-label="Pick a decision record" data-testid="req9-picker">
            <h2>Pick a decision record</h2>
            <div className="priv-filters">
              <label className="inline">Search <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="RequestID, user, agent key, tool or app" data-testid="req9-search" /></label>
              <button type="button" onClick={() => pick(list[at - 1])} disabled={at <= 0} data-testid="req9-prev">Previous</button>
              <button type="button" onClick={() => pick(list[at < 0 ? 0 : at + 1])} disabled={!list.length || at >= list.length - 1} data-testid="req9-next">Next</button>
              <span className="muted" data-testid="req9-pick-count">{list.length} of {data.records.length} records{data.recordsTotal > data.records.length ? ` (${data.recordsTotal} read; holds that have their decision are shown with it)` : ""}</span>
            </div>
            <ul className="req9-list" data-testid="req9-list">
              {list.map((r, i) => (
                <li key={`${r.requestId}-${r.at}-${i}`}>
                  <button type="button" aria-pressed={i === at} onClick={() => pick(r)} disabled={!r.requestId || !RID.test(r.requestId)} data-testid="req9-pick-row">
                    <span className="mono">{shortTime(r.at)}</span>
                    <span>{shortUser(r.user)}</span>
                    <span className={r.agent ? undefined : "muted"}>{r.agent || "no agent"}</span>
                    <span>{r.tool || "no tool"}</span>
                    <DecisionChip value={r.event === "policy_approval_released" ? "allow" : r.decision} />
                    {r.event !== "policy_decision" && <span className="muted">{r.event}</span>}
                  </button>
                </li>
              ))}
              {!list.length && <li className="muted">No record matches.</li>}
            </ul>
          </section>

          {sel && (
            <section aria-label="The selected record" data-testid="req9-selected">
              <p className="muted">Selected: <span className="mono" data-testid="req9-selected-rid">{sel.requestId || "no RequestID"}</span> · {shortTime(sel.at)} · {sel.event} · {sel.index}. Link to it: <span className="mono">#req9/{sel.requestId}</span></p>
              {pattern && <PatternDiagram key="req9" pattern={pattern} resetSignal={signal} dashedNote="Dashed arrow: a separate record joined by Data.RequestID. A dashed red box: a part this record does not carry." />}
              <h3>Linked records</h3>
              {linked.length ? (
                <ul className="req9-linked" data-testid="req9-linked">
                  {linked.map((l, i) => <li key={i}><span className="mono">{shortTime(l.at)}</span> {l.event || l.index} {l.decision && <DecisionChip value={l.decision} />} <span className="mono">{l.requestId}</span> <Chip kind={l.via === "same RequestID" ? "info" : "warn"}>{l.via}</Chip></li>)}
                </ul>
              ) : <p className="muted" data-testid="req9-linked">No linked record within 10 minutes.</p>}
            </section>
          )}

          <section aria-label="Coverage" data-testid="req9-coverage">
            <h2>How well each part is met</h2>
            <div className="card-grid">
              {PART_KEYS.map((k) => {
                const p = cov.parts[k]; const [kind, label] = STATUS[p.status];
                const why = {
                  a: `Present on ${p.count} of ${p.total} decision records. A non-human caller shows its identity name with PrincipalKind NonHumanIdentity (${cov.nonHuman} here).`,
                  b: `Only when the call came in with an agent key. ${cov.noAgent} records have no agent: the call carried the user's own token, so nothing names the agent.`,
                  c: `Tool name, its MCP app and the method. The gateway HTTP log for allowed calls (${cov.http.records} records) has only the path, no tool name.`,
                  d: `${cov.byDecision.deny} deny, ${cov.byDecision.hitl} hold (hitl), ${cov.byEvent.policy_approval_released} approval released. Written only when a policy matched: a plain allowed call writes no decision record.`,
                }[k];
                return (
                  <article key={k} className={`card card--${kind === "ok" ? "ok" : "warn"}`} data-testid={`req9-cov-${k}`}>
                    <h3 className="card__title">{k} · {p.label}</h3>
                    <p className="muted">{p.question}</p>
                    <p className="req9-count" data-testid={`req9-cov-${k}-count`}>{k === "d" ? p.count : `${p.count} / ${p.total}`}</p>
                    <p className="mono">{p.fields}</p>
                    <Chip kind={kind} testId={`req9-cov-${k}-status`}>{label}</Chip>
                    <p>{why}</p>
                  </article>
                );
              })}
            </div>
          </section>

          <section aria-label="Records lane by lane" data-testid="req9-ledger">
            <h2>Records, lane by lane</h2>
            <p className="muted">One example per pattern. A dashed red box marks a part of requirement 9 that the record does not carry.</p>
            <div className="req9-ledger">
              <div className="req9-row req9-row--head" aria-hidden="true"><div>Record</div><div>a · user<span>Data.User</span></div><div>b · agent<span>Data.AgentKey</span></div><div>c · tool<span>Data.Target on Data.App</span></div><div>d · decision<span>Data.Decision · policy</span></div></div>
              {data.ledger.map((row) => (
                <div key={row.id} className="req9-row" data-testid={`req9-row-${row.id}`} data-found={row.found ? "true" : "false"}>
                  <div className="req9-meta">
                    <b>{row.title}</b>
                    {row.found ? (
                      <>
                        <span className="mono">{shortTime(row.record.at)}</span>
                        <span>{row.kind === "http" ? `${row.record.index} · ${row.count} records · no decision record exists` : <>RequestID <span className="mono">{row.record.requestId}</span> · {row.record.index} · {row.count} like it</>}</span>
                        {row.kind === "decision" && row.record.requestId && RID.test(row.record.requestId) && <button type="button" onClick={() => pick(row.record)} data-testid={`req9-open-${row.id}`}>Show in the diagram</button>}
                      </>
                    ) : <span className="muted">Not seen in this window.</span>}
                  </div>
                  {row.found && PART_KEYS.map((k) => <Lane key={k} part={k} row={row} />)}
                  {row.found && row.linked.length > 0 && (
                    <div className="req9-follow">then {row.linked.map((l, i) => <span key={i}>{i ? " · " : ""}{shortTime(l.at)} <b>{l.event || l.index}</b>{l.decision ? `, decision ${l.decision}` : ""}, RequestID <span className="mono">{l.requestId}</span> ({l.via})</span>)}</div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section aria-label="What this means" data-testid="req9-gaps">
            <h2>What this means for the customer</h2>
            <p><b>Met when a policy matches.</b> A deny or an approval hold produces one record that names the user, the agent key, the tool on its app and the decision, with the policy id and reason. The RequestID links it to the approval that follows.</p>
            {data.gaps.map((g, i) => <p key={g.id} data-testid={`req9-gap-${g.id}`}><b>Gap {i + 1}, {g.title.toLowerCase()}.</b> {g.text}</p>)}
            <p className="muted">Deep link to one record: <span className="mono">http://127.0.0.1:7801/#req9/&lt;RequestID&gt;</span> (the shape Kibana's field link uses).</p>
          </section>
        </>
      )}
    </div>
  );
}
