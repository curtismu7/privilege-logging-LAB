import { LevelChip, Chip } from "./Chips";

const summary = (r) => [r.method, r.tool, r.app && `app ${r.app}`, r.model && `model ${r.model}`].filter(Boolean).join(" · ");

export default function RunPage({ cases, runs, info, running, onRun, onRunAll, onOpen }) {
  const real = info?.source === "real";
  const runnable = (c) => !real || c.realRunnable;
  return (
    <div data-testid="run-page">
      <div className="row row--between">
        <p className="lede">{real ? "Real: each Run sends the case to your gateway, then reads the log back." : "Mock: each Run replays a transaction measured on the capture date. Nothing is sent."}</p>
        <button type="button" className="primary" onClick={onRunAll} disabled={!!running} data-testid="run-all">Run all{real ? " runnable" : ""} ({cases.cases.filter(runnable).length})</button>
      </div>
      {cases.groups.map((g) => (
        <section key={g} aria-labelledby={`grp-${g}`}>
          <h2 id={`grp-${g}`} className="section-label">{g}</h2>
          <div className="card-grid">
            {cases.cases.filter((c) => c.group === g).map((c) => {
              const r = runs[c.id];
              return (
                <article key={c.id} className="card" data-testid={`case-${c.id}`}>
                  <h3 className="card__title">{c.title}</h3>
                  <p className="muted">{c.identity}</p>
                  <p><code>{summary(c.request)}</code></p>
                  {real && !c.realRunnable && <p className="muted" data-testid={`note-${c.id}`}>Not runnable in Real: {c.realNote}</p>}
                  <div className="row">
                    <button type="button" className="primary" onClick={() => onRun(c.id)} disabled={!!running || !runnable(c)} data-testid={`run-${c.id}`} title={runnable(c) ? "" : c.realNote}>
                      {running === c.id ? "Running..." : r ? "Run again" : "Run"}
                    </button>
                    {r && <button type="button" onClick={() => onOpen(c.id)} data-testid={`open-${c.id}`}>Open trace</button>}
                    {r && <Chip kind={r.outcome.http >= 400 || r.outcome.isError ? "warn" : "ok"}>HTTP {r.outcome.http}</Chip>}
                    {r && (r.scored ? null : <Chip kind="warn">paste log lines to score</Chip>)}
                  </div>
                  {r && r.scored && (
                    <p className="row" aria-label="score">
                      {["user", "agent", "tool", "decision"].map((f) => <span key={f} className="ltag"><span className="ltag__name">{f}</span> <LevelChip level={r.score[f]} /></span>)}
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
