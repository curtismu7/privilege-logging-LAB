import { workspaceFetch } from "./workspace";

export async function getJson(url) {
  const r = await workspaceFetch(url, { method: "GET" });
  if (!r.ok) {
    let detail = "";
    try { const b = await r.json(); detail = b.detail || b.error || ""; } catch { /* not JSON */ }
    const e = new Error(detail ? `${detail}` : `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

// A write that answers with data on 2xx and on 4xx alike: the caller decides what a 409 or a 412 means.
export async function postJson(url, payload) {
  const r = await workspaceFetch(url, { method: "POST", body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

// POST /api/mode: the rule 19 Mock/Real toggle. 409 when Real is not configured.
export const setMode = (source) => postJson("/api/mode", { source });
export const runCase = (caseId, extra = {}) => postJson("/api/run", { caseId, ...extra });
export const fetchLog = (caseId, restart = false) => postJson("/api/fetch-log", restart ? { caseId, restart: true } : { caseId });
// A write-only credential for one case: the answer says whether one is set, never what it is.
export const setBearer = (caseId, bearer) => postJson("/api/bearer", { caseId, bearer });
export const confirmGateway = (gateway) => postJson("/api/confirm", { gateway });
export const scorePaste = (text, caseId) => postJson("/api/score", caseId ? { text, caseId } : { text });
export const resetWorkspace = () => workspaceFetch("/api/reset", { method: "POST", body: "{}" }).then((r) => r.ok);
