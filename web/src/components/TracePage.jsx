import { useState } from "react";
import { scorePaste } from "../api";
import { FIELDS, FIELD_LABEL } from "../lib/marks";
import { visible } from "../safeText";
import { Chip, LevelChip } from "./Chips";
import Busy from "./Busy";
import LogEntries from "./LogEntries";

const pretty = (v) => visible(JSON.stringify(v, null, 2));

function Score({ result }) {
  if (!result.scored) return <p className="muted" data-testid="unscored">{result.realOnly && result.source === "mock" ? "Not measured." : "Not scored: no log entry has been retrieved for this call."} {result.retrieval?.state === "not_configured" ? "No log source is configured. " : ""}Paste the gateway log lines below and they are scored with the same scorer.</p>;
  const diff = result.recomputed?.diff || {};
  return (
    <>
      <dl className="kv" data-testid="score">
        {FIELDS.map((f) => (
          <div key={f} className="kv__row">
            <dt>{FIELD_LABEL[f]}</dt>
            <dd><LevelChip level={result.score[f]} />{result.scoreInferred?.[f] && <> <Chip kind="warn" testId={`inferred-${f}`}>inferred: time window</Chip></>} {result.scoreNotes?.[f] ? <span className="muted">{visible(result.scoreNotes[f])}</span> : null}</dd>
          </div>
        ))}
      </dl>
      {Object.keys(diff).length > 0 && (
        <p className="muted" data-testid="score-diff">The scorer, run on only the sample lines kept here, differs on: {Object.entries(diff).map(([f, [rec, got]]) => `${f} (recorded ${rec}, scorer ${got})`).join("; ")}. The recorded score is the assessment: it saw more of the log than these samples keep.</p>
      )}
    </>
  );
}

function Hop({ h }) {
  return (
    <details className="hop" data-testid={`hop-${h.n}`}>
      <summary>Hop {h.n}: {h.from} to {h.to} · {visible(h.label)}</summary>
      <p className="muted">traceparent <code>{h.traceparent}</code></p>
      <h4>Request</h4><pre className="code">{visible(h.request)}</pre>
      <h4>Response</h4><pre className="code">{visible(h.response)}</pre>
    </details>
  );
}

