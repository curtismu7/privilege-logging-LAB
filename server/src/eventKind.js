// Console or runtime: which kind of Privilege event a log entry is.
//   console : an admin change made in the Privilege console (who changed which object). Indices audit-log and event-log; in a SIEM index
//             (ping-siem-events) a console event has a top-level Module and a string Data.
//   runtime : something the gateway did with traffic (a call, a decision, a guardrail verdict, an approval hold, a proxy session).
// Read from Privilege's hosted indices through the console (index name decides), or from the gateway's own log (always runtime).
export const CONSOLE_INDICES = ['audit-log', 'event-log'];
export const RUNTIME_INDICES = ['policy-decision-log', 'aiguard-log', 'proxy-audit-log', 'agent-approval-log', 'proxy-event-log'];
export const PRIVILEGE_INDICES = [...RUNTIME_INDICES, ...CONSOLE_INDICES];

// What each sink holds when the whole sink is one kind (null: decided per entry).
export const SINK_KIND = { 'gateway-log': 'runtime', 'k8s-pod': 'runtime', response: 'runtime', opensearch: 'runtime', console: 'console', elasticsearch: 'console', 'privilege-hosted': null, search: null, pasted: null };

// One entry: by its index when known, else by the shape of a SIEM record (Module + string Data = console; object Data = runtime).
export function kindOf({ index = null, text = '' } = {}) {
  if (index && CONSOLE_INDICES.includes(index)) return 'console';
  if (index && RUNTIME_INDICES.includes(index)) return 'runtime';
  const t = String(text);
  if (t[0] !== '{') return 'unknown';
  let doc = null;
  try { doc = JSON.parse(t); } catch { return 'unknown'; }
  if (!doc || typeof doc !== 'object') return 'unknown';
  if (typeof doc.Module === 'string' && (typeof doc.Data === 'string' || doc.Data === undefined)) return 'console';
  if (doc.Data && typeof doc.Data === 'object') return 'runtime';
  return 'unknown';
}

// HOW an entry reached us: written by Privilege into Elasticsearch, or read by this lab from the gateway pod's own log file, etc.
export const SINK_CHANNEL = {
  'gateway-log': { channel: 'pod', label: 'Gateway pod log file (read with kubectl, not from Privilege)' },
  'k8s-pod': { channel: 'pod', label: 'Gateway pod log file (read with kubectl, not from Privilege)' },
  response: { channel: 'gateway', label: 'Gateway response header' },
  opensearch: { channel: 'sidecar', label: 'Our log-tailer sidecar -> OpenSearch (not from Privilege)' },
  console: { channel: 'privilege-console', label: 'Privilege console screens' },
  elasticsearch: { channel: 'privilege-es', label: 'Privilege -> Elasticsearch (SIEM export, ping-siem-events)' },
  'privilege-hosted': { channel: 'privilege-es', label: 'Privilege -> Elasticsearch (Privilege hosted, read through the console)' },
  search: { channel: 'search', label: 'Your search endpoint' },
  pasted: { channel: 'pasted', label: 'Pasted by you' },
};
