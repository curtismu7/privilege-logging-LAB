import { LEVEL_CLASS, LEVEL_LABEL } from "../lib/marks";

// A status chip always carries its word: colour is never the only signal.
export function LevelChip({ level, label }) {
  const key = level || "none";
  return <span className={`chip ${LEVEL_CLASS[level] || "chip--neutral"}`} data-level={key}><span className="dot" aria-hidden="true" />{label ?? LEVEL_LABEL[level] ?? "not run"}</span>;
}

export function Chip({ kind = "info", children, testId }) {
  return <span className={`chip chip--${kind}`} data-testid={testId}><span className="dot" aria-hidden="true" />{children}</span>;
}
