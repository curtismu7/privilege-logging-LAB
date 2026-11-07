// Copy text: the async clipboard when the page may use it, else a temporary textarea. Resolves true when something was copied.
export async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  try {
    const area = document.createElement("textarea");
    area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch { return false; }
}

// A second, client-side pass over text that is about to be copied. The server already redacts every line it serves; this only
// catches anything pasted into the page since. Same linear, anchored patterns as server/src/redact.js.
const PATTERNS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{0,}/g, "***jwt***"],
  [/\b(authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd)(["']?\s*[:=]\s*["']?)(?!Bearer\b)[^\s"',}&]{4,}/gi, "$1$2***"],
];
export function redactText(text) {
  let t = String(text);
  for (const [re, to] of PATTERNS) t = t.replace(re, to);
  return t;
}
