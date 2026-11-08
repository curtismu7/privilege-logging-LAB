import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "../api";
import { Chip } from "./Chips";
import LogEntries from "./LogEntries";
import { download, toCsv, toJson } from "../lib/privExport";

// Privilege -> Elasticsearch only: what Privilege itself wrote to its hosted Elasticsearch, read through the console. Nothing from the
// gateway pod log or our sidecar appears here. Any range up to 90 days back, filters, counts, a chart, a table, the related records of
// one call, export and the same view in Kibana. The server reads, redacts, parses, filters and pages; this page only shows.
const RANGES = [["15m", "15 min"], ["1h", "1 h"], ["6h", "6 h"], ["24h", "24 h"], ["7d", "7 d"], ["30d", "30 d"], ["90d", "90 d"]];
const DAY = 86_400_000;
const FIELD_LABEL = { user: "User", agent: "Agent key / client", tool: "Tool", app: "App", event: "Event" };
const KIND = { runtime: ["ok", "runtime"], console: ["info", "console"], unknown: ["neutral", "unknown"] };
const DECISION = { allow: "ok", deny: "danger", hitl: "warn" };

const pad = (n) => String(n).padStart(2, "0");
// The custom picker is in UTC, like every other time on the page: datetime-local has no zone, so its value is read as UTC (Z added).
export const toUtcInput = (iso) => { const d = new Date(iso); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const fromUtcInput = (v) => { const t = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(v || "") ? Date.parse(`${v}Z`) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const shortTime = (iso) => (iso ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z") : "no time");

function queryOf(win, filters, page, extra = {}) {
  const p = new URLSearchParams();
  if (win.range) p.set("range", win.range); else { p.set("from", win.from); p.set("to", win.to); }
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
  if (page) p.set("page", String(page));
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

export default function PrivilegePage({ info, signal, onConfirmNeeded }) {
  // The parent passes a fresh callback on every render; keeping it in a ref keeps `load` stable, so asking for the confirmation
  // (which re-renders the parent) does not trigger another read, another 412 and so on in a loop.
  const confirmNeeded = useRef(onConfirmNeeded);
  confirmNeeded.current = onConfirmNeeded;
  const opener = useRef(null); // the row button that opened Related, to give focus back on Close
  const [win, setWin] = useState({ range: "1h" });
  const [filters, setFilters] = useState({});
  const [text, setText] = useState("");
  const [page, setPage] = useState(0);
  const [reload, setReload] = useState(0);
  const [view, setView] = useState("table");
  const [custom, setCustom] = useState(null); // { from, to, problem } while the custom picker is open
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [related, setRelated] = useState(null);
  const [exporting, setExporting] = useState("");
  // Paging and filter changes keep the window the last answer resolved (so "last hour" does not drift while you page); a new range,
  // Read again, a mode switch or Reset resolves it again.
  const pinned = useRef(null);
  useEffect(() => { pinned.current = null; }, [win, reload, signal, info?.source]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const d = await getJson(`/api/privilege-logs?${queryOf(pinned.current || win, filters, page)}`);
      pinned.current = { from: d.from, to: d.to };
      setData(d);
    } catch (e) { setData(null); if (e.status === 412) confirmNeeded.current?.(); setError(e.message || "Could not read Privilege's logs."); }
    finally { setLoading(false); }
  }, [win, filters, page]);
  useEffect(() => { load(); }, [load, signal, reload]);
  useEffect(() => { setRelated(null); }, [win, filters, signal, info?.source]);

  const setFilter = (k, v) => { setPage(0); setFilters((f) => { const n = { ...f }; if (v) n[k] = v; else delete n[k]; return n; }); };
  const pickRange = (r) => { setCustom(null); setPage(0); setWin({ range: r }); };
  const clock = data?.clock;
  const openCustom = () => setCustom({ from: toUtcInput(data?.from || new Date(Date.now() - 3_600_000).toISOString()), to: toUtcInput(data?.to || new Date().toISOString()), problem: "" });
  const applyCustom = (e) => {
    e.preventDefault();
    const from = fromUtcInput(custom.from); const to = fromUtcInput(custom.to);
    const now = clock ? Date.parse(clock.now) : Date.now();
    let problem = "";
    if (!from || !to) problem = "Enter both From and To.";
    else if (Date.parse(from) >= Date.parse(to)) problem = "From must be before To.";
    else if (Date.parse(from) < now - 90 * DAY) problem = "From may be at most 90 days back.";
    else if (Date.parse(to) > now + 60_000) problem = "To may not be in the future.";
    if (problem) return setCustom({ ...custom, problem });
    setPage(0); setWin({ from, to }); setCustom(null);
    return undefined;
  };
  const zoom = (b) => { setCustom(null); setPage(0); setWin({ from: b.from, to: b.to }); };

  const openRelated = async (e, btn) => {
    opener.current = btn || null;
    const p = new URLSearchParams({ at: e.at });
    if (e.fields.requestId) p.set("request_id", e.fields.requestId);
    if (e.fields.traceId) p.set("trace_id", e.fields.traceId);
    setRelated({ anchor: e, loading: true });
    try { setRelated({ anchor: e, ...(await getJson(`/api/privilege-logs/related?${p}`)) }); }
    catch (err) { if (err.status === 412) confirmNeeded.current?.(); setRelated({ anchor: e, error: err.message }); }
  };

  const doExport = async (scope, format) => {
    setExporting(""); let entries = data.entries;
    if (scope === "all") {
      try { entries = (await getJson(`/api/privilege-logs?${queryOf(pinned.current || win, filters, 0, { all: "1" })}`)).entries; }
      catch (e) { setExporting(`Export failed: ${e.message}`); return; }
    }
    const name = `privilege-logs-${data.source}-${scope === "all" ? "filtered" : `page-${(data.paging.page || 0) + 1}`}`;
    if (format === "csv") download(`${name}.csv`, toCsv(entries), "text/csv");
    else download(`${name}.json`, toJson(entries, { source: data.source, from: data.from, to: data.to, filters: data.filters, ...(data.label ? { label: data.label } : {}) }), "application/json");
    setExporting(`Downloaded ${entries.length} ${entries.length === 1 ? "entry" : "entries"} as ${format.toUpperCase()} (already redacted).`);
  };

  const s = data?.summary;
  return (
    <div data-testid="privilege-page">
      <p className="channel channel--privilege-es" data-testid="privilege-channel">PRIVILEGE -&gt; ELASTICSEARCH ONLY: {data?.channel || "Privilege -> Elasticsearch (Privilege hosted), read through the console"}. Nothing on this page comes from the gateway pod log or our sidecar.</p>

      <div className="priv-filters" role="group" aria-label="Time range">
        <span className="seg" data-testid="priv-ranges">
          {RANGES.map(([r, l]) => <button key={r} type="button" aria-pressed={win.range === r} className={win.range === r ? "primary" : ""} onClick={() => pickRange(r)} data-testid={`priv-range-${r}`}>{l}</button>)}
          <button type="button" aria-pressed={!win.range} className={!win.range ? "primary" : ""} onClick={openCustom} data-testid="priv-range-custom">Custom</button>
        </span>
        <button type="button" onClick={() => setReload((n) => n + 1)} disabled={loading} data-testid="priv-load">{loading ? "Reading..." : "Read again"}</button>
      </div>
      {custom && (
        <form className="priv-filters" onSubmit={applyCustom} data-testid="priv-custom">
          {/* No min/max: the page's own messages explain the 90-day and future bounds (a browser bubble would block them). */}
          <label className="inline">From (UTC) <input type="datetime-local" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value, problem: "" })} data-testid="priv-from" /></label>
          <label className="inline">To (UTC) <input type="datetime-local" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value, problem: "" })} data-testid="priv-to" /></label>
          <button type="submit" className="primary" data-testid="priv-apply">Apply</button>
          <button type="button" onClick={() => setCustom(null)}>Cancel</button>
          {custom.problem && <p className="field-error" role="alert" data-testid="priv-custom-error">{custom.problem}</p>}
        </form>
      )}
      {clock?.mock && <p className="muted" data-testid="priv-clock">Mock clock: ranges count back from the end of the recording ({shortTime(clock.now)}), at most 90 days.</p>}

      <div className="priv-filters" role="group" aria-label="Filters">
        <label className="inline">Kind <select value={filters.kind || ""} onChange={(e) => setFilter("kind", e.target.value)} data-testid="priv-kind">
          <option value="">Runtime and console</option><option value="runtime">Runtime events only</option><option value="console">Console events only</option>
        </select></label>
        <label className="inline">Index <select value={filters.index || ""} onChange={(e) => setFilter("index", e.target.value)} data-testid="priv-index">
          <option value="">All indices</option>
          {[...new Set([...(data?.facets?.index || []).map((x) => x.value), ...(filters.index ? [filters.index] : [])])].map((v) => <option key={v} value={v}>{v}</option>)}
        </select></label>
        <label className="inline">Decision <select value={filters.decision || ""} onChange={(e) => setFilter("decision", e.target.value)} data-testid="priv-decision">
          <option value="">Any</option><option value="allow">allow</option><option value="deny">deny</option><option value="hitl">hitl (approval)</option>
        </select></label>
        {Object.entries(FIELD_LABEL).map(([k, l]) => (
          <label key={k} className="inline">{l} <select value={filters[k] || ""} onChange={(e) => setFilter(k, e.target.value)} data-testid={`priv-f-${k}`}>
            <option value="">Any</option>
            {[...new Set([...(data?.facets?.[k] || []).map((x) => x.value), ...(filters[k] ? [filters[k]] : [])])].map((v) => <option key={v} value={v}>{v}</option>)}
          </select></label>
        ))}
        <form className="inline" onSubmit={(e) => { e.preventDefault(); setFilter("q", text.trim().slice(0, 200)); }}>
          <label className="inline">Text <input type="search" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder="any text in the record" data-testid="priv-q" /></label>
          <button type="submit" data-testid="priv-q-apply">Search</button>
        </form>
        {Object.keys(filters).length > 0 && <button type="button" onClick={() => { setText(""); setPage(0); setFilters({}); }} data-testid="priv-clear">Clear filters</button>}
      </div>

      {loading && <p className="busy" role="status" data-testid="priv-busy"><span className="spinner" aria-hidden="true" /> Reading Privilege&apos;s logs through the console...</p>}
      {error && <p className="notice" role="alert" data-testid="priv-error">{error}</p>}
      {data && (
        <>
          <p className="muted" data-testid="priv-summary">
            {data.source === "mock" ? <><Chip kind="info" testId="priv-mock-label">Mock: {data.label}</Chip> {data.note}</> : <><Chip kind="ok">Live read</Chip> from {data.origin}.</>}
            {" "}{shortTime(data.from)} to {shortTime(data.to)}: {data.read} record{data.read === 1 ? "" : "s"} read{data.reported !== null && data.reported !== undefined ? ` (the console reports ${data.reported})` : ""}, {s.total} match the filters.
          </p>
          {data.limit && <p className="notice" role="status" data-testid="priv-limit"><b>Capped sample.</b> {data.limit}</p>}
          <Summary s={s} capped={!!data.limit} />
          <Histogram h={data.histogram} onZoom={zoom} />
          <p className="muted"><b>Runtime event</b>: something the gateway did with traffic (a call, a policy decision, a guardrail verdict, an approval hold). <b>Console event</b>: an admin change in the Privilege console.</p>

          <div className="row">
            <span className="seg" role="group" aria-label="View">
              <button type="button" aria-pressed={view === "table"} className={view === "table" ? "primary" : ""} onClick={() => setView("table")} data-testid="priv-view-table">Table</button>
              <button type="button" aria-pressed={view === "json"} className={view === "json" ? "primary" : ""} onClick={() => setView("json")} data-testid="priv-view-json">JSON</button>
            </span>
            <Paging p={data.paging} onPage={setPage} />
          </div>
          {!data.entries.length ? <p className="muted" data-testid="priv-empty">No Privilege log entries match{data.source === "real" ? " in this time range" : ""}.</p>
            : view === "table" ? <EntryTable entries={data.entries} onOpen={openRelated} selected={related?.anchor} />
              : <LogEntries lines={data.entries.map((e) => e.text)} kinds={data.entries.map((e) => e.kind)} indices={data.entries.map((e) => e.index)} from="Privilege -> Elasticsearch" methods={data.entries.map(() => (data.source === "mock" ? "recorded" : undefined))} scored={false} testId="priv-lines" />}
          {related && <Related r={related} onClose={() => { const b = opener.current; setRelated(null); if (b?.isConnected) b.focus(); }} />}

          <div className="row" role="group" aria-label="Export" data-testid="priv-export">
            <span className="muted">Export (redacted):</span>
            <button type="button" onClick={() => doExport("page", "json")} disabled={!data.entries.length} data-testid="priv-export-page-json">JSON, this page</button>
            <button type="button" onClick={() => doExport("page", "csv")} disabled={!data.entries.length} data-testid="priv-export-page-csv">CSV, this page</button>
            <button type="button" onClick={() => doExport("all", "json")} disabled={!s.total} data-testid="priv-export-all-json">JSON, all {s.total}</button>
            <button type="button" onClick={() => doExport("all", "csv")} disabled={!s.total} data-testid="priv-export-all-csv">CSV, all {s.total}</button>
            {exporting && <span className="muted" role="status" data-testid="priv-export-status">{exporting}</span>}
          </div>
          <Kibana k={data.kibana} />
        </>
      )}
    </div>
  );
}

