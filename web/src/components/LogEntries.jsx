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

// Styled after the Demo Shelf's tag filter (demo-shelf-LAB): a "Filter by tag" toggle, then a panel of groups with a pill per tag
// and its count, "X of Y shown", Clear tags / Hide tags. A count is how many entries that tag would leave with every other group's
// selection applied (within a group, tags add up); a tag that would leave none is disabled unless it is selected.
function TagFilter({ tagsByEntry, selected, onToggle, onClear, shown, total }) {
  const [open, setOpen] = useState(false);
  const all = new Map();
  for (const tags of tagsByEntry) for (const t of tags) all.set(tagId(t), t);
  const countFor = (t) => {
    const others = new Set([...selected].filter((id) => !id.startsWith(`${t.group}:`)));
    others.add(tagId(t));
    return tagsByEntry.filter((tags) => matchesAll(tags, others)).length;
  };
  const status = <span className="tag-filters__count" role="status" data-testid="tag-filter-count">{shown} of {total} shown</span>;
  if (!open && selected.size === 0) {
    return <p className="tag-toggle"><button type="button" aria-expanded="false" onClick={() => setOpen(true)} data-testid="tag-filter-open">Filter by tag</button> {status}</p>;
  }
  return (
    <section className="tag-filters" aria-label="Filter entries by tag" data-testid="tag-filter">
      {GROUPS.map(([g, label]) => {
        const items = [...all.values()].filter((t) => t.group === g).map((t) => ({ t, n: countFor(t) })).sort((a, b) => b.n - a.n || a.t.value.localeCompare(b.t.value));
        if (!items.length) return null;
        return (
          <div key={g} role="group" aria-label={label} className="tag-filters__row">
            <span className="tag-filters__group">{label}</span>
            {items.map(({ t, n }) => {
              const on = selected.has(tagId(t));
              return (
                <button key={tagId(t)} type="button" className="tag-chip" aria-pressed={on} disabled={!on && n === 0} onClick={() => onToggle(tagId(t))} data-testid="filter-tag" data-tag={tagId(t)}>
                  {t.value} <small>{n}</small>
                </button>
              );
            })}
          </div>
        );
      })}
      <div className="tag-filters__bar">
        {status}
        {selected.size > 0 && <button type="button" onClick={onClear} data-testid="tag-filter-clear">Clear tags</button>}
        {selected.size === 0 && <button type="button" aria-expanded="true" onClick={() => setOpen(false)} data-testid="tag-filter-hide">Hide tags</button>}
      </div>
    </section>
  );
}

// The tags on one entry, as the shelf shows tags on a box: small pills (a picked one is filled), at most MAX_PILLS, then "+N more".
const MAX_PILLS = 6;
function EntryTags({ tags, selected, onToggle }) {
  const [more, setMore] = useState(false);
  const shown = more ? tags : tags.slice(0, MAX_PILLS);
  return (
    <ul className="tag-pills" aria-label="Tags" data-testid="entry-tags">
      {shown.map((t) => (
        <li key={tagId(t)}>
          <button type="button" className="tag-pill" aria-pressed={selected.has(tagId(t))} onClick={() => onToggle(tagId(t))} data-testid="entry-tag" data-tag={tagId(t)}>{t.value}</button>
        </li>
      ))}
      {!more && tags.length > MAX_PILLS && <li><button type="button" className="tag-more" onClick={() => setMore(true)} data-testid="entry-tags-more">+{tags.length - MAX_PILLS} more</button></li>}
    </ul>
  );
}

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
              <EntryTags tags={tagsByEntry[i]} selected={selected} onToggle={toggle} />
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
