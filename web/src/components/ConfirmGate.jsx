import { useEffect, useRef } from "react";

// The confirm gate before the first Real send (per browser tab). Names the origins; nothing is sent until the button is pressed.
// inline: drawn inside the case card whose Run was pressed, so the page does not move; focus goes to the Send button without scrolling.
// Otherwise (Run all, the Privilege page) it renders at the top of the page and is scrolled into view, so a press far down the page
// does not look like it did nothing.
export default function ConfirmGate({ gate, onConfirm, onCancel, busy, inline = false }) {
  const ref = useRef(null);
  const open = !!gate;
  useEffect(() => {
    if (!open || !ref.current) return;
    if (inline) { ref.current.querySelector("[data-testid=gate-confirm]")?.focus({ preventScroll: true }); return; }
    ref.current.scrollIntoView({ block: "center" });
    ref.current.focus();
  }, [open, inline]);
  if (!gate) return null;
  return (
    <section ref={ref} tabIndex={-1} className={inline ? "gate-inline" : "card card--warn"} role="alertdialog" aria-labelledby="gate-title" data-testid="confirm-gate">
      <h2 id="gate-title" className={inline ? "gate-inline__title" : "card__title"}>Confirm before the first Real send</h2>
      <p>Real mode sends MCP requests that carry your agent key to this gateway:</p>
      <p><code data-testid="gate-gateway">{gate.gatewayOrigin}</code></p>
      {(() => {
        const reads = [["gate-k8s", gate.k8sOrigin, "the gateway pod log (kubectl proxy)"], ["gate-search", gate.searchOrigin, "the search endpoint"], ["gate-decisions", gate.decisionsOrigin, "the policy decision log (Privilege console)"]].filter(([, o]) => o);
        return <p>{reads.length ? <>and reads log entries from {reads.map(([id, o, what], i) => <span key={id}>{i ? "; " : ""}{what} at <code data-testid={id}>{o}</code></span>)}.</> : "No log source is configured: you will paste the gateway log lines yourself."} Only these origins are contacted. Redirects are never followed.</p>;
      })()}
      <div className="row">
        <button type="button" className="primary" onClick={onConfirm} disabled={busy} data-testid="gate-confirm">Send to {gate.gatewayOrigin}</button>
        <button type="button" onClick={onCancel} disabled={busy} data-testid="gate-cancel">Cancel</button>
      </div>
    </section>
  );
}
