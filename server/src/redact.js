// Redaction for log lines that are shown. A log line is untrusted data and may carry a bearer token, a JWT, an API key or a password.
// Every pattern is anchored on a literal prefix and uses single bounded character classes (no nested quantifiers), so it runs in linear
// time on a line already capped at 4096 characters. The agent key itself is also masked by the Real client (realClient.js redact()).
const PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{0,}/g, '***jwt***'],
  // Provider and Privilege virtual keys (sk-orion-..., sk-ant-..., sk-proj-...): Privilege's own logs carry them in full (aiguard-log
  // VirtualKeyID, and an agent save in audit-log carries the provider RealKey). Keep the first 8 and last 4 characters only.
  [/\bsk-[A-Za-z0-9_-]{8,}/g, (m) => `${m.slice(0, 8)}***${m.slice(-4)}`],
  [/\b(authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd)(["']?\s*[:=]\s*["']?)(?!Bearer\b)[^\s"',}&]{4,}/gi, '$1$2***'],
];

export function redactLine(text) {
  let t = String(text).slice(0, 4096);
  for (const [re, to] of PATTERNS) t = t.replace(re, to);
  return t;
}
