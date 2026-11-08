// The progress and failure states of one case's run. Never a blank wait: a status line always says what is happening.
//   Sending...  ->  Fetching the log entry...  (with attempt and elapsed time while it retries)
//   failures are explicit: "Log source not reachable", "No entry found within N s", or the error, each with a Retry.
//   A failed send ("error") has no Retry: that would re-send. A failed log fetch (fetchFailed) does: Retry only fetches again.
export function busyText(b, mode) {
  if (b.phase === "sending") return mode === "real" ? "Sending..." : "Sending (replaying the recorded call)...";
  if (b.phase === "fetching") {
    const secs = Math.round((b.elapsedMs || 0) / 1000);
    const max = b.maxMs ? Math.round(b.maxMs / 1000) : null;
    const base = b.simulated ? "Fetching the log entry (simulated delay)..." : "Fetching the log entry...";
    return b.attempt > 1 || secs > 0 ? `${base} No entry found yet after ${secs} s${max ? ` (retrying until ${max} s)` : ""}.` : base;
  }
  if (b.phase === "unreachable") return b.detail || "Log source not reachable.";
  if (b.phase === "timeout") return b.detail || "No entry found in time.";
  return b.detail || "Something went wrong.";
}

export default function Busy({ id, b, mode, onRetry, canRetry = true }) {
  if (!b) return null;
  const active = b.phase === "sending" || b.phase === "fetching";
  if (active) {
    return (
      <div className="busy" role="status" aria-live="polite" data-testid={`busy-${id}`} data-phase={b.phase}>
        <span className="spinner" aria-hidden="true" />
        <span>{busyText(b, mode)}</span>
      </div>
    );
  }
  return (
    <div className="busy busy--fail" role="alert" data-testid={`busy-${id}`} data-phase={b.phase}>
      <span><b>{b.phase === "unreachable" ? "Log source not reachable." : b.phase === "timeout" ? "No entry found." : "Failed."}</b> {busyText(b, mode)}</span>
      {canRetry && (b.phase !== "error" || b.fetchFailed) && <button type="button" onClick={() => onRetry(id)} data-testid={`retry-${id}`}>Retry</button>}
      {b.phase === "timeout" && <span className="muted"> You can also paste the gateway log lines on the Trace page.</span>}
    </div>
  );
}