export default function TracePage({ cases, runs, sinkInfo, info, caseId, busy = {}, onSelect, onRun, onRetry, onChanged, running }) {
  const [paste, setPaste] = useState("");
  const [pasted, setPasted] = useState(null);
  const [problem, setProblem] = useState("");
  const result = runs[caseId];
  const sinkName = (id) => [...(sinkInfo?.sinks || []), ...(sinkInfo?.extraSinks || [])].find((s) => s.id === id);
  const real = info?.source === "real";

  const score = async () => {
    setProblem("");
    const r = await scorePaste(paste, caseId);
    if (!r.ok) { setProblem(r.body.detail || r.body.error || "could not score"); setPasted(null); return; }
    setPasted(r.body);
    if (r.body.attached) onChanged();
  };

  const notRead = result && sinkInfo ? sinkInfo.sinks.filter((s) => !result.logged.some((l) => l.source === s.id)) : [];
  return (
    <div data-testid="trace-page">
      <div className="row">
        <label htmlFor="trace-case" className="inline">Use case{" "}
          <select id="trace-case" value={caseId || ""} onChange={(e) => onSelect(e.target.value)} data-testid="trace-case">
            {cases.cases.map((c) => <option key={c.id} value={c.id}>{c.group}: {c.title}{runs[c.id] ? "" : " (not run)"}</option>)}
          </select>
        </label>
        <button type="button" className="primary" onClick={() => onRun(caseId)} disabled={!!running || !caseId} data-testid="trace-run">{result ? "Run again" : "Run this case"}</button>
      </div>
      <Busy id={caseId} b={busy[caseId]} mode={real ? "real" : "mock"} onRetry={onRetry} />
      {!result && !busy[caseId] && <p className="muted" data-testid="trace-empty">This case has not been run in this tab. Press Run to {real ? "send it to your gateway" : "replay the recorded transaction"}.</p>}
      {result && (
        <>
          <div className="card-grid card-grid--2">
            <section className="card" aria-labelledby="t-req">
              <h2 id="t-req" className="card__title">Request</h2>
              <dl className="kv">
                <div className="kv__row"><dt>Use case</dt><dd>{result.title}</dd></div>
                <div className="kv__row"><dt>Identity</dt><dd>{result.identity}</dd></div>
                <div className="kv__row"><dt>Method</dt><dd><code>{result.request.method}</code></dd></div>
                {result.request.tool !== undefined && <div className="kv__row"><dt>Tool</dt><dd><code>{visible(result.request.tool)}</code></dd></div>}
                {result.request.app && <div className="kv__row"><dt>App</dt><dd><code>{result.request.app}</code></dd></div>}
                {result.marker && <div className="kv__row"><dt>Run marker</dt><dd><code data-testid="trace-marker">{result.marker}</code> <span className="muted">in {result.markerWhere}</span></dd></div>}
                <div className="kv__row"><dt>Source</dt><dd><Chip kind={result.source === "real" ? "info" : "warn"} testId="trace-source">{result.source === "real" ? `REAL, ${result.ranAt}` : `MOCK replay of ${result.recordedOn}`}</Chip></dd></div>
              </dl>
              {result.request.arguments && <pre className="code" data-testid="trace-args">{pretty(result.request.arguments)}</pre>}
              {result.wire && <details><summary>{result.source === "real" ? "Call as sent (JSON-RPC)" : "Call Real would send (JSON-RPC, NOT sent now)"}</summary><pre className="code">{pretty(result.wire)}</pre></details>}
            </section>
            <section className="card" aria-labelledby="t-res">
              <h2 id="t-res" className="card__title">Response</h2>
              <p><Chip kind={result.outcome.http === null || result.outcome.http >= 400 || result.outcome.isError ? "warn" : "ok"} testId="trace-http">{result.outcome.http === null ? "no HTTP answer" : `HTTP ${result.outcome.http}`}</Chip> {result.outcome.isError && <Chip kind="warn">isError</Chip>}</p>
              <p data-testid="trace-note">{visible(result.outcome.note)}</p>
              {result.retrieval && <p data-testid="retrieval" data-state={result.retrieval.state}><Chip kind={result.retrieval.state === "found" ? (result.retrieval.method === "window" ? "warn" : "ok") : result.retrieval.state === "pending" ? "info" : "warn"}>{result.retrieval.state === "found" ? `log entry found by ${result.retrieval.method === "marker" ? "run marker" : result.retrieval.method === "window" ? "time window (inferred)" : "recording"}` : `log entry: ${result.retrieval.state.replace("_", " ")}`}</Chip> <span className="muted">{visible(result.retrieval.detail || "")}</span></p>}
              <h3 className="card__title">Score against the requirement</h3>
              <Score result={result} />
            </section>
          </div>

          <h2 className="section-label">What was logged, per sink</h2>
          {result.logged.map((l) => {
            const s = sinkName(l.source);
            return (
              <section key={l.source} className="card card--sink" data-testid={`sink-${l.source}`} aria-label={s?.name || l.source}>
                <h3 className="card__title">{s?.name || l.source} <Chip kind={l.lines.length ? "ok" : "warn"}>{l.lines.length ? `${l.lines.length} line${l.lines.length === 1 ? "" : "s"}` : "nothing logged"}</Chip>{s?.unverified && <> <Chip kind="warn">UNVERIFIED</Chip></>}</h3>
                {l.lines.length > 0 ? <LogEntries lines={l.lines} methods={l.methods || []} marks={result.marks?.[l.source] || {}} testId={`lines-${l.source}`} scored={result.scored} /> : !l.note && <p className="muted">Nothing was found in this sink for the call.</p>}
                {l.note && <p className="muted">{visible(l.note)}</p>}
              </section>
            );
          })}
          {notRead.length > 0 && <p className="muted" data-testid="not-read">Not read back for this case: {notRead.map((s) => s.name).join("; ")}.</p>}

          <h2 className="section-label">Raw hops (traceparent on every hop)</h2>
          {result.hops.map((h) => <Hop key={h.n} h={h} />)}
        </>
      )}

      <h2 className="section-label">Score log lines you paste</h2>
      <section className={`card${result?.needsPaste ? " card--warn" : " card--neutral"}`} data-testid="paste-card">
        <p className="muted">Paste gateway log lines (logrus text or JSON records) for {result ? "this call" : "any call"}. They are read as text only and scored by the same scorer.{result?.needsPaste ? " This Real run has no search endpoint, so this is where its score comes from." : ""}</p>
        <label htmlFor="paste-box" className="sr-only">Log lines to score</label>
        <textarea id="paste-box" rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste log lines here" data-testid="paste-box" maxLength={200000} />
        <div className="row">
          <button type="button" className="primary" onClick={score} disabled={!paste.trim()} data-testid="paste-score">Score these lines</button>
          {problem && <span className="field-error" role="alert">{problem}</span>}
        </div>
        {pasted && (
          <div data-testid="paste-result">
            <dl className="kv">{FIELDS.map((f) => <div key={f} className="kv__row"><dt>{FIELD_LABEL[f]}</dt><dd><LevelChip level={pasted.score[f]} /> {pasted.scoreNotes[f] ? <span className="muted">{visible(pasted.scoreNotes[f])}</span> : null}</dd></div>)}</dl>
            <LogEntries lines={pasted.logged[0].lines} methods={pasted.logged[0].lines.map(() => "pasted")} marks={pasted.marks.pasted || {}} testId="lines-pasted" />
            {pasted.attached && <p className="muted">Attached to this run: its score now includes these lines.</p>}
            {pasted.truncated && <p className="muted">Only the first 500 lines were read.</p>}
          </div>
        )}
      </section>
    </div>
  );
}
