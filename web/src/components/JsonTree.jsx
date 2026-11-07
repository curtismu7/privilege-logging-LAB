import { useEffect, useMemo, useRef, useState } from "react";
import { FIELDS, FIELD_LABEL } from "../lib/marks";
import { copyToClipboard, redactText } from "../lib/clipboard";
import { STR_CAP, STR_MAX, buildNodes, containerPaths, defaultExpanded, toJsonText, visibleRows } from "../lib/jsonTree";
import { visible } from "../safeText";

// The legend for the four requirement fields. Every badge carries its word, never colour alone.
export function FieldLegend() {
  return (
    <p className="legend" data-testid="field-legend" aria-label="Legend: where the four requirement fields live in an entry">
      <span className="muted">In the entry:</span>
      {FIELDS.map((f) => <span key={f} className={`fbadge fbadge--${f}`} data-field={f}>{FIELD_LABEL[f]}</span>)}
      <span className="muted">(user, agent or client, tool, policy decision)</span>
    </p>
  );
}

// Text of a string node with the scorer's marks underlined inline. Marks are found by their text inside this string (first occurrence).
function Marked({ text, marks }) {
  const hits = [];
  for (const m of marks) { const i = m.text ? text.indexOf(m.text) : -1; if (i >= 0) hits.push({ start: i, end: i + m.text.length, m }); }
  hits.sort((a, b) => a.start - b.start);
  const out = []; let at = 0;
  for (const h of hits) {
    if (h.start < at) continue;
    if (h.start > at) out.push(<span key={`t${at}`}>{visible(text.slice(at, h.start))}</span>);
    out.push(<mark key={`m${h.start}`} data-field={h.m.field} data-level={h.m.level} title={`${FIELD_LABEL[h.m.field]}: ${h.m.why}`}>{visible(text.slice(h.start, h.end))}</mark>);
    at = h.end;
  }
  if (at < text.length || !out.length) out.push(<span key={`t${at}`}>{visible(text.slice(at))}</span>);
  return out;
}

