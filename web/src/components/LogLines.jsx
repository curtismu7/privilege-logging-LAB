import { FIELD_LABEL, fieldsOf, segments } from "../lib/marks";
import { visible } from "../safeText";
import { LevelChip } from "./Chips";

// One sink's lines. Every line is React text (control and bidirectional characters shown as escapes), never markup. The scorer's marks
// underline the value that satisfies each requirement clause inline, and a chip after the line names the clause and its level.
export default function LogLines({ lines, marks = {}, testId = "lines" }) {
  if (!lines.length) return null;
  return (
    <ol className="loglines" data-testid={testId}>
      {lines.map((line, i) => {
        const m = marks[i] || [];
        return (
          <li key={i} className="logline">
            <code>
              {segments(line, m).map((s, j) => s.mark
                ? <mark key={j} data-field={s.mark.field} data-level={s.mark.level} title={`${FIELD_LABEL[s.mark.field]}: ${s.mark.why}`}>{visible(s.text)}</mark>
                : <span key={j}>{visible(s.text)}</span>)}
            </code>
            {fieldsOf(m).length > 0 && (
              <span className="logline__tags">
                {fieldsOf(m).map((f) => <span key={f.field} className="ltag"><span className="ltag__name">{FIELD_LABEL[f.field]}</span> <LevelChip level={f.level} /></span>)}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
