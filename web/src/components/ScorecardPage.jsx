import { useEffect, useRef, useState } from "react";
import { getJson } from "../api";
import { FIELDS, FIELD_LABEL } from "../lib/marks";
import { visible } from "../safeText";
import { Chip, LevelChip } from "./Chips";

export async function copyText(text, area) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try { area.select(); return document.execCommand("copy"); } catch { return false; }
}

export default function ScorecardPage({ info, runsSignal, onOpen }) {
  const [card, setCard] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const area = useRef(null);
  useEffect(() => { setCard(null); getJson("/api/scorecard").then((c) => { setCard(c); setError(""); }, (e) => setError(e.message)); }, [runsSignal, info?.source]);
  if (error) return <p className="field-error" role="alert">Could not load the scorecard ({error}).</p>;
  if (!card) return <p className="muted">Loading...</p>;

  const tally = (f, level) => card.rows.filter((r) => r.score?.[f] === level).length;
  const groups = [...new Set(card.rows.map((r) => r.group))];
  const copy = async () => { const ok = await copyText(card.markdown, area.current); setCopied(ok ? "Copied the Markdown table. Paste it into the customer email." : "Copy was blocked: select the text below and copy it."); };
  return (
    <div data-testid="scorecard-page">
      <p className="lede">{card.source === "mock" ? `Measured on ${card.capturedOn}: what each use case logged, scored against the four requirement clauses. Cases marked not measured have no recording yet (Real mode only): no result is shown for them.` : "Real: scored from the log lines each run actually returned. Cases not run, or run without log lines, are marked."}</p>
      <div className="card-grid" role="group" aria-label="Totals">
        {FIELDS.map((f) => (
          <article key={f} className="card card--neutral" data-testid={`total-${f}`}>
            <h2 className="card__title">{FIELD_LABEL[f]}</h2>
            <p className="row">{["met", "partial", "missing", "na"].map((l) => <span key={l} className="ltag"><LevelChip level={l} /> <b>{tally(f, l)}</b></span>)}</p>
          </article>
        ))}
      </div>
      <div className="scroll">
        <table className="tbl" data-testid="scorecard-table">
          <caption>Use case by requirement clause</caption>
          <thead><tr><th scope="col">Use case</th>{FIELDS.map((f) => <th key={f} scope="col">{FIELD_LABEL[f]}</th>)}<th scope="col">Notes</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <GroupRows key={g} group={g} rows={card.rows.filter((r) => r.group === g)} onOpen={onOpen} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">met = a log line names it. partial = implied or incomplete. missing = not in the log. n/a = does not apply to the use case. not measured = no recorded measurement yet. inferred = matched by time window, not by the run marker.</p>
      <div className="row">
        <button type="button" className="primary" onClick={copy} data-testid="copy-md">Copy as Markdown table</button>
        <span role="status" aria-live="polite" data-testid="copy-status" className="muted">{copied}</span>
      </div>
      <label htmlFor="md-preview" className="sr-only">Markdown table</label>
      <textarea id="md-preview" ref={area} readOnly rows={8} value={card.markdown} data-testid="md-preview" />
    </div>
  );
}

function GroupRows({ group, rows, onOpen }) {
  return (
    <>
      <tr className="tbl__group"><th scope="rowgroup" colSpan={FIELDS.length + 2}>{group}</th></tr>
      {rows.map((r) => (
        <tr key={r.id} data-testid={`row-${r.id}`}>
          <th scope="row"><button type="button" className="linkish" onClick={() => onOpen(r.id)}>{r.title}</button></th>
          {FIELDS.map((f) => <td key={f}>{r.score ? <><LevelChip level={r.score[f]} />{r.inferred?.[f] && <> <Chip kind="warn">inferred</Chip></>}</> : <Chip kind="neutral">{r.notMeasured ? "not measured" : r.needsPaste ? "paste needed" : "not run"}</Chip>}</td>)}
          <td className="notes">{r.notMeasured && <span className="muted">Needs: {(r.needs || []).join("; ")}. </span>}{Object.entries(r.notes || {}).map(([f, n]) => <span key={f}><b>{f}:</b> {visible(n)} </span>)}</td>
        </tr>
      ))}
    </>
  );
}
