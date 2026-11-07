import { useCallback, useEffect, useState } from "react";
import ConfirmGate from "./components/ConfirmGate";
import DiagramPage from "./components/DiagramPage";
import RunPage from "./components/RunPage";
import ScorecardPage from "./components/ScorecardPage";
import ShelfLink from "./components/ShelfLink";
import SinksPage from "./components/SinksPage";
import TalkTrack from "./components/TalkTrack";
import TracePage from "./components/TracePage";
import { confirmGateway, getJson, resetWorkspace, runCase, setMode } from "./api";
import { THEMES, applyTheme, savedTheme } from "./theme";

export const TABS = [
  { id: "run", label: "Run" },
  { id: "trace", label: "Trace" },
  { id: "scorecard", label: "Scorecard" },
  { id: "sinks", label: "Where it's logged" },
  { id: "diagram", label: "Diagram" },
  { id: "talk", label: "Talk track" },
];
const TITLES = { run: "Run a use case", trace: "Trace: what was sent and what was logged", scorecard: "Scorecard", sinks: "Where it's logged", diagram: "Flow diagrams", talk: "Talk track" };
// Never blank: until /api/story answers (or if it fails) the banner says the safe thing.
export const BANNER_UNKNOWN = "SIMULATED. Replay of transactions measured on 2026-11-07; nothing is sent.";