function Summary({ s, capped }) {
  const ai = Object.entries(s.aiguard);
  return (
    <div className="priv-summary" role="group" aria-label="Counts for this filter and range" data-testid="priv-counts">
      <span className="ltag"><b data-testid="priv-count-total">{s.total}</b> entries{capped ? " (capped sample)" : ""}</span>
      <span className="ltag"><Chip kind="ok">runtime</Chip> <b data-testid="priv-count-runtime">{s.kinds.runtime || 0}</b></span>
      <span className="ltag"><Chip kind="info">console</Chip> <b data-testid="priv-count-console">{s.kinds.console || 0}</b></span>
      {["allow", "deny", "hitl"].map((d) => <span key={d} className="ltag"><Chip kind={DECISION[d]}>{d}</Chip> <b data-testid={`priv-count-${d}`}>{s.decisions[d]}</b></span>)}
      <span className="ltag" data-testid="priv-count-aiguard">AI Guard: {ai.length ? ai.map(([v, n]) => `${v} ${n}`).join(", ") : "none"}</span>
    </div>
  );
}

// One series (entries per bucket): one hue, rounded tops, a 2px gap, native tooltips, and each bar is a button that zooms to its bucket.
function Histogram({ h, onZoom }) {
  const W = 600; const H = 120; const n = h.buckets.length; const max = Math.max(1, ...h.buckets.map((b) => b.count));
  const bw = W / n;
  const step = h.bucketMs >= DAY ? `${h.bucketMs / DAY} d` : h.bucketMs >= 3_600_000 ? `${h.bucketMs / 3_600_000} h` : `${h.bucketMs / 60_000} min`;
  // One bar covers the whole range only at the finest step (1 minute): there is nothing narrower to zoom to.
  const zoomable = n > 1;
  return (
    <figure className="priv-chart" data-testid="priv-chart">
      <figcaption className="muted" data-testid="priv-chart-caption">Entries over time ({step} per bar, max {max}). {zoomable ? "Click a bar with entries to narrow the range to it." : "1 minute is the finest step, so this range cannot be narrowed further."}</figcaption>
      <svg viewBox={`0 0 ${W} ${H + 2}`} preserveAspectRatio="none" role="group" aria-label="Entries over time">
        <line x1="0" x2={W} y1={H} y2={H} className="priv-chart__base" />
        {h.buckets.map((b, i) => {
          const bh = b.count ? Math.max(3, (b.count / max) * (H - 8)) : 0;
          const label = `${shortTime(b.from)} to ${shortTime(b.to)}: ${b.count} ${b.count === 1 ? "entry" : "entries"}`;
          // Only bars with entries are buttons (and tab stops); an empty bar would zoom to an empty range.
          const act = zoomable && b.count > 0;
          return (
            <g key={b.from} data-testid={`priv-bar-${i}`} data-count={b.count} className={act ? "priv-chart__hit" : undefined}
              {...(act ? { role: "button", tabIndex: 0, "aria-label": `${label}. Zoom to this range.`, onClick: () => onZoom(b), onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onZoom(b); } } } : {})}>
              <title>{label}</title>
              <rect x={i * bw} y="0" width={bw} height={H} className="priv-chart__target" />
              {bh > 0 && <rect x={i * bw + 1} y={H - bh} width={Math.max(1, bw - 2)} height={bh} rx="2" className="priv-chart__bar" />}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function Paging({ p, onPage }) {
  if (p.all) return null;
  return (
    <span className="row" data-testid="priv-paging">
      <button type="button" onClick={() => onPage(p.page - 1)} disabled={!p.newer} data-testid="priv-newer">Newer</button>
      <span className="muted" data-testid="priv-page">Page {p.page + 1} of {p.pages} ({p.total} entries, {p.pageSize} per page)</span>
      <button type="button" onClick={() => onPage(p.page + 1)} disabled={!p.older} data-testid="priv-older">Older</button>
    </span>
  );
}

function KindChip({ kind }) { const [k, w] = KIND[kind] || KIND.unknown; return <Chip kind={k}>{w}</Chip>; }

function EntryTable({ entries, onOpen, selected }) {
  return (
    <div className="scroll">
      <table className="tbl priv-table" data-testid="priv-table">
        <caption>Newest first. Choose a row to see the records that share its request id or trace id.</caption>
        <thead><tr>{["Time", "Index", "Kind", "User", "Agent", "Tool", "Decision"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>
          {entries.map((e, i) => {
            const f = e.fields; const linkable = !!(e.at && (f.requestId || f.traceId));
            return (
              <tr key={`${e.at}-${i}`} data-testid="priv-row" aria-selected={selected === e || undefined} className={selected === e ? "is-selected" : undefined}>
                <td className="mono">{linkable ? <button type="button" className="linkish" onClick={(ev) => onOpen(e, ev.currentTarget)} data-testid={`priv-row-open-${i}`} aria-label={`Related records for the ${e.index || "unknown"} entry at ${shortTime(e.at)}`}>{shortTime(e.at)}</button> : shortTime(e.at)}</td>
                <td className="mono">{e.index || "unknown"}</td>
                <td><KindChip kind={e.kind} /></td>
                <td className="mono">{f.user || ""}</td>
                <td className="mono">{f.agent || ""}{f.agentFrom === "client" ? <span className="muted"> (client)</span> : null}</td>
                <td className="mono">{f.tool || ""}</td>
                <td>{f.decision ? <Chip kind={DECISION[f.decision] || "neutral"}>{f.decision}</Chip> : f.event ? <span className="muted">{f.event}</span> : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Related({ r, onClose }) {
  const a = r.anchor;
  const heading = useRef(null);
  // The panel renders below the table: move focus (and so the view) to it when it opens for an entry.
  useEffect(() => { heading.current?.focus(); }, [a]);
  return (
    <section className="card card--sink" aria-label="Related records" data-testid="priv-related">
      <div className="row"><h2 className="card__title" tabIndex={-1} ref={heading} data-testid="priv-related-heading">Related records</h2><button type="button" onClick={onClose} data-testid="priv-related-close">Close</button></div>
      <p className="muted">Every record within 10 minutes of {shortTime(a.at)} that shares {a.fields.requestId ? <>request id <code>{a.fields.requestId}</code></> : null}{a.fields.requestId && a.fields.traceId ? " or " : ""}{a.fields.traceId ? <>trace id <code>{a.fields.traceId}</code></> : null}, and records linked to those by their own ids.</p>
      {r.loading && <p className="busy" role="status"><span className="spinner" aria-hidden="true" /> Reading...</p>}
      {r.error && <p className="notice" role="alert">{r.error}</p>}
      {r.limit && <p className="notice" role="status">{r.limit}</p>}
      {r.entries && (
        <ol className="entries" data-testid="priv-related-list">
          {r.entries.map((e, i) => (
            <li key={i} className="entry" data-testid="priv-related-item">
              <div className="entry__head">
                <span className="mono">{shortTime(e.at)}</span>
                <Chip kind="neutral">{e.index || "unknown index"}</Chip>
                <KindChip kind={e.kind} />
                <span className="muted">shares {e.via}</span>
                {e.at === a.at && e.index === a.index && <Chip kind="info">this entry</Chip>}
              </div>
              <p className="mono">{[e.fields.event || e.fields.message, e.fields.decision, e.fields.tool, e.fields.user].filter(Boolean).join(" · ")}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Kibana({ k }) {
  return (
    <section className="card card--neutral" aria-label="Open in Kibana" data-testid="priv-kibana">
      <h2 className="card__title">Same view in Kibana</h2>
      {k.url ? <p><a href={k.url} target="_blank" rel="noopener noreferrer" data-testid="priv-kibana-link">Open in Kibana (Discover, data view {k.dataView})</a> with this time range and query.</p>
        : <p className="field-error" data-testid="priv-kibana-problem">No Kibana link: {k.problem}</p>}
      <p className="muted">KQL: <code data-testid="priv-kql">{k.kql || "(no filter)"}</code></p>
      <p className="muted">Kibana at {k.origin || "(not set)"} (setting PRIVILEGE_KIBANA_URL). Reach it with a port-forward first: <code data-testid="priv-kibana-hint">{k.hint}</code>. Kibana shows what reached the SIEM index (Privilege&apos;s export plus the bridge), which may differ from what the console holds.</p>
    </section>
  );
}