// A syntax-coloured, collapsible JSON tree. Rows are built by an iterative walker (lib/jsonTree.js) with depth, node and string caps;
// every value is a React text node, never markup. ARIA: role=tree, rows are treeitems with aria-level/aria-expanded.
export default function JsonTree({ value, raw, marks = [], label = "Log entry", testId = "entry" }) {
  const tree = useMemo(() => buildNodes(value), [value]);
  const [expanded, setExpanded] = useState(() => defaultExpanded(tree));
  const [more, setMore] = useState(() => new Set());
  const [showRaw, setShowRaw] = useState(false);
  const [focus, setFocus] = useState(tree.root);
  const [copied, setCopied] = useState("");
  const refs = useRef(new Map());
  const wantFocus = useRef(false);
  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);

  useEffect(() => { if (wantFocus.current) { wantFocus.current = false; refs.current.get(focus)?.focus(); } }, [focus, rows]);

  const toggle = (path) => setExpanded((cur) => { const n = new Set(cur); if (n.has(path)) n.delete(path); else n.add(path); return n; });
  const toggleMore = (path) => setMore((cur) => { const n = new Set(cur); if (n.has(path)) n.delete(path); else n.add(path); return n; });
  const move = (path) => { wantFocus.current = true; setFocus(path); };
  const parentOf = (path) => path.slice(0, path.lastIndexOf("/"));

  const onKey = (e, row, i) => {
    const { node } = row; const isC = node.type === "object" || node.type === "array";
    if (e.key === "ArrowDown") { e.preventDefault(); if (rows[i + 1]) move(rows[i + 1].node.path); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (rows[i - 1]) move(rows[i - 1].node.path); }
    else if (e.key === "Home") { e.preventDefault(); move(rows[0].node.path); }
    else if (e.key === "End") { e.preventDefault(); move(rows[rows.length - 1].node.path); }
    else if (e.key === "ArrowRight") { e.preventDefault(); if (isC && !expanded.has(node.path)) toggle(node.path); else if (isC && rows[i + 1]) move(rows[i + 1].node.path); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); if (isC && expanded.has(node.path)) toggle(node.path); else if (node.path !== tree.root) move(parentOf(node.path)); }
    else if ((e.key === "Enter" || e.key === " ") && isC) { e.preventDefault(); toggle(node.path); }
  };

  const copy = async () => { const ok = await copyToClipboard(redactText(toJsonText(value))); setCopied(ok ? "Copied (redacted JSON)." : "Copy was blocked."); };
  const fieldsOfNode = (node) => {
    if (node.value === undefined || node.value === null) return [];
    const s = String(node.value);
    return [...new Set(marks.filter((m) => m.text && s.includes(m.text)).map((m) => m.field))];
  };
  const marksOfNode = (node) => (node.value === undefined || node.value === null ? [] : marks.filter((m) => m.text && String(node.value).includes(m.text)));

  return (
    <div className="jt" data-testid={testId}>
      <div className="jt__bar" role="toolbar" aria-label={`${label} controls`}>
        <button type="button" onClick={() => setExpanded(new Set(containerPaths(tree)))} data-testid={`${testId}-expand`}>Expand all</button>
        <button type="button" onClick={() => setExpanded(new Set())} data-testid={`${testId}-collapse`}>Collapse all</button>
        <button type="button" aria-pressed={showRaw} onClick={() => setShowRaw((v) => !v)} data-testid={`${testId}-raw`}>Raw</button>
        <button type="button" onClick={copy} data-testid={`${testId}-copy`}>Copy JSON</button>
        <span role="status" aria-live="polite" className="muted" data-testid={`${testId}-copied`}>{copied}</span>
      </div>
      {showRaw ? <pre className="code jt__raw" data-testid={`${testId}-rawtext`}>{visible(raw ?? toJsonText(value))}</pre> : (
        <div role="tree" aria-label={label} className="jt__tree">
          {rows.map((row, i) => {
            const { node, level, pos, size } = row;
            const isC = node.type === "object" || node.type === "array";
            const open = isC && expanded.has(node.path);
            const fields = fieldsOfNode(node);
            const text = node.type === "string" ? String(node.value) : null;
            const long = text !== null && text.length > STR_CAP;
            const full = more.has(node.path);
            const shown = text === null ? null : long && !full ? text.slice(0, STR_CAP) : text.slice(0, STR_MAX);
            return (
              <div key={node.path} role="treeitem" tabIndex={focus === node.path || (!rows.some((r) => r.node.path === focus) && i === 0) ? 0 : -1}
                aria-level={level} aria-posinset={pos} aria-setsize={size} aria-expanded={isC ? open : undefined}
                ref={(el) => { if (el) refs.current.set(node.path, el); else refs.current.delete(node.path); }}
                className="jt__row" style={{ "--lvl": level }} data-type={node.type} data-testid={`${testId}-row`}
                onKeyDown={(e) => onKey(e, row, i)} onFocus={() => setFocus(node.path)}
                onClick={(e) => { if (isC && e.target === e.currentTarget) toggle(node.path); }}>
                {isC ? <button type="button" className="jt__twisty" tabIndex={-1} aria-label={`${open ? "Collapse" : "Expand"} ${node.key ?? "entry"}`} onClick={() => toggle(node.path)}>{open ? "▾" : "▸"}</button> : <span className="jt__twisty jt__twisty--leaf" aria-hidden="true" />}
                {node.key !== null && <span className="jt__key" data-testid="jt-key">{visible(node.key)}</span>}
                {node.key !== null && <span className="jt__punct">: </span>}
                {isC && <span className="jt__punct" data-testid="jt-summary">{node.type === "array" ? `[${node.size}]` : `{${node.size}}`}{node.depthLimited ? " (depth limit reached)" : ""}{!open && node.more === 0 ? "" : ""}</span>}
                {isC && open && node.more > 0 && !node.depthLimited && <span className="muted"> ({node.more} more not shown)</span>}
                {node.type === "string" && <span className="jt__str" data-type="string" data-testid="jt-string">"<Marked text={shown} marks={marksOfNode(node)} />{long && !full ? "…" : ""}"</span>}
                {node.type === "number" && <span className="jt__num" data-type="number">{String(node.value)}</span>}
                {node.type === "boolean" && <span className="jt__bool" data-type="boolean">{String(node.value)}</span>}
                {node.type === "null" && <span className="jt__null" data-type="null">null</span>}
                {long && <button type="button" className="jt__more" onClick={() => toggleMore(node.path)}>{full ? "Show less" : `Show more (${text.length} chars)`}</button>}
                {long && full && text.length > STR_MAX && <span className="muted"> (cut at {STR_MAX} characters)</span>}
                {fields.map((f) => <span key={f} className={`fbadge fbadge--${f}`} data-field={f} data-testid={`badge-${f}`}>{FIELD_LABEL[f]}</span>)}
              </div>
            );
          })}
          {tree.cut > 0 && <div className="jt__row muted" data-testid="jt-cut">… {tree.cut} more node(s) not shown (cap {1500}).</div>}
        </div>
      )}
    </div>
  );
}