const parseHash = () => {
  const [tab, id] = window.location.hash.replace("#", "").split("/");
  return { tab: TABS.some((t) => t.id === tab) ? tab : "run", caseId: /^[a-z0-9-]{1,48}$/.test(id || "") ? id : null };
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
  const [notice, setNotice] = useState("");
  const [running, setRunning] = useState(null);
  const [gate, setGate] = useState(null); // { gatewayOrigin, searchOrigin, queue }
  const [signal, setSignal] = useState(0);

  const loadInfo = useCallback(() => getJson("/api/info").then(setInfo, () => setInfo(null)), []);
  const loadRuns = useCallback(() => getJson("/api/runs").then((r) => setRuns(Object.fromEntries(r.runs.map((x) => [x.caseId, x]))), () => {}), []);
  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => {
    loadInfo(); loadRuns();
    Promise.all([getJson("/api/story"), getJson("/api/cases"), getJson("/api/sinks")]).then(([s, c, k]) => { setStory(s); setCases(c); setSinkInfo(k); setError(null); }, (e) => setError(e.message));
  }, [loadInfo, loadRuns]);
  useEffect(() => {
    const on = () => setNav(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    const on = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "p" || e.key === "P") setPresenter((v) => !v);
      else if (e.key === "Escape") setPresenter(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const go = (tab, caseId = null) => { setNav({ tab, caseId }); try { window.history.replaceState(null, "", `#${tab}${caseId ? `/${caseId}` : ""}`); } catch { /* ignore */ } };
  const selected = nav.caseId && cases?.cases.some((c) => c.id === nav.caseId) ? nav.caseId : (cases?.cases[0]?.id ?? null);

  // Run one case. Returns "ok", "confirm" (the confirm gate was raised), or "stop" (an error was shown).
  const doRun = useCallback(async (id) => {
    setRunning(id); setNotice("");
    try {
      const res = await runCase(id);
      if (res.status === 412) { setGate({ gatewayOrigin: res.body.gatewayOrigin, searchOrigin: res.body.searchOrigin, queue: [id] }); return "confirm"; }
      if (!res.ok) { setNotice(`${id}: ${res.body.detail || res.body.error || "failed"}`); if (res.body.hops?.length) setRuns((r) => ({ ...r })); return "stop"; }
      setRuns((r) => ({ ...r, [id]: res.body }));
      return "ok";
    } catch { setNotice("Could not reach the lab server."); return "stop"; } finally { setRunning(null); }
  }, []);
  const runList = useCallback(async (ids) => {
    for (let i = 0; i < ids.length; i += 1) {
      const r = await doRun(ids[i]);
      if (r === "confirm") { setGate((g) => (g ? { ...g, queue: ids.slice(i) } : g)); return; }
    }
  }, [doRun]);

  const onRun = (id) => runList([id]);
  const onRunAll = () => runList(cases.cases.filter((c) => info?.source !== "real" || c.realRunnable).map((c) => c.id));
  const onConfirm = async () => {
    const queue = gate.queue;
    const res = await confirmGateway(gate.gatewayOrigin);
    if (!res.ok) { setNotice(res.body.detail || "Could not confirm."); return; }
    setGate(null); await loadInfo();
    runList(queue);
  };

  const reset = useCallback(async () => {
    const ok = await resetWorkspace().catch(() => false);
    setRuns({}); setGate(null); setSignal((n) => n + 1); loadInfo();
    setNotice(ok ? "Reset: this tab's runs, pasted lines and Real confirmation are cleared." : "Reset failed on the server; the view was reloaded.");
  }, [loadInfo]);

  // Rule 19: switch server-side, then reload every panel's data (no page reload, no restart).
  const switchTo = async (source) => {
    if (info?.source === source) return;
    const res = await setMode(source).catch(() => ({ ok: false, body: {} }));
    if (!res.ok) { setNotice(res.body?.detail || "Could not switch mode."); return; }
    setGate(null);
    await Promise.all([loadInfo(), loadRuns()]);
    setSignal((n) => n + 1);
    setNotice(`Switched to ${source === "real" ? "Real" : "Mock"}: all data reloaded.`);
  };

  const real = info?.source === "real";
  const banner = story ? (real ? story.realBanner : story.banner) : BANNER_UNKNOWN;
  const say = story && presenter && nav.tab !== "talk" ? story.talkTrack.filter((t) => (story.pageSays[nav.tab] || []).includes(t.id)) : [];

  return (
    <div className={`app${presenter ? " app--presenter" : ""}`}>
      <header className="shell-bar">
        <span className="shell-brand"><span className="shell-logo" aria-hidden="true">P</span> Privilege Logging Lab <span className="shell-badge" data-testid="mode">{info ? (real ? "Real" : "Mock") : "..."}</span></span>
        <nav className="shell-nav" aria-label="Pages">
          {TABS.map((t) => <a key={t.id} href={`#${t.id}`} aria-current={nav.tab === t.id ? "page" : undefined} onClick={(e) => { e.preventDefault(); go(t.id, t.id === "trace" ? selected : null); }} data-testid={`nav-${t.id}`}>{t.label}</a>)}
        </nav>
        <span className="shell-right">
          {info && (
            <span className="seg" role="group" aria-label="Data source" data-testid="mode-toggle">
              <button type="button" aria-pressed={!real} data-testid="mode-mock" onClick={() => switchTo("mock")}>Mock</button>
              <button type="button" aria-pressed={real} data-testid="mode-real" disabled={!info.realAvailable && !real}
                title={info.realAvailable ? "Send to your configured gateway and read the log back (owner-run)" : info.realHint || "Real is not configured. Mock keeps working."}
                onClick={() => switchTo("real")}>Real</button>
            </span>
          )}
          <button type="button" onClick={reset} data-testid="reset">Reset</button>
          <button type="button" aria-pressed={presenter} onClick={() => setPresenter((v) => !v)} data-testid="presenter">{presenter ? "Exit presenter (Esc)" : "Presenter (P)"}</button>
          <label className="shell-theme">Theme
            <select value={theme} onChange={(e) => setTheme(e.target.value)} data-testid="theme" aria-label="Theme">
              {THEMES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <ShelfLink />
        </span>
      </header>
      <main className="page">
        <div className="banner" role="note" data-testid="banner" data-state={real ? "live" : undefined}>{banner}</div>
        <h1>{TITLES[nav.tab]}</h1>
        {!presenter && story && nav.tab === "run" && <p className="intro">{story.intro}</p>}
        <p className="sr-only" role="status" aria-live="polite" data-testid="status">{notice}</p>
        {notice && !presenter && <p className="notice" data-testid="notice">{notice}</p>}
        {say.length > 0 && (
          <aside className="presenter-say" data-testid="presenter-say" aria-label="Talk track">
            {say.map((t) => <p key={t.id}><strong>{t.title}.</strong> {t.say}</p>)}
          </aside>
        )}
        <ConfirmGate gate={gate} onConfirm={onConfirm} onCancel={() => setGate(null)} busy={!!running} />
        {error ? <p className="field-error" role="alert">Could not load the lab ({error}). Is the server running?</p> : !story || !cases || !sinkInfo ? <p className="muted">Loading...</p> : (
          <>
            {nav.tab === "run" && <RunPage cases={cases} runs={runs} info={info} running={running} onRun={onRun} onRunAll={onRunAll} onOpen={(id) => go("trace", id)} />}
            {nav.tab === "trace" && <TracePage cases={cases} runs={runs} sinkInfo={sinkInfo} info={info} caseId={selected} onSelect={(id) => go("trace", id)} onRun={onRun} onChanged={loadRuns} running={running} />}
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
