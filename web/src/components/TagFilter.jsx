import { useState } from "react";
import { matchesAll, tagId } from "../lib/entryTags";

// One tag filter for the Run page cards and the Trace entries. Styled after the Demo Shelf's tag filter (demo-shelf-LAB): a "Filter by tag" toggle, then a panel of groups with a pill per tag
// and its count, "X of Y shown", Clear tags / Hide tags. A count is how many entries that tag would leave with every other group's
// selection applied (within a group, tags add up); a tag that would leave none is disabled unless it is selected.
export function TagFilter({ groups, label: aria, tagsByEntry, selected, onToggle, onClear, shown, total, startOpen = false }) {
  const [open, setOpen] = useState(startOpen);
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
    <section className="tag-filters" aria-label={aria} data-testid="tag-filter">
      {groups.map(([g, label]) => {
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
export function TagPills({ tags, selected, onToggle }) {
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

