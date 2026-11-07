import { useMemo, useState } from "react";
import { parseLogLine } from "../lib/logEntry";
import { FIELDS, FIELD_LABEL, fieldsOf } from "../lib/marks";
import { Chip, LevelChip } from "./Chips";
import JsonTree, { FieldLegend } from "./JsonTree";

const METHOD = {
  marker: ["ok", "matched by marker"], window: ["warn", "time window: inferred"], recorded: ["info", "recorded sample"],
  response: ["info", "response header"], pasted: ["neutral", "pasted"],
};
const SHOW = 50;

// The lines one sink returned, each as a coloured JSON tree (logrus text and JSON records parsed; anything else one string node),
// tagged with HOW it was matched to the call, and a list of the requirement fields this entry does not contain.
export default function LogEntries({ lines, methods = [], marks = {}, testId = "lines", scored = true }) {
  const [all, setAll] = useState(false);
  const parsed = useMemo(() => lines.map((l) => parseLogLine(l)), [lines]);
  if (!lines.length) return null;
  const textMarks = (i) => (marks[i] || []).map((m) => ({ ...m, text: Number.isInteger(m.start) && m.start >= 0 && m.end > m.start ? String(lines[i]).slice(m.start, m.end) : null }));
  const present = new Set(Object.values(marks).flat().map((m) => m.field));
  const missing = FIELDS.filter((f) => !present.has(f));
  const shown = all ? lines.length : Math.min(lines.length, SHOW);
  return (
    <div data-testid={testId}>
      <FieldLegend />
      <ol className="entries">
        {lines.slice(0, shown).map((line, i) => {
          const [kind, word] = METHOD[methods[i]] || [];
          const fs = fieldsOf(marks[i] || []);
          return (
            <li key={i} className="entry" data-testid="entry-item" data-method={methods[i] || undefined}>
              <div className="entry__head">
                <span className="muted">#{i + 1} · {parsed[i].kind === "text" ? "text" : parsed[i].kind}</span>
                {word && <Chip kind={kind} testId="entry-method">{word}</Chip>}
                {fs.map((f) => <span key={f.field} className="ltag"><span className="ltag__name">{FIELD_LABEL[f.field]}</span> <LevelChip level={f.level} /></span>)}
              </div>
              <JsonTree value={parsed[i].value} raw={line} marks={textMarks(i)} label={`Log entry ${i + 1}`} testId={`entry-${i}`} />
            </li>
          );
        })}
      </ol>
      {lines.length > shown && <button type="button" onClick={() => setAll(true)} data-testid="entries-all">Show all {lines.length} entries</button>}
      {scored && <p className="muted" data-testid="not-present">{missing.length ? <>Not present in this entry: <b>{missing.map((f) => FIELD_LABEL[f]).join(", ")}</b>.</> : "All four requirement fields appear in this entry."}</p>}
    </div>
  );
}
