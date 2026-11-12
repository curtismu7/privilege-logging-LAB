import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import fs from "node:fs";
import ConfirmGate from "./components/ConfirmGate";
import DiagramPage from "./components/DiagramPage";
import RunPage from "./components/RunPage";
import ScorecardPage from "./components/ScorecardPage";
import ShelfLink from "./components/ShelfLink";
import SinksPage from "./components/SinksPage";
import TalkTrack from "./components/TalkTrack";
import TracePage from "./components/TracePage";
import PrivilegePage from "./components/PrivilegePage";
import Req9Page from "./components/Req9Page";
import { confirmGateway, fetchLog, getJson, resetWorkspace, runCase, setBearer, setMode } from "./api";
import { applyTheme, savedTheme } from "./theme";
import TopMenu, { applyFontSize } from "./top-menu/TopMenu.jsx";

const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version || null; } catch { return null; } })();

export const TABS = [
  { id: "run", label: "Run" },
  { id: "trace", label: "Trace" },
  { id: "privilege", label: "Privilege -> Elasticsearch" },
  { id: "req9", label: "Requirement 9" },
  { id: "scorecard", label: "Scorecard" },
  { id: "sinks", label: "Where it's logged" },
  { id: "diagram", label: "Diagram" },
  { id: "talk", label: "Talk track" },
];
const TITLES = { run: "Run a use case", trace: "Trace: what was sent and what was logged", privilege: "Privilege -> Elasticsearch: only what Privilege itself logged", req9: "Requirement 9: who called which tool, as whom, and what the policy said", scorecard: "Scorecard", sinks: "Where it's logged", diagram: "Flow diagrams", talk: "Talk track" };
// Never blank: until /api/story answers (or if it fails) the banner says the safe thing.
export const BANNER_UNKNOWN = "SIMULATED. Replay of transactions measured on 2026-11-07; nothing is sent.";
// /api/info failed: the page does not know the mode, so it must not claim Mock ("nothing is sent") or Real. Runs are disabled.
export const BANNER_MODE_UNKNOWN = "MODE UNKNOWN. The lab's mode could not be read (/api/info failed), so this page cannot say whether a Run is simulated or sent. Runs are disabled until it loads: press Retry.";

// #<tab>/<case-id>; the Requirement 9 tab takes #req9/<RequestID> (a stable deep link, Kibana links to it). The RequestID is kept
// as given (bounded) so the page can say when it is not a valid one; the page validates it before any use.
const parseHash = () => {
  const [tab, ...rest] = window.location.hash.replace("#", "").split("/");
  const id = rest.join("/");
  const t = TABS.some((x) => x.id === tab) ? tab : "run";
  if (t === "req9") { let rid = id; try { rid = decodeURIComponent(id); } catch { /* keep as typed */ } return { tab: t, caseId: null, rid: rid ? rid.slice(0, 200) : null }; }
  return { tab: t, caseId: /^[a-z0-9-]{1,48}$/.test(id || "") ? id : null };
};

