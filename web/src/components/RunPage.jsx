import { useState } from "react";
import { TagFilter, TagPills } from "./TagFilter";
import { CASE_GROUPS, caseTags } from "../lib/caseTags";
import { matchesAll } from "../lib/entryTags";
import Busy from "./Busy";
import FedSetup from "./FedSetup";
import ConfirmGate from "./ConfirmGate";
import { Chip, LevelChip } from "./Chips";

const summary = (r) => [r.method, r.tool, r.app && `app ${r.app}`, r.model && `model ${r.model}`].filter(Boolean).join(" · ");
const MOCK_ONLY_NOTE = "No recorded measurement yet. Real mode only.";
// A local datetime-local value for "15 minutes ago"
const ago = (min) => { const d = new Date(Date.now() - min * 60_000); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

function BearerField({ c, onBearer }) {
  const [v, setV] = useState("");
  return (
    <div className="bearer" data-testid={`bearer-${c.id}`}>
      <label htmlFor={`bearer-in-${c.id}`} className="muted">Credential for this case (write-only: never shown, never logged)</label>
      <div className="row">
        <input id={`bearer-in-${c.id}`} type="password" autoComplete="off" spellCheck="false" value={v} onChange={(e) => setV(e.target.value)} placeholder={c.bearerConfigured ? "set; paste a new one to replace" : "paste a bearer token"} data-testid={`bearer-input-${c.id}`} />
        <button type="button" onClick={async () => { if (await onBearer(c.id, v.trim())) setV(""); }} disabled={!v.trim()} data-testid={`bearer-set-${c.id}`}>Set</button>
        {c.bearerConfigured && <><Chip kind="ok" testId={`bearer-on-${c.id}`}>credential set</Chip><button type="button" onClick={() => onBearer(c.id, "")} data-testid={`bearer-clear-${c.id}`}>Clear</button></>}
      </div>
    </div>
  );
}

export default function RunPage({ cases, runs, info, running, busy = {}, gate = null, onConfirm, onCancelGate, onRun, onLook, onRetry, onBearer, onRunAll, onOpen }) {
  const real = info?.source === "real";
  const [since, setSince] = useState(ago(15));
  const mode = real ? "real" : "mock";
  const runnable = (c) => (real ? c.realRunnable : !c.realOnly);
  const sources = info?.retrieval?.sources || [];
  // info === null: /api/info failed, so the page cannot say whether a Run would send. Nothing runs until it loads.
  const unknown = info === null;
  const [picked, setPicked] = useState(() => new Set());
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const tagsOf = new Map(cases.cases.map((c) => [c.id, caseTags(c)]));
  const visible = cases.cases.filter((c) => matchesAll(tagsOf.get(c.id), picked));
  return (
    <div data-testid="run-page">
      <div className="row row--between">
        <p className="lede">{real ? `Real: each Run sends the case to your gateway, then fetches the log entry${sources.length ? ` from ${sources.map((s) => s.label).join(" and ")}` : ""}. ${sources.length ? "" : "No log source is configured: you will paste the lines."}` : "Mock: each Run replays a transaction measured on the capture date, then shows its recorded log entry. Nothing is sent."}</p>
        <button type="button" className="primary" onClick={onRunAll} disabled={!!running || unknown} data-testid="run-all">Run all{real ? " runnable" : ""} ({cases.cases.filter((c) => (real ? c.realRunnable && !c.consoleAction && (!c.needsBearer || c.bearerConfigured) : !c.realOnly)).length})</button>
      </div>
      <div data-testid="case-tag-filter">
        <TagFilter groups={CASE_GROUPS} label="Filter cases by tag" startOpen tagsByEntry={[...tagsOf.values()]} selected={picked} onToggle={toggle} onClear={() => setPicked(new Set())} shown={visible.length} total={cases.cases.length} />
      </div>
      {visible.length === 0 && <p className="muted" data-testid="no-cases">No case has all the tags you picked. <button type="button" onClick={() => setPicked(new Set())}>Clear tags</button></p>}
      {cases.groups.filter((g) => visible.some((c) => c.group === g)).map((g) => (
        <section key={g} aria-labelledby={`grp-${g}`}>
          <h2 id={`grp-${g}`} className="section-label">{g}{cases.cases.find((c) => c.group === g)?.realOnly ? " · not measured yet" : ""}</h2>
          <div className="card-grid">
            {visible.filter((c) => c.group === g).map((c) => {
              const r = runs[c.id]; const b = busy[c.id];
              const active = b && (b.phase === "sending" || b.phase === "fetching");
              const mockOnlyBlock = !real && c.realOnly;
              const tid = `ct-${c.id}`;
              const runText = active ? "Running..." : r ? "Run again" : "Run";
              const lookText = active ? "Looking..." : "Look for entries";
              return (
                <article key={c.id} className="card" data-testid={`case-${c.id}`} aria-busy={active ? "true" : "false"} aria-labelledby={tid}>
                  <h3 className="card__title" id={tid}>{c.title}</h3>
                  <p className="muted">{c.identity}</p>
                  <TagPills tags={tagsOf.get(c.id)} selected={picked} onToggle={toggle} />
                  <p><code>{summary(c.request)}</code></p>
                  {c.realOnly && <p className="muted" data-testid={`needs-${c.id}`}><Chip kind="warn">not measured</Chip> {c.generatedCredential ? "Nothing to supply: the lab generates the credential." : `Needs: ${c.needs.join("; ")}`}</p>}
                  {real && c.generatedCredential && <p className="muted" data-testid={`generated-${c.id}`}><Chip kind="info">credential generated</Chip> The lab sends {c.generatedCredential}; you do not supply one.</p>}
                  {mockOnlyBlock && <p className="muted" data-testid={`mockonly-${c.id}`}>{MOCK_ONLY_NOTE}</p>}
                  {real && c.realRunnable && /signed-in/i.test(c.identity) && <p className="muted" data-testid={`ident-${c.id}`}>Real sends this with the agent key (this tool has no user sign-in), so the identity differs from the measured case.</p>}
                  {real && !c.realRunnable && <p className="muted" data-testid={`note-${c.id}`}>Not runnable in Real: {c.realNote}</p>}
                  {real && c.mintsToken && <FedSetup bearerConfigured={c.bearerConfigured} />}
                  {real && c.needsBearer && <BearerField c={c} onBearer={onBearer} />}
                  {real && c.consoleAction && (
                    <div className="row">
                      <label htmlFor={`since-${c.id}`} className="muted">Look for entries since</label>
                      <input id={`since-${c.id}`} type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} data-testid={`since-${c.id}`} />
                    </div>
                  )}
                  <div className="row">
                    {real && c.consoleAction ? (
                      <button type="button" className="primary" onClick={() => onLook(c.id, new Date(since).toISOString())} disabled={!!running || !since || unknown} data-testid={`run-${c.id}`} aria-label={`${lookText}: ${c.title}`}>{lookText}</button>
                    ) : (
                      <button type="button" className="primary" onClick={() => onRun(c.id)} disabled={!!running || unknown || !runnable(c) || (real && c.needsBearer && !c.bearerConfigured)} data-testid={`run-${c.id}`} aria-label={`${runText}: ${c.title}`}
                        title={mockOnlyBlock ? MOCK_ONLY_NOTE : !runnable(c) ? c.realNote || "" : real && c.needsBearer && !c.bearerConfigured ? "Set the credential for this case first." : ""}>
                        {runText}
                      </button>
                    )}
                    {r && <button type="button" onClick={() => onOpen(c.id)} data-testid={`open-${c.id}`} aria-label={`Open trace: ${c.title}`}>Open trace</button>}
                    {r && r.outcome.http !== null && <Chip kind={r.outcome.http >= 400 || r.outcome.isError ? "warn" : "ok"}>HTTP {r.outcome.http}</Chip>}
                    {r && !r.scored && !b && r.retrieval?.state === "not_configured" && <Chip kind="warn">paste log lines to score</Chip>}
                  </div>
                  {gate?.queue?.[0] === c.id && <ConfirmGate gate={gate} onConfirm={onConfirm} onCancel={onCancelGate} busy={!!running} inline />}
                  <Busy id={c.id} b={b} mode={mode} onRetry={onRetry} />
                  {r && r.scored && !active && (
                    <p className="row" role="group" aria-label="score">
                      {["user", "agent", "tool", "decision"].map((f) => <span key={f} className="ltag"><span className="ltag__name">{f}</span> <LevelChip level={r.score[f]} />{r.scoreInferred?.[f] && <Chip kind="warn">inferred</Chip>}</span>)}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
