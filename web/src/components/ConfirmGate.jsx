import { useEffect, useRef } from "react";

// The confirm gate before the first Real send (per browser tab). Names the origins; nothing is sent until the button is pressed.
// It renders at the top of the page, so when it opens it is scrolled into view and takes focus: a Run pressed far down the page
// must not look like it did nothing.
export default function ConfirmGate({ gate, onConfirm, onCancel, busy }) {
  const ref = useRef(null);
  const open = !!gate;
  useEffect(() => {
    if (!open || !ref.current) return;
    ref.current.scrollIntoView({ block: "center" });
    ref.current.focus();
  }, [open]);
  if (!gate) return null;
  return (
    <section ref={ref} tabIndex={-1} className="card card--warn" role="alertdialog" aria-labelledby="gate-title" data-testid="confirm-gate">
      <h2 id="gate-title" className="card__title">Confirm before the first Real send</h2>
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
