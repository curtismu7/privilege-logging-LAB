// Turns one log line plus the scorer's marks for it into ordered text segments: [{ text, mark? }]. Marks that point nowhere (start < 0),
// run past the line or overlap an earlier mark are dropped, so a hostile or odd mark can never reorder or hide the line's text.
export function segments(line, marks = []) {
  const text = String(line);
  const ok = marks
    .filter((m) => Number.isInteger(m.start) && Number.isInteger(m.end) && m.start >= 0 && m.end > m.start && m.end <= text.length)
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out = []; let at = 0;
  for (const m of ok) {
    if (m.start < at) continue;
    if (m.start > at) out.push({ text: text.slice(at, m.start) });
    out.push({ text: text.slice(m.start, m.end), mark: m });
    at = m.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out.length ? out : [{ text }];
}

// The fields a line carries, for the chips next to it (including facts with no span).
export function fieldsOf(marks = []) {
  const seen = new Map();
  for (const m of marks) { const prev = seen.get(m.field); if (!prev || (m.level === "met" && prev !== "met")) seen.set(m.field, m.level); }
  return [...seen.entries()].map(([field, level]) => ({ field, level }));
}

export const FIELDS = ["user", "agent", "tool", "decision"];
export const FIELD_LABEL = { user: "User", agent: "Agent", tool: "Tool", decision: "Decision" };
export const LEVEL_LABEL = { met: "met", partial: "partial", missing: "missing", na: "n/a" };
export const LEVEL_CLASS = { met: "chip--ok", partial: "chip--warn", missing: "chip--danger", na: "chip--info" };
