import { Chip } from "./Chips";

export default function SinksPage({ sinkInfo, story }) {
  if (!sinkInfo || !story) return <p className="muted">Loading...</p>;
  const cannot = story.facts.filter((f) => f.status !== "measured");
  return (
    <div data-testid="sinks-page">
      <section className="card card--neutral" aria-labelledby="req-title">
        <h2 id="req-title" className="card__title">The requirement</h2>
        <p>The gateway provides an end-to-end audit trail for all MCP interactions. The audit trail should clearly emit:</p>
        <ol className="req">{sinkInfo.requirement.map((r) => <li key={r}>{r.replace(/^[a-d]\.\s*/i, "")}</li>)}</ol>
      </section>
      <h2 className="section-label">Where it could be logged: five sinks</h2>
      <div className="card-grid">
        {sinkInfo.sinks.map((s) => {
          const u = sinkInfo.usage[s.id];
          return (
            <article key={s.id} className="card" data-testid={`sink-card-${s.id}`}>
              <h3 className="card__title">{s.name}</h3>
              <p>{s.summary}</p>
              <p>
                {s.unverified ? <Chip kind="warn">UNVERIFIED</Chip> : u.casesWithLines ? <Chip kind="ok">held lines for {u.casesWithLines} of {u.totalCases} cases</Chip> : <Chip kind="danger">held nothing in any case read</Chip>}
                {" "}<span className="muted">read for {u.casesRead} of {u.totalCases} cases, {u.lines} line{u.lines === 1 ? "" : "s"} in all</span>
              </p>
            </article>
          );
        })}
      </div>
      <h2 className="section-label">What we cannot see</h2>
      <section className="card card--warn" aria-labelledby="cannot-title" data-testid="cannot-see">
        <h3 id="cannot-title" className="card__title">Not measured, or our reading rather than a measurement</h3>
        <ul>
          {cannot.map((f) => <li key={f.id}><Chip kind={f.status === "UNVERIFIED" ? "warn" : "info"}>{f.status}</Chip> {f.text}</li>)}
          <li><Chip kind="warn">UNVERIFIED</Chip> Anything about a gateway build, configuration or time other than the {sinkInfo.capturedOn} capture.</li>
          <li><Chip kind="warn">UNVERIFIED</Chip> Whether an event shipped later than the moment of the read-back appears in OpenSearch or Elasticsearch.</li>
        </ul>
      </section>
    </div>
  );
}
