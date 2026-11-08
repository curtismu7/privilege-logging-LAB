// Export of the Privilege -> Elasticsearch entries the page holds (already redacted by the server) as JSON or CSV, in the browser.
export const CSV_COLUMNS = [
  ["time", (e) => e.at], ["index", (e) => e.index], ["kind", (e) => e.kind], ["user", (e) => e.fields?.user], ["agent", (e) => e.fields?.agent],
  ["agent_from", (e) => e.fields?.agentFrom], ["principal_kind", (e) => e.fields?.principalKind], ["tool", (e) => e.fields?.tool],
  ["decision", (e) => e.fields?.decision], ["app", (e) => e.fields?.app], ["event", (e) => e.fields?.event], ["reason", (e) => e.fields?.reason],
  ["request_id", (e) => e.fields?.requestId], ["trace_id", (e) => e.fields?.traceId], ["record", (e) => e.text],
];

// One CSV cell: always quoted, quotes doubled, and a cell a spreadsheet would run as a formula (= + - @, tab, CR) gets a leading '.
export function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const toCsv = (entries) => [CSV_COLUMNS.map(([h]) => csvCell(h)).join(","), ...entries.map((e) => CSV_COLUMNS.map(([, f]) => csvCell(f(e))).join(","))].join("\r\n") + "\r\n";
export const toJson = (entries, meta = {}) => `${JSON.stringify({ ...meta, entries }, null, 1)}\n`;

export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
