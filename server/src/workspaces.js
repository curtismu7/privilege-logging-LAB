// Per-visitor state keyed by a workspace id (X-Workspace), so one browser tab's runs and confirmation never touch another's.
// Per workspace: the last run of each case, and the Real-send confirmation. Bounded in count, size and age.
export const WORKSPACE_RE = /^[a-z0-9-]{1,40}$/;
export const DEFAULT_WORKSPACE = 'default';
export const MAX_CASES = 60;

export function workspaceFrom(req) {
  const raw = req.headers['x-workspace'];
  if (raw === undefined) return DEFAULT_WORKSPACE;
  return typeof raw === 'string' && WORKSPACE_RE.test(raw) ? raw : null;
}

export function createWorkspaces({ max = 500, ttlMs = 60 * 60 * 1000, now = Date.now } = {}) {
  const map = new Map(); // id -> { runs: Map('source:caseId' -> result), confirmed: string|null, at }
  const sweep = () => {
    const t = now();
    const expired = [...map.entries()].filter(([, v]) => t - v.at > ttlMs).sort((a, b) => a[1].at - b[1].at);
    for (const [id] of expired) map.delete(id);
    const byAge = [...map.entries()].sort((a, b) => a[1].at - b[1].at);
    while (map.size > max) { const [id] = byAge.shift(); map.delete(id); }
  };
  return {
    state(id) {
      sweep();
      let v = map.get(id);
      if (!v) { v = { runs: new Map(), confirmed: null, bearers: new Map(), at: now() }; map.set(id, v); }
      v.at = now();
      return v;
    },
    // Runs are kept per source: a Mock replay and a Real run of the same case never overwrite or show up in each other's views.
    putRun(id, result) { const v = this.state(id); v.runs.set(`${result.source}:${result.caseId}`, result); while (v.runs.size > 2 * MAX_CASES) v.runs.delete(v.runs.keys().next().value); },
    getRun(id, source, caseId) { return this.state(id).runs.get(`${source}:${caseId}`); },
    listRuns(id, source) { return [...this.state(id).runs.values()].filter((r) => r.source === source); },
    resetWorkspace(id) { map.delete(id); },
    size() { return map.size; },
  };
}
