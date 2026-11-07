// The confirm gate before the first Real send (per browser tab). Names the origins; nothing is sent until the button is pressed.
export default function ConfirmGate({ gate, onConfirm, onCancel, busy }) {
  if (!gate) return null;
  return (
    <section className="card card--warn" role="alertdialog" aria-labelledby="gate-title" data-testid="confirm-gate">
      <h2 id="gate-title" className="card__title">Confirm before the first Real send</h2>
      <p>Real mode sends MCP requests that carry your agent key to this gateway:</p>
      <p><code data-testid="gate-gateway">{gate.gatewayOrigin}</code></p>
      <p>{gate.searchOrigin ? <>and reads log events from <code data-testid="gate-search">{gate.searchOrigin}</code>.</> : "No search URL is configured: you will paste the gateway log lines yourself."} Only these origins are contacted. Redirects are never followed.</p>
      <div className="row">
        <button type="button" className="primary" onClick={onConfirm} disabled={busy} data-testid="gate-confirm">Send to {gate.gatewayOrigin}</button>
        <button type="button" onClick={onCancel} disabled={busy} data-testid="gate-cancel">Cancel</button>
      </div>
    </section>
  );
}
