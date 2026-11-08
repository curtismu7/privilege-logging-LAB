import { useCallback, useEffect, useMemo, useState } from "react";
import { getJson } from "../api";
import { Chip } from "./Chips";
import LogEntries from "./LogEntries";

// Privilege -> Elasticsearch only: what Privilege itself wrote to its hosted Elasticsearch, read through the console. Nothing from the
// gateway pod log or our sidecar appears here. Each entry names its index and whether it is a runtime or a console event.
const RANGES = [[15, "Last 15 minutes"], [60, "Last hour"], [360, "Last 6 hours"], [1440, "Last 24 hours"], [10080, "Last 7 days"]];

export default function PrivilegePage({ info, signal, onConfirmNeeded }) {
  const real = info?.source === "real";
  const [minutes, setMinutes] = useState(60);
  const [kind, setKind] = useState("all");
  const [index, setIndex] = useState("all");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setData(await getJson(`/api/privilege-logs?minutes=${minutes}`)); }
    catch (e) { setData(null); if (e.status === 412) onConfirmNeeded?.(); setError(e.message || "Could not read Privilege's logs."); }
    finally { setLoading(false); }
  }, [minutes, onConfirmNeeded]);
  useEffect(() => { load(); }, [load, signal]);

  const indices = useMemo(() => [...new Set((data?.entries || []).map((e) => e.index || "unknown index"))].sort(), [data]);
  const shown = (data?.entries || []).filter((e) => (kind === "all" || e.kind === kind) && (index === "all" || (e.index || "unknown index") === index));
  const counts = (data?.entries || []).reduce((n, e) => ({ ...n, [e.kind]: (n[e.kind] || 0) + 1 }), {});

  return (
    <div data-testid="privilege-page">
      <p className="channel channel--privilege-es" data-testid="privilege-channel">PRIVILEGE -&gt; ELASTICSEARCH ONLY: {data?.channel || "Privilege -> Elasticsearch (Privilege hosted), read through the console"}. Nothing on this page comes from the gateway pod log or our sidecar.</p>
      <div className="priv-filters">
        <label className="inline">Time range{" "}
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} disabled={!real} data-testid="priv-range">
            {RANGES.map(([m, l]) => <option key={m} value={m}>{l}</option>)}
          </select>
        </label>
        <label className="inline">Kind{" "}
          <select value={kind} onChange={(e) => setKind(e.target.value)} data-testid="priv-kind">
            <option value="all">Runtime and console</option><option value="runtime">Runtime events only</option><option value="console">Console events only</option>
          </select>
        </label>
        <label className="inline">Index{" "}
          <select value={index} onChange={(e) => setIndex(e.target.value)} data-testid="priv-index">
            <option value="all">All indices</option>{indices.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </label>
        <button type="button" className="primary" onClick={load} disabled={loading} data-testid="priv-load">{loading ? "Reading..." : "Read again"}</button>
      </div>
      {loading && <p className="busy" role="status" data-testid="priv-busy"><span className="spinner" aria-hidden="true" /> Reading Privilege&apos;s logs through the console...</p>}
      {error && <p className="notice" role="alert" data-testid="priv-error">{error}</p>}
      {data && !loading && (
        <>
          <p className="muted" data-testid="priv-summary">
            {data.source === "mock" ? <><Chip kind="info">Recorded sample</Chip> {data.note}</> : <><Chip kind="ok">Live read</Chip> {data.from} to {data.to} from {data.origin}.</>}
            {" "}{(data.entries || []).length} entries: {counts.runtime || 0} runtime, {counts.console || 0} console{counts.unknown ? `, ${counts.unknown} unknown` : ""}.{data.truncated ? " The answer was cut at the size cap." : ""}
          </p>
          <p className="muted"><b>Runtime event</b>: something the gateway did with traffic (a call, a policy decision, a guardrail verdict, an approval hold). <b>Console event</b>: an admin change in the Privilege console.</p>
          {shown.length ? <LogEntries lines={shown.map((e) => e.text)} kinds={shown.map((e) => e.kind)} indices={shown.map((e) => e.index)} from="Privilege -> Elasticsearch" methods={shown.map(() => (data.source === "mock" ? "recorded" : undefined))} scored={false} testId="priv-lines" />
            : <p className="muted" data-testid="priv-empty">No Privilege log entries match{data.source === "real" ? " in this time range" : ""}.</p>}
        </>
      )}
    </div>
  );
}
