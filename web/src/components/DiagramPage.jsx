import { useEffect, useState } from "react";
import PatternDiagram from "./PatternDiagram";
import { getJson } from "../api";

const SHORT = { mcp: "MCP", "ai-guard": "AI Guard", rejected: "Rejected", aggregate: "Aggregate", a2a: "A2A", llm: "LLM", intent: "Intent" };

export default function DiagramPage({ resetSignal }) {
  const [name, setName] = useState("mcp");
  const [pattern, setPattern] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { setPattern(null); getJson(`/api/diagram?name=${encodeURIComponent(name)}`).then(setPattern, (e) => setError(e.message)); }, [name]);
  return (
    <div data-testid="diagram-page">
      <div className="row" role="group" aria-label="Flow">
        {(pattern?.names || Object.keys(SHORT)).map((n) => <button key={n} type="button" aria-pressed={n === name} onClick={() => setName(n)} data-testid={`flow-${n}`}>{SHORT[n] || n}</button>)}
      </div>
      {error ? <p className="field-error" role="alert">Could not load the diagram ({error}).</p> : !pattern ? <p className="muted">Loading...</p> : <PatternDiagram key={name} pattern={pattern} resetSignal={resetSignal} />}
    </div>
  );
}
