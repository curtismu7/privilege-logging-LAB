import { useMemo, useState } from "react";
import { parseLogLine } from "../lib/logEntry";
import { FIELDS, FIELD_LABEL, fieldsOf } from "../lib/marks";
import { Chip, LevelChip } from "./Chips";
import JsonTree, { FieldLegend } from "./JsonTree";
import { matchesAll, tagId, tagsFor } from "../lib/entryTags";

const METHOD = {
  marker: ["ok", "matched by marker"], window: ["warn", "time window: inferred"], recorded: ["info", "recorded sample"],
  response: ["info", "response header"], pasted: ["neutral", "pasted"],
};
const SHOW = 50;

// The lines one sink returned, each as a coloured JSON tree (logrus text and JSON records parsed; anything else one string node),
// tagged with HOW it was matched to the call, and a list of the requirement fields this entry does not contain.
const KIND = { runtime: ["ok", "runtime event"], console: ["info", "console event"], unknown: ["neutral", "kind unknown"] };
const GROUPS = [["type", "Event type"], ["match", "This call or nearby"], ["label", "Labels"], ["identity", "Identity"]];

// Every tag on these entries, grouped, with how many entries carry it. Clicking one filters; clicking again clears it.
function TagFilter({ tagsByEntry, selected, onToggle, onClear, shown, total }) {
  const counts = new Map();
  for (const tags of tagsByEntry) for (const t of tags) { const id = tagId(t); const c = counts.get(id) || { t, n: 0 }; c.n += 1; counts.set(id, c); }
  return (
    <div className="tagfilter" data-testid="tag-filter" role="group" aria-label="Filter entries by tag">
      {GROUPS.map(([g, label]) => {
        const items = [...counts.values()].filter((c) => c.t.group === g).sort((a, b) => b.n - a.n || a.t.value.localeCompare(b.t.value));
        if (!items.length) return null;
        return (
          <div key={g} className="tagfilter__group">
            <span className="muted tagfilter__label">{label}</span>
            {items.map(({ t, n }) => <TagButton key={tagId(t)} t={t} on={selected.has(tagId(t))} onToggle={onToggle} count={n} testId="filter-tag" />)}
          </div>
        );
      })}
      <p className="muted" data-testid="tag-filter-count">
        {selected.size ? <>Showing {shown} of {total} entries. <button type="button" onClick={onClear} data-testid="tag-filter-clear">Clear filters</button></> : <>{total} {total === 1 ? "entry" : "entries"}. Click a tag to filter.</>}
      </p>
    </div>
  );
}
const TagButton = ({ t, on, onToggle, count, testId }) => (
  <button type="button" className={`etag etag--${t.group}${on ? " etag--on" : ""}`} aria-pressed={on ? "true" : "false"} onClick={() => onToggle(tagId(t))} data-testid={testId} data-tag={tagId(t)}>
    {t.value}{count !== undefined ? <span className="etag__n"> {count}</span> : null}
  </button>
);

export default function LogEntries({ lines, methods = [], marks = {}, testId = "lines", scored = true, from = "", kinds = [], indices = [] }) {
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const parsed = useMemo(() => lines.map((l) => parseLogLine(l)), [lines]);
  const tagsByEntry = useMemo(() => lines.map((l, i) => tagsFor(l, { method: methods[i], kind: kinds[i], from, fields: fieldsOf(marks[i] || []).map((f) => f.field) })), [lines, methods, kinds, from, marks]);
  if (!lines.length) return null;
  const toggle = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const visibleIdx = lines.map((_, i) => i).filter((i) => matchesAll(tagsByEntry[i], selected));
  const textMarks = (i) => (marks[i] || []).map((m) => ({ ...m, text: Number.isInteger(m.start) && m.start >= 0 && m.end > m.start ? String(lines[i]).slice(m.start, m.end) : null }));
  const present = new Set(Object.values(marks).flat().map((m) => m.field));
  const missing = FIELDS.filter((f) => !present.has(f));
  const shown = all ? visibleIdx.length : Math.min(visibleIdx.length, SHOW);
  return (
    <div data-testid={testId}>
      <FieldLegend />
      <TagFilter tagsByEntry={tagsByEntry} selected={selected} onToggle={toggle} onClear={() => setSelected(new Set())} shown={visibleIdx.length} total={lines.length} />
      <ol className="entries">
        {visibleIdx.slice(0, shown).map((i) => {
          const line = lines[i];
          const [kind, word] = METHOD[methods[i]] || [];
          const fs = fieldsOf(marks[i] || []);
          return (
            <li key={i} className="entry" data-testid="entry-item" data-method={methods[i] || undefined}>
              <div className="entry__head">
                <span className="muted">#{i + 1} · {parsed[i].kind === "text" ? "text" : parsed[i].kind}</span>
                {from && <Chip kind="neutral" testId="entry-from">from: {from}{indices[i] ? ` · ${indices[i]}` : ""}</Chip>}
                {kinds[i] && <Chip kind={(KIND[kinds[i]] || KIND.unknown)[0]} testId="entry-kind">{(KIND[kinds[i]] || KIND.unknown)[1]}</Chip>}
                {word && <Chip kind={kind} testId="entry-method">{word}</Chip>}
                {fs.map((f) => <span key={f.field} className="ltag"><span className="ltag__name">{FIELD_LABEL[f.field]}</span> <LevelChip level={f.level} /></span>)}
              </div>
              <div className="entry__tags" data-testid="entry-tags">{tagsByEntry[i].map((t) => <TagButton key={tagId(t)} t={t} on={selected.has(tagId(t))} onToggle={toggle} testId="entry-tag" />)}</div>
              <JsonTree value={parsed[i].value} raw={line} marks={textMarks(i)} label={`Log entry ${i + 1}`} testId={`entry-${i}`} />
            </li>
          );
        })}
      </ol>
      {visibleIdx.length > shown && <button type="button" onClick={() => setAll(true)} data-testid="entries-all">Show all {visibleIdx.length} entries</button>}
      {scored && <p className="muted" data-testid="not-present">{missing.length ? <>Not present in this entry: <b>{missing.map((f) => FIELD_LABEL[f]).join(", ")}</b>.</> : "All four requirement fields appear in this entry."}</p>}
    </div>
  );
}