export default function App() {
  const [info, setInfo] = useState(undefined); // undefined = loading, null = failed
  const [story, setStory] = useState(null);
  const [cases, setCases] = useState(null);
  const [sinkInfo, setSinkInfo] = useState(null);
  const [runs, setRuns] = useState({});
  const [error, setError] = useState(null);
  const [nav, setNav] = useState(parseHash());
  const [presenter, setPresenter] = useState(false);
  const [theme, setTheme] = useState(savedTheme());
  const [fontStep, setFontStep] = useState(() => { try { const f = localStorage.getItem("privlog.font"); return ["S", "M", "L"].includes(f) ? f : "M"; } catch { return "M"; } });
  useEffect(() => { applyFontSize(fontStep); try { localStorage.setItem("privlog.font", fontStep); } catch { /* blocked */ } }, [fontStep]);
  const [notice, setNotice] = useState("");
  const [running, setRunning] = useState(null);
  const [gate, setGate] = useState(null); // { gatewayOrigin, searchOrigin, queue }
  const [signal, setSignal] = useState(0);
  const [busy, setBusy] = useState({}); // caseId -> { phase: sending|fetching|timeout|unreachable|error, attempt, elapsedMs, maxMs, detail }
  const [focusReq, setFocusReq] = useState(null); // { target: "title" | a data-testid }: where focus goes once a run has finished
  const titleRef = useRef(null);
  const epoch = useRef(0); // bumped by Reset and by a mode switch: a polling loop that sees a newer epoch stops

  const loadInfo = useCallback(() => getJson("/api/info").then(setInfo, () => setInfo(null)), []);
  const loadRuns = useCallback(() => getJson("/api/runs").then((r) => setRuns(Object.fromEntries(r.runs.map((x) => [x.caseId, x]))), () => {}), []);
  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => {
    loadInfo(); loadRuns();
    Promise.all([getJson("/api/story"), getJson("/api/cases"), getJson("/api/sinks")]).then(([s, c, k]) => { setStory(s); setCases(c); setSinkInfo(k); setError(null); }, (e) => setError(e.message));
  }, [loadInfo, loadRuns]);
  useEffect(() => {
    const on = () => setNav((n) => { const p = parseHash(); if (n.tab === "run" && p.tab !== "run") runPos.current = { y: window.scrollY, caseId: null }; return p; });
    window.addEventListener("hashchange", on); window.addEventListener("popstate", on);
    return () => { window.removeEventListener("hashchange", on); window.removeEventListener("popstate", on); };
  }, []);
  useEffect(() => {
    const on = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+P / Cmd+P is print, not presenter mode
      if (e.key === "p" || e.key === "P") setPresenter((v) => !v);
      else if (e.key === "Escape") setPresenter(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // Each page change is a history entry, so the browser Back button returns to the Run page. Leaving Run remembers where it was
  // (scroll position and the case whose trace was opened); coming back puts that case card back in view.
  const runPos = useRef(null);
  const go = (tab, caseId = null) => {
    if (nav.tab === "run" && tab !== "run") runPos.current = { y: window.scrollY, caseId: tab === "trace" ? caseId : null };
    setNav(tab === "req9" ? { tab, caseId: null, rid: caseId } : { tab, caseId });
    const hash = `#${tab}${caseId ? `/${caseId}` : ""}`;
    try { if (window.location.hash !== hash) window.history.pushState(null, "", hash); } catch { /* ignore */ }
  };
  useLayoutEffect(() => {
    if (nav.tab !== "run" || !runPos.current || !cases) return;
    const { y, caseId } = runPos.current; runPos.current = null;
    const card = caseId && document.querySelector(`[data-testid="case-${caseId}"]`);
    if (card) { card.scrollIntoView?.({ block: "center" }); document.querySelector(`[data-testid="open-${caseId}"]`)?.focus({ preventScroll: true }); }
    else window.scrollTo?.(0, y);
  }, [nav.tab, cases]);
  const selected = nav.caseId && cases?.cases.some((c) => c.id === nav.caseId) ? nav.caseId : (cases?.cases[0]?.id ?? null);

  const setPhase = useCallback((id, p) => setBusy((b) => { const n = { ...b }; if (p) n[id] = p; else delete n[id]; return n; }), []);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const loadCases = useCallback(() => getJson("/api/cases").then(setCases, () => {}), []);

  // Phase 2: fetch the log entry. Repeats about once a second until the server says found, timeout, unreachable or not configured.
  // Returns "found" | "failed" | "stopped".
  const fetchLoop = useCallback(async (id, restart = false) => {
    const my = epoch.current;
    const interval = info?.retrieval?.intervalMs ?? 1000;
    let first = restart;
    for (let i = 0; i < 120; i += 1) {
      if (epoch.current !== my) return "stopped";
      const res = await fetchLog(id, first).catch(() => ({ ok: false, status: 0, body: {} }));
      first = false;
      if (epoch.current !== my) return "stopped";
      // fetchFailed: the call itself was sent (or replayed); only the log fetch failed, so Busy offers Retry (fetch again, no resend).
      if (!res.ok) { setPhase(id, { phase: "error", fetchFailed: true, detail: res.body?.detail || res.body?.error || "Could not fetch the log entry." }); return "failed"; }
      setRuns((r) => ({ ...r, [id]: res.body }));
      const rt = res.body.retrieval || {};
      if (rt.state === "pending") { setPhase(id, { phase: "fetching", attempt: rt.attempt, elapsedMs: rt.elapsedMs, maxMs: rt.maxMs ?? info?.retrieval?.maxMs, detail: rt.detail, simulated: !!rt.simulated }); await sleep(rt.simulated ? 0 : interval); continue; }
      if (rt.state === "found" || rt.state === "not_configured") { setPhase(id, null); return "found"; }
      setPhase(id, { phase: rt.state, detail: rt.detail, maxMs: rt.maxMs });
      return "failed";
    }
    setPhase(id, { phase: "timeout", detail: "Gave up waiting for the log entry." });
    return "failed";
  }, [info, setPhase]);

  // Run one case: phase 1 sends (Real) or looks up the recording (Mock), phase 2 fetches the log entry. Returns "ok" | "confirm" | "stop".
  const doRun = useCallback(async (id, extra = {}) => {
    setRunning(id); setNotice(""); setPhase(id, { phase: "sending" });
    try {
      const res = await runCase(id, extra);
      if (res.status === 412) { setPhase(id, null); setGate({ gatewayOrigin: res.body.gatewayOrigin, searchOrigin: res.body.searchOrigin, k8sOrigin: res.body.k8sOrigin, decisionsOrigin: res.body.decisionsOrigin, queue: [id] }); return "confirm"; }
      if (!res.ok) { setPhase(id, { phase: "error", detail: res.body.detail || res.body.error || "failed" }); return "stop"; }
      setRuns((r) => ({ ...r, [id]: res.body }));
      const rt = res.body.retrieval || {};
      if (rt.state === "pending") { setPhase(id, { phase: "fetching", attempt: 0, maxMs: info?.retrieval?.maxMs, detail: rt.detail, simulated: !!rt.simulated }); return (await fetchLoop(id)) === "found" ? "ok" : "stop"; }
      setPhase(id, null);
      return "ok";
    } catch { setPhase(id, { phase: "error", detail: "Could not reach the lab server." }); return "stop"; } finally { setRunning(null); }
  }, [fetchLoop, info, setPhase]);
  const retry = useCallback(async (id) => { setRunning(id); setPhase(id, { phase: "fetching", attempt: 0, maxMs: info?.retrieval?.maxMs, detail: "Retrying." }); try { await fetchLoop(id, true); } finally { setRunning(null); } }, [fetchLoop, info, setPhase]);

  // While a case runs every Run button is disabled, so the browser drops focus to <body>. When the run ends, focus goes to the
  // Trace heading (a run that opened its Trace) or back to the button that started it, so keyboard users keep their place.
  const runList = useCallback(async (ids, { openTrace = false, from = null } = {}) => {
    for (let i = 0; i < ids.length; i += 1) {
      const r = await doRun(ids[i]);
      if (r === "confirm") { setGate((g) => (g ? { ...g, queue: ids.slice(i), openTrace } : g)); return; }
      if (r === "ok" && openTrace && ids.length === 1) { go("trace", ids[0]); setFocusReq({ target: "title" }); return; }
    }
    setFocusReq({ target: from || (ids.length === 1 ? `run-${ids[0]}` : "run-all") });
  }, [doRun]); // eslint-disable-line react-hooks/exhaustive-deps

  // Run stays on the Run page: the result shows on the card and focus returns to its Run button (Open trace is a separate click).
  const onRun = (id) => runList([id]);
  const onLook = (id, sinceIso) => doRun(id, { since: sinceIso }).then(() => setFocusReq({ target: `run-${id}` }));
  const onRunAll = () => runList(cases.cases.filter((c) => (info?.source === "real" ? c.realRunnable && !c.consoleAction && (!c.needsBearer || c.bearerConfigured) : !c.realOnly)).map((c) => c.id), { from: "run-all" });
  useEffect(() => {
    if (!focusReq || running) return;
    const el = focusReq.target === "title" ? titleRef.current : document.querySelector(`[data-testid="${focusReq.target}"]`);
    const at = document.activeElement;
    // only when focus was lost (body, nothing, a disabled or removed control): never take focus from where the user moved it
    if (el && !el.disabled && (!at || at === document.body || at.disabled || !at.isConnected)) el.focus({ preventScroll: true });
    setFocusReq(null);
  }, [focusReq, running, nav]);
  // A single Run from the Run page confirms inside that case's card (no jump to the top of the page).
  const inlineGate = nav.tab === "run" && gate?.queue?.length === 1 ? gate.queue[0] : null;
  const onConfirm = async () => {
    const { queue, openTrace } = gate;
    const res = await confirmGateway(gate.gatewayOrigin);
    if (!res.ok) { setNotice(res.body.detail || "Could not confirm."); return; }
    setGate(null); await loadInfo(); setSignal((n) => n + 1);
    runList(queue, { openTrace });
  };
  const onBearer = async (id, value) => { const res = await setBearer(id, value); if (!res.ok) { setNotice(res.body.detail || "Could not set the credential."); return false; } await loadCases(); setNotice(value ? "Credential set for this case (write-only; it is never shown)." : "Credential cleared."); return true; };

  const reset = useCallback(async () => {
    const ok = await resetWorkspace().catch(() => false);
    epoch.current += 1; setBusy({}); setRuns({}); setGate(null); setSignal((n) => n + 1); loadInfo(); loadCases();
    setNotice(ok ? "Reset: this tab's runs, pasted lines and Real confirmation are cleared." : "Reset failed on the server; the view was reloaded.");
  }, [loadInfo]);

  // Refresh: stop any wait for a log entry, free the Run buttons and reload the data. Unlike Reset it keeps this tab's runs.
  const refresh = useCallback(async () => {
    epoch.current += 1; setRunning(null); setBusy({}); setGate(null);
    await Promise.all([loadInfo(), loadRuns(), loadCases()]);
    setSignal((n) => n + 1);
    setNotice("Refreshed: any wait for a log entry was stopped and the data reloaded. Your runs are kept.");
  }, [loadInfo, loadRuns, loadCases]);

  // Rule 19: switch server-side, then reload every panel's data (no page reload, no restart).
  const switchTo = async (source) => {
    if (info?.source === source) return;
    const res = await setMode(source).catch(() => ({ ok: false, body: {} }));
    if (!res.ok) { setNotice(res.body?.detail || "Could not switch mode."); return; }
    epoch.current += 1; setBusy({}); setGate(null);
    await Promise.all([loadInfo(), loadRuns(), loadCases()]);
    setSignal((n) => n + 1);
    setNotice(`Switched to ${source === "real" ? "Real" : "Mock"}: all data reloaded.`);
  };

  const real = info?.source === "real";
  const banner = info === null ? BANNER_MODE_UNKNOWN : story ? (real ? story.realBanner : story.banner) : BANNER_UNKNOWN;
  const realHint = info && !info.realAvailable && !real ? info.realHint || "Real is not configured. Mock keeps working." : "";
  const say = story && presenter && nav.tab !== "talk" ? story.talkTrack.filter((t) => (story.pageSays[nav.tab] || []).includes(t.id)) : [];

  return (
    <div className={`app${presenter ? " app--presenter" : ""}`}>
      <header className="shell-bar">
        <span className="shell-brand"><span className="shell-logo" aria-hidden="true">P</span> Privilege Logging Lab <span className="shell-badge" data-testid="mode">{info ? (real ? "Real" : "Mock") : info === null ? "Unknown" : "..."}</span></span>
        <nav className="shell-nav" aria-label="Pages">
          {TABS.map((t) => <a key={t.id} href={`#${t.id}`} aria-current={nav.tab === t.id ? "page" : undefined} onClick={(e) => { e.preventDefault(); go(t.id, t.id === "trace" ? selected : null); }} data-testid={`nav-${t.id}`}>{t.label}</a>)}
        </nav>
        <span className="shell-right">
          <TopMenu
            mode={{ value: real ? "real" : "mock", onChange: switchTo, realAvailable: info ? info.realAvailable : null, realHint: realHint || undefined }}
            theme={{ value: theme, onChange: setTheme }}
            fontSize={{ value: fontStep, onChange: setFontStep }}
            present={{ active: presenter, onToggle: () => setPresenter((v) => !v), label: "Presenter (P)" }}
            shelfUrl="https://local.ping-devops.com:8443/"
            help={{ href: "https://github.com/curtismu7/privilege-logging-LAB#readme" }}
            version={VERSION}
            onReset={reset}
          >
            {info === null && <button type="button" onClick={loadInfo} data-testid="mode-retry">Retry mode</button>}
            <button type="button" onClick={refresh} data-testid="refresh" title="Stop any wait for a log entry, free the Run buttons and reload the data. Your runs are kept.">Refresh</button>
            <ShelfLink />
          </TopMenu>
        </span>
      </header>
      <main className="page">
        <div className="banner" role="note" data-testid="banner" data-state={info === null ? "unknown" : real ? "live" : undefined}>{banner}</div>
        {/* A disabled Real button is skipped by Tab and shows no tooltip on touch, so its how-to is also on the page. */}
        {realHint && !presenter && <p className="muted" id="real-hint" data-testid="real-hint">Real is unavailable: {realHint}</p>}
        <h1 ref={titleRef} tabIndex={-1}>{TITLES[nav.tab]}</h1>
        {nav.tab === "trace" && <p><button type="button" onClick={() => go("run")} data-testid="back-to-run">← Back to Run</button></p>}
        {!presenter && story && nav.tab === "run" && <p className="intro">{story.intro}</p>}
        <p className="sr-only" role="status" aria-live="polite" data-testid="status">{notice}</p>
        {notice && !presenter && <p className="notice" data-testid="notice">{notice}</p>}
        {say.length > 0 && (
          <aside className="presenter-say" data-testid="presenter-say" aria-label="Talk track">
            {say.map((t) => <p key={t.id}><strong>{t.title}.</strong> {t.say}</p>)}
          </aside>
        )}
        {!inlineGate && <ConfirmGate gate={gate} onConfirm={onConfirm} onCancel={() => setGate(null)} busy={!!running} />}
        {error ? <p className="field-error" role="alert">Could not load the lab ({error}). Is the server running?</p> : !story || !cases || !sinkInfo ? <p className="muted">Loading...</p> : (
          <>
            {nav.tab === "run" && <RunPage cases={cases} runs={runs} info={info} running={running} busy={busy} gate={inlineGate ? gate : null} onConfirm={onConfirm} onCancelGate={() => setGate(null)} onRun={onRun} onLook={onLook} onRetry={retry} onBearer={onBearer} onRunAll={onRunAll} onOpen={(id) => go("trace", id)} />}
            {nav.tab === "privilege" && <PrivilegePage info={info} signal={signal} onConfirmNeeded={() => info?.real && setGate({ gatewayOrigin: info.real.gatewayOrigin, searchOrigin: info.real.searchOrigin, k8sOrigin: info.real.k8sOrigin, decisionsOrigin: info.real.decisionsOrigin, queue: [] })} />}
            {nav.tab === "req9" && <Req9Page info={info} signal={signal} rid={nav.rid || null} onSelect={(rid) => go("req9", rid)} onConfirmNeeded={() => info?.real && setGate({ gatewayOrigin: info.real.gatewayOrigin, searchOrigin: info.real.searchOrigin, k8sOrigin: info.real.k8sOrigin, decisionsOrigin: info.real.decisionsOrigin, queue: [] })} />}
            {nav.tab === "trace" && <TracePage cases={cases} runs={runs} sinkInfo={sinkInfo} info={info} caseId={selected} busy={busy} onSelect={(id) => go("trace", id)} onRun={(id) => runList([id], { from: "trace-run" })} onRetry={retry} onChanged={loadRuns} running={running} />}
            {nav.tab === "scorecard" && <ScorecardPage info={info} runsSignal={`${signal}:${Object.keys(runs).length}:${Object.values(runs).map((r) => `${r.ranAt}${r.scored}${r.logged.length}`).join("")}`} onOpen={(id) => go("trace", id)} />}
            {nav.tab === "sinks" && <SinksPage sinkInfo={sinkInfo} story={story} />}
            {nav.tab === "diagram" && <DiagramPage resetSignal={signal} />}
            {nav.tab === "talk" && <TalkTrack talk={story.talkTrack} />}
          </>
        )}
      </main>
    </div>
  );
}
