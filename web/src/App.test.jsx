import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import http from "node:http";
import App from "./App";
import { segments, fieldsOf } from "./lib/marks";
import { visible } from "./safeText";
import { KEY, startLab } from "./testServer";

let lab;
afterEach(async () => { cleanup(); await lab?.close(); window.location.hash = ""; try { window.sessionStorage.clear(); } catch { /* ignore */ } });
beforeEach(() => { window.location.hash = ""; });

describe("lib", () => {
  it("segments: marks become ordered pieces; bad, overlapping and out-of-range marks are dropped", () => {
    const line = "user: abc, tool: xyz";
    const parts = segments(line, [{ field: "tool", start: 17, end: 20 }, { field: "user", start: 6, end: 9 }, { field: "x", start: 7, end: 8 }, { field: "y", start: -1, end: 3 }, { field: "z", start: 5, end: 999 }]);
    expect(parts.map((p) => p.text).join("")).toBe(line);
    expect(parts.filter((p) => p.mark).map((p) => p.mark.field)).toEqual(["user", "tool"]);
    expect(fieldsOf([{ field: "user", level: "partial" }, { field: "user", level: "met" }])).toEqual([{ field: "user", level: "met" }]);
  });
  it("visible: control and bidirectional characters become visible escapes", () => {
    expect(visible("a\u202eb\u0000c")).toBe("a\\u202eb\\u0000c");
  });
});

describe("Mock mode", () => {
  it("shows the replay banner on every page, the toggle with Real disabled and a how-to tooltip, and replays a case with marked lines", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByTestId("banner").textContent).toMatch(/Replay of transactions measured on 2026-11-07; nothing is sent\./);
    await screen.findByTestId("run-page");
    expect(screen.getByTestId("mode-mock")).toHaveAttribute("aria-pressed", "true");
    const real = screen.getByTestId("mode-real");
    expect(real).toBeDisabled();
    expect(real.getAttribute("title")).toMatch(/PRIV_LOG_GATEWAY_URL/);
    for (const tab of ["trace", "privilege", "req9", "scorecard", "sinks", "diagram", "talk", "run"]) {
      await user.click(screen.getByTestId(`nav-${tab}`));
      expect(screen.getByTestId("banner").textContent).toMatch(/nothing is sent/);
    }
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("run-mcp-allowed-key"));
    await openTrace(user, "mcp-allowed-key");
    const lines = await screen.findByTestId("lines-gateway-log", {}, { timeout: 5000 });
    const marked = [...lines.querySelectorAll("mark")].map((m) => [m.getAttribute("data-field"), m.textContent]);
    expect(marked).toContainEqual(["tool", "get_weather"]);
    expect(marked).toContainEqual(["agent", "audit-test"]);
    expect(marked.some(([f]) => f === "decision")).toBe(true);
    expect(screen.getByTestId("trace-source").textContent).toMatch(/MOCK replay of 2026-11-07/);
    expect(screen.getByTestId("score").textContent).toMatch(/partial/);
    expect(screen.getByTestId("not-read").textContent).toMatch(/Audit-Trail header/);
    expect(screen.getByTestId("retrieval").textContent).toMatch(/recording/);
    expect(screen.getAllByTestId("entry-method")[0].textContent).toBe("recorded sample");
    expect(screen.getByTestId("not-present").textContent).toMatch(/All four requirement fields appear in this entry/);
  });

  it("Run all replays every case; the scorecard shows 17 rows with chips and copies a Markdown table", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    let clipboard = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { clipboard = t; } } });
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("run-all"));
    await waitFor(() => expect(screen.getByTestId("open-intent-encoder-unreachable")).toBeInTheDocument(), { timeout: 8000 });
    await waitFor(() => expect(screen.getByTestId("run-all")).not.toBeDisabled(), { timeout: 4000 }); // the last run has finished, so nothing updates after teardown
    await user.click(screen.getByTestId("nav-scorecard"));
    const table = await screen.findByTestId("scorecard-table");
    expect(table.querySelectorAll("tbody tr[data-testid^=row-]").length).toBe(34); // 17 measured + 17 not measured yet
    expect(within(screen.getByTestId("row-mcp-allowed-key")).getAllByText(/met|partial/).length).toBeGreaterThanOrEqual(4);
    expect(within(screen.getByTestId("row-llm-allowed")).getAllByText("missing").length).toBe(3);
    await user.click(screen.getByTestId("copy-md"));
    expect(clipboard).toMatch(/^Measured on 2026-11-07/);
    expect(clipboard.split("\n").filter((l) => l.startsWith("| ")).length).toBe(36);
    expect(screen.getByTestId("copy-status").textContent).toMatch(/Copied/);
  }, 15_000); // 17 replays through the full UI: about 4 s on a loaded machine, so above the 5 s default

  it("the paste box scores lines with the same scorer and renders hostile text inert", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("nav-trace"));
    const box = await screen.findByTestId("paste-box");
    await user.click(box);
    await user.paste('Access token found for user: <img src=x onerror=alert(1)>, client: audit-test\nMCP call detected for method tools with target: t\u202egnp.\nnoise \u202e rtl text');
    await user.click(screen.getByTestId("paste-score"));
    const res = await screen.findByTestId("paste-result");
    expect(res.querySelector("img")).toBeNull();
    await user.click(within(res).getByTestId("entry-0-raw"));
    expect(within(res).getByTestId("entry-0-rawtext").textContent).toContain("<img src=x onerror=alert(1)>");
    expect(res.querySelector("img")).toBeNull();
    expect(res.textContent.split("\\u202e").length - 1).toBeGreaterThanOrEqual(2);
    expect(within(res).getAllByText("met").length).toBeGreaterThanOrEqual(3);
  });

  it("the Trace use-case dropdown is grouped into Happy path and Failures, with every case in exactly one", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("nav-trace"));
    const select = await screen.findByTestId("trace-case");
    const groups = [...select.querySelectorAll("optgroup")];
    expect(groups.map((g) => g.label)).toEqual(["Happy path", "Failures"]);
    const happy = [...groups[0].querySelectorAll("option")].map((o) => o.textContent);
    const failures = [...groups[1].querySelectorAll("option")].map((o) => o.textContent);
    expect(happy.some((t) => /Allowed tool call, agent key/.test(t))).toBe(true);
    expect(failures.some((t) => /Tool call refused/.test(t))).toBe(true);
    expect(happy.some((t) => /refused|blocked|Rejected|No credential/i.test(t))).toBe(false);
    expect(select.querySelectorAll("option").length).toBe(happy.length + failures.length);
  });

  it("the Privilege -> Elasticsearch tab shows only Privilege's own log entries, each labelled with its index and runtime/console", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("nav-privilege"));
    await screen.findByTestId("privilege-page");
    expect(screen.getByTestId("privilege-channel").textContent).toMatch(/Nothing on this page comes from the gateway pod log/);
    await screen.findByTestId("priv-table");
    expect(screen.getByTestId("priv-mock-label").textContent).toMatch(/recorded shapes, placeholder values/);
    await user.click(screen.getByTestId("priv-view-json"));
    const lines = await screen.findByTestId("priv-lines");
    const kinds = within(lines).getAllByTestId("entry-kind");
    expect(kinds).toHaveLength(8);
    expect(kinds.filter((k) => /runtime event/.test(k.textContent))).toHaveLength(7);
    expect(within(lines).getAllByTestId("entry-from")[0].textContent).toMatch(/Privilege -> Elasticsearch · /);
    await user.selectOptions(screen.getByTestId("priv-index"), "aiguard-log");
    await user.selectOptions(screen.getByTestId("priv-kind"), "console");
    expect(await screen.findByTestId("priv-empty")).toBeInTheDocument();
    expect(screen.getByTestId("banner").textContent).toMatch(/nothing is sent/);
  });

  it("Refresh reloads the data and keeps this tab's runs (unlike Reset)", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("run-no-credential"));
    await screen.findByTestId("open-no-credential", {}, { timeout: 5000 });
    await user.click(screen.getByTestId("refresh"));
    await waitFor(() => expect(screen.getByTestId("notice").textContent).toMatch(/Refreshed: any wait for a log entry was stopped/));
    expect(screen.getByTestId("open-no-credential")).toBeInTheDocument();
    expect(screen.getByTestId("run-no-credential")).not.toBeDisabled();
  });

  it("Run page: every case card carries tags and the open tag panel filters the cards (empty sections hide); Clear restores", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    const page = await screen.findByTestId("run-page");
    const panel = within(screen.getByTestId("case-tag-filter"));
    const total = within(page).getAllByTestId(/^case-/).filter((el) => el.tagName === "ARTICLE").length;
    expect(panel.getByTestId("tag-filter")).toBeInTheDocument(); // open from the start, not behind a toggle
    expect(panel.getByTestId("tag-filter-count").textContent).toBe(`${total} of ${total} shown`);
    expect(within(screen.getByTestId("case-fed-valid-token")).getAllByTestId("entry-tag").map((t) => t.getAttribute("data-tag"))).toEqual(expect.arrayContaining(["area:Federated identity", "expect:allowed", "credential:lab-minted token"]));
    const chip = (id) => panel.getAllByTestId("filter-tag").find((b) => b.getAttribute("data-tag") === id);
    await user.click(chip("area:Federated identity"));
    expect(panel.getByTestId("tag-filter-count").textContent).toBe(`5 of ${total} shown`);
    expect(screen.queryByTestId("case-mcp-allowed-key")).toBeNull();
    expect(screen.queryByRole("heading", { name: "MCP" })).toBeNull();
    await user.click(chip("expect:allowed"));
    expect(panel.getByTestId("tag-filter-count").textContent).toBe(`1 of ${total} shown`);
    expect(screen.getByTestId("case-fed-valid-token")).toBeInTheDocument();
    await user.click(panel.getByTestId("tag-filter-clear"));
    expect(panel.getByTestId("tag-filter-count").textContent).toBe(`${total} of ${total} shown`);
  });

  it("from an opened Trace, Back to Run and the browser Back button both return to the Run page with that case's Open trace focused", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("run-mcp-allowed-key"));
    await openTrace(user, "mcp-allowed-key");
    await screen.findByTestId("trace-page");
    await user.click(screen.getByTestId("back-to-run"));
    await screen.findByTestId("run-page");
    await waitFor(() => expect(screen.getByTestId("open-mcp-allowed-key")).toHaveFocus());
    await user.click(screen.getByTestId("open-mcp-allowed-key"));
    await screen.findByTestId("trace-page");
    expect(window.location.hash).toBe("#trace/mcp-allowed-key");
    window.history.back();
    await screen.findByTestId("run-page", {}, { timeout: 3000 });
    await waitFor(() => expect(screen.getByTestId("open-mcp-allowed-key")).toHaveFocus());
  });

  it("Trace: every entry carries tags, and clicking tags filters the entries (any within a group, all across groups); Clear restores", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("run-mcp-allowed-key"));
    await openTrace(user, "mcp-allowed-key");
    const sink = await screen.findByTestId("lines-gateway-log", {}, { timeout: 5000 });
    const items = () => within(sink).queryAllByTestId("entry-item");
    expect(items()).toHaveLength(3);
    expect(within(items()[0]).getAllByTestId("entry-tag").map((t) => t.getAttribute("data-tag"))).toEqual(expect.arrayContaining(["type:auth", "match:recorded sample", "identity:key audit-test"]));
    const first = within(items()[0]);
    expect(first.getAllByTestId("entry-tag")).toHaveLength(6); // at most six pills, then "+N more", like tags on a shelf box
    await user.click(first.getByTestId("entry-tags-more"));
    expect(first.getAllByTestId("entry-tag").length).toBeGreaterThan(6);
    expect(first.queryByTestId("entry-tags-more")).toBeNull();
    // like the Demo Shelf: collapsed behind "Filter by tag" with "X of Y shown"; counts say what each tag would leave
    expect(within(sink).getByTestId("tag-filter-count").textContent).toBe("3 of 3 shown");
    await user.click(within(sink).getByTestId("tag-filter-open"));
    const filterTag = (id) => within(sink).getAllByTestId("filter-tag").find((b) => b.getAttribute("data-tag") === id);
    expect(filterTag("type:auth").textContent).toBe("auth 1");
    await user.click(filterTag("type:auth"));
    expect(items()).toHaveLength(1);
    expect(filterTag("type:auth")).toHaveAttribute("aria-pressed", "true");
    expect(within(sink).getByTestId("tag-filter-count").textContent).toBe("1 of 3 shown");
    expect(within(items()[0]).getAllByTestId("entry-tag").find((b) => b.getAttribute("data-tag") === "type:auth")).toHaveAttribute("aria-pressed", "true");
    await user.click(filterTag("type:policy"));
    expect(items()).toHaveLength(2);
    expect(filterTag("identity:key audit-test")).not.toBeDisabled();
    await user.click(filterTag("identity:key audit-test"));
    expect(items()).toHaveLength(1);
    expect(filterTag("type:policy").textContent).toBe("policy 0"); // with the key picked, policy alone would leave nothing
    await user.click(within(sink).getByTestId("tag-filter-clear"));
    expect(items()).toHaveLength(3);
    await user.click(within(sink).getByTestId("tag-filter-hide"));
    expect(within(sink).getByTestId("tag-filter-open")).toBeInTheDocument();
  });

  it("Trace says where every log entry came from: a recorded sample names its sink and date, and each entry carries a from chip", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("run-mcp-allowed-key"));
    await openTrace(user, "mcp-allowed-key");
    const origin = await screen.findByTestId("origin-gateway-log");
    expect(origin.textContent).toMatch(/Recorded sample/);
    expect(origin.textContent).toMatch(/Gateway pod log \(cyonproxy\.log\)/);
    expect(origin.textContent).toMatch(/recorded 2026-11-07/);
    const from = within(screen.getByTestId("sink-gateway-log")).getAllByTestId("entry-from");
    expect(from[0].textContent).toMatch(/from: Gateway pod log/);
    expect(screen.getByTestId("kind-legend").textContent).toMatch(/Runtime event.*Console event/);
    expect(within(screen.getByTestId("sink-gateway-log")).getAllByTestId("entry-kind").every((k) => /runtime event/.test(k.textContent))).toBe(true);
  });

  it("Reset clears this tab's runs; the diagram page offers one diagram per flow with Simulate and Reset", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("run-no-credential"));
    await screen.findByTestId("open-no-credential", {}, { timeout: 5000 });
    await user.click(screen.getByTestId("reset"));
    await waitFor(() => expect(screen.queryByTestId("open-no-credential")).toBeNull());
    await user.click(screen.getByTestId("nav-diagram"));
    await screen.findByTestId("pattern-canvas");
    for (const f of ["mcp", "ai-guard", "rejected", "aggregate", "a2a", "llm", "intent"]) expect(screen.getByTestId(`flow-${f}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simulate" })).toBeInTheDocument();
    expect(screen.getByTestId("pattern-reset")).toBeInTheDocument();
    await user.click(screen.getByTestId("flow-llm"));
    await waitFor(() => expect(screen.getByText(/LLM call through the gateway/)).toBeInTheDocument());
  });

  it("presenter mode keeps the banner and adds the talk track aside; Escape leaves it", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("presenter"));
    expect(screen.getByTestId("banner")).toBeInTheDocument();
    expect(await screen.findByTestId("presenter-say")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("presenter-say")).toBeNull());
  });

  it("the where-it-is-logged page lists five sinks and the UNVERIFIED list", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("nav-sinks"));
    await screen.findByTestId("sinks-page");
    expect(document.querySelectorAll("[data-testid^=sink-card-]").length).toBe(5);
    expect(screen.getByTestId("cannot-see").textContent).toMatch(/UNVERIFIED/);
  });
});

// A tiny FAKE gateway for the toggle test (loopback). The lab's own server is configured with it.
const fakeGateway = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => {
      const m = JSON.parse(Buffer.concat(c).toString() || "{}");
      if (m.method === "initialize") { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })); }
      if (m.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [] } }));
    });
  });
  server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/demo-mcp-app/mcp`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) }));
});

describe("Real mode (against a fake gateway)", () => {
  it("the toggle switches both ways without a reload and reloads data; the confirm gate blocks the first send; pasting scores the run", async () => {
    const gw = await fakeGateway();
    lab = await startLab({ env: { STANDALONE_ENV: "/nonexistent/settings.env", PRIV_LOG_GATEWAY_URL: gw.url, PRIV_LOG_AGENT_KEY: KEY } });
    const user = userEvent.setup();
    try {
      render(<App />);
      await screen.findByTestId("run-page");
      // default is Real when configured
      await waitFor(() => expect(screen.getByTestId("mode-real")).toHaveAttribute("aria-pressed", "true"));
      expect(screen.getByTestId("banner")).toHaveAttribute("data-state", "live");
      expect(screen.getByTestId("banner").textContent).toMatch(/REAL \(owner-run\)/);
      expect(screen.getByTestId("note-llm-allowed").textContent).toMatch(/Not runnable in Real/);
      expect(screen.getByTestId("ident-mcp-allowed-user").textContent).toMatch(/agent key/);
      expect(screen.getByTestId("run-llm-allowed")).toBeDisabled();
      // first send: the gate appears and nothing is sent yet
      await user.click(screen.getByTestId("run-mcp-allowed-key"));
      const gate = await screen.findByTestId("confirm-gate");
      expect(screen.getByTestId("case-mcp-allowed-key").contains(gate)).toBe(true); // confirmed in the card that was run, not at the top
      expect(screen.getByTestId("gate-confirm")).toHaveFocus();
      expect(screen.getByTestId("gate-gateway").textContent).toBe(new URL(gw.url).origin);
      expect(screen.queryByTestId("open-mcp-allowed-key")).toBeNull();
      await user.click(screen.getByTestId("gate-confirm"));
      // the run goes on after the confirmation and stays on the Run page; no log source is configured, so the Trace offers the paste box
      await waitFor(() => expect(screen.getByTestId("run-mcp-allowed-key")).not.toBeDisabled(), { timeout: 5000 });
      expect(screen.getByTestId("run-page")).toBeInTheDocument();
      expect(gate).not.toBeInTheDocument();
      await openTrace(user, "mcp-allowed-key");
      expect(await screen.findByTestId("unscored")).toBeInTheDocument();
      expect(screen.getByTestId("retrieval").textContent).toMatch(/not configured/);
      expect(screen.getByTestId("retrieval").textContent).toMatch(/Paste the gateway log lines/);
      expect(document.body.textContent).not.toContain(KEY);
      await user.click(screen.getByTestId("paste-box"));
      await user.paste("Access token found for user: u1, client: audit-test\nMCP call detected for method tools with target: get_weather");
      await user.click(screen.getByTestId("paste-score"));
      await screen.findByTestId("paste-result");
      await waitFor(() => expect(screen.getByTestId("score")).toBeInTheDocument());
      expect(screen.getByTestId("trace-source").textContent).toMatch(/REAL/);
      // switch to Mock and back: data reloads (the Real run disappears from the Run page, then Mock replays)
      await user.click(screen.getByTestId("mode-mock"));
      await waitFor(() => expect(screen.getByTestId("mode-mock")).toHaveAttribute("aria-pressed", "true"));
      expect(screen.getByTestId("banner").textContent).toMatch(/Replay of transactions/);
      await user.click(screen.getByTestId("nav-run"));
      await waitFor(() => expect(screen.queryByTestId("open-mcp-allowed-key")).toBeNull());
      await user.click(screen.getByTestId("mode-real"));
      await waitFor(() => expect(screen.getByTestId("mode-real")).toHaveAttribute("aria-pressed", "true"));
      expect(screen.getByTestId("run-llm-allowed")).toBeDisabled();
    } finally { await gw.close(); }
  }, 30000);
});

// ---- progress, auto retrieval, real-only cases ----
import fs from "node:fs";
import path from "node:path";

const fakeGw = ({ delayMs = 0 } = {}) => new Promise((resolve) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const c = []; req.on("data", (d) => c.push(d)); req.on("end", async () => {
      const body = Buffer.concat(c).toString() || "{}";
      requests.push({ url: req.url, body, at: Date.now() });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const m = JSON.parse(body);
      if (m.method === "initialize") { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })); }
      if (m.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
      if (!/^Bearer /.test(req.headers.authorization || "")) { res.writeHead(401); return res.end("{}"); }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [] } }));
    });
  });
  server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/demo-mcp-app/mcp`, requests, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) }));
});
// A fake kubectl proxy: writes the log lines a gateway would write for the calls the fake gateway received. mode: "ok" | "empty" | "down"
const fakeProxy = (gw, ctl = { mode: "ok", delayMs: 0 }) => new Promise((resolve) => {
  const server = http.createServer(async (req, res) => {
    if (ctl.delayMs) await new Promise((r) => setTimeout(r, ctl.delayMs));
    if (ctl.mode === "down") { res.writeHead(500); return res.end("boom"); }
    const lines = ctl.mode === "empty" ? [] : gw.requests.flatMap((r) => {
      const m = JSON.parse(r.body); if (m.method !== "tools/call") return [];
      const iso = new Date(r.at).toISOString();
      return [`${iso} time="${iso}" level=info msg="Access token found for user: u-live, client: audit-test"`, `${iso} time="${iso}" level=info msg="MCP call detected for method tools with target: ${m.params.name}"`, `${iso} time="${iso}" level=info msg="incoming request: ${r.body.replace(/"/g, "'")}"`];
    });
    res.writeHead(200, { "content-type": "text/plain" }); res.end(lines.join("\n"));
  });
  server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${server.address().port}`, ctl, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) }));
});
const realLab = async (gw, proxy, opts) => startLab({ opts, env: { STANDALONE_ENV: "/nonexistent/settings.env", PRIV_LOG_GATEWAY_URL: gw.url, PRIV_LOG_AGENT_KEY: KEY, ...(proxy ? { PRIV_LOG_K8S_PROXY_URL: proxy.base, PRIV_LOG_K8S_NAMESPACE: "privilege", PRIV_LOG_K8S_POD: "gateway-abc" } : {}) } });
// Run no longer opens the Trace: wait for the card's Open trace button and click it.
const openTrace = async (user, id) => user.click(await screen.findByTestId(`open-${id}`, {}, { timeout: 8000 }));
const confirmAndRun = async (user, id) => {
  await user.click(screen.getByTestId(`run-${id}`));
  await user.click(await screen.findByTestId("gate-confirm"));
};

describe("Run progress and automatic log retrieval", () => {
  it("Mock shows the same two phases (a short simulated delay), keeps the replay banner, stays on the Run page, and Open trace shows the recorded entry", async () => {
    lab = await startLab({ opts: { mockDelayMs: 500 } });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("run-mcp-allowed-key"));
    const busy = await screen.findByTestId("busy-mcp-allowed-key");
    expect(busy).toHaveAttribute("role", "status");
    expect(screen.getByTestId("case-mcp-allowed-key")).toHaveAttribute("aria-busy", "true");
    expect(busy.querySelector(".spinner")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("busy-mcp-allowed-key").textContent).toMatch(/Fetching the log entry \(simulated delay\)/), { timeout: 3000 });
    expect(screen.getByTestId("banner").textContent).toMatch(/Replay of transactions measured on 2026-11-07; nothing is sent\./);
    expect(screen.getByTestId("run-mcp-allowed-key")).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId("run-mcp-allowed-key")).not.toBeDisabled(), { timeout: 5000 });
    expect(screen.getByTestId("run-page")).toBeInTheDocument();
    expect(screen.getByTestId("run-mcp-allowed-key")).toHaveFocus();
    expect(within(screen.getByTestId("case-mcp-allowed-key")).getByLabelText("score")).toBeInTheDocument();
    await openTrace(user, "mcp-allowed-key");
    await screen.findByTestId("lines-gateway-log", {}, { timeout: 5000 });
    expect(screen.getByTestId("retrieval").textContent).toMatch(/recording/);
    expect(screen.getByTestId("banner").textContent).toMatch(/nothing is sent/);
  });

  it("Real: Sending... then Fetching the log entry... then Open trace shows the entry matched by the run marker", async () => {
    const gw = await fakeGw({ delayMs: 150 }); const proxy = await fakeProxy(gw, { mode: "ok", delayMs: 300 });
    lab = await realLab(gw, proxy);
    const user = userEvent.setup();
    try {
      render(<App />);
      await screen.findByTestId("run-page");
      await confirmAndRun(user, "mcp-allowed-key");
      await waitFor(() => expect(screen.getByTestId("busy-mcp-allowed-key").textContent).toMatch(/Sending\.\.\./), { timeout: 3000 });
      await waitFor(() => expect(screen.getByTestId("busy-mcp-allowed-key").textContent).toMatch(/Fetching the log entry\.\.\./), { timeout: 5000 });
      await waitFor(() => expect(screen.queryByTestId("busy-mcp-allowed-key")).toBeNull(), { timeout: 8000 });
      expect(screen.getByTestId("run-page")).toBeInTheDocument();
      await openTrace(user, "mcp-allowed-key");
      await screen.findByTestId("lines-k8s-pod", {}, { timeout: 8000 });
      expect(screen.getByTestId("trace-marker").textContent).toMatch(/^audit-[0-9a-f]{8}$/);
      const methods = screen.getAllByTestId("entry-method").map((e) => e.textContent);
      expect(methods).toContain("matched by marker"); expect(methods).toContain("time window: inferred");
      expect(screen.getByTestId("retrieval").textContent).toMatch(/found by run marker/);
      expect(document.querySelector("mark[data-field=tool]")).toBeTruthy();
      expect(document.body.textContent).not.toContain(KEY);
    } finally { await gw.close(); await proxy.close(); }
  }, 30000);

  it("Real: a log source that is not reachable says so with a Retry; Retry fetches again (no resend) and the score appears", async () => {
    const gw = await fakeGw(); const proxy = await fakeProxy(gw, { mode: "down" });
    lab = await realLab(gw, proxy);
    const user = userEvent.setup();
    try {
      render(<App />);
      await screen.findByTestId("run-page");
      await confirmAndRun(user, "mcp-allowed-key");
      const fail = await screen.findByTestId("busy-mcp-allowed-key", {}, { timeout: 8000 });
      await waitFor(() => expect(screen.getByTestId("busy-mcp-allowed-key").textContent).toMatch(/Log source not reachable/), { timeout: 8000 });
      expect(screen.getByTestId("busy-mcp-allowed-key")).toHaveAttribute("role", "alert");
      expect(fail.textContent).toMatch(/HTTP 500/);
      expect(screen.getByTestId("run-page")).toBeInTheDocument();
      const sent = gw.requests.length;
      proxy.ctl.mode = "ok";
      await user.click(screen.getByTestId("retry-mcp-allowed-key"));
      await waitFor(() => expect(screen.queryByTestId("busy-mcp-allowed-key")).toBeNull(), { timeout: 8000 });
      expect(gw.requests.length).toBe(sent);
      expect(within(screen.getByTestId("case-mcp-allowed-key")).getByLabelText("score")).toBeInTheDocument();
    } finally { await gw.close(); await proxy.close(); }
  }, 30000);

  it("Real: no entry within the limit is explicit (with the retry progress) and offers Retry and the paste fallback", async () => {
    const gw = await fakeGw(); const proxy = await fakeProxy(gw, { mode: "empty" });
    lab = await realLab(gw, proxy);
    const user = userEvent.setup();
    try {
      render(<App />);
      await screen.findByTestId("run-page");
      await confirmAndRun(user, "mcp-allowed-key");
      await waitFor(() => expect(screen.getByTestId("busy-mcp-allowed-key").textContent).toMatch(/No entry found yet after \d+ s \(retrying until 1 s\)/), { timeout: 8000 });
      await waitFor(() => expect(screen.getByTestId("busy-mcp-allowed-key").textContent).toMatch(/No entry found within 1 s/), { timeout: 8000 });
      expect(screen.getByTestId("retry-mcp-allowed-key")).toBeInTheDocument();
      expect(screen.getByTestId("busy-mcp-allowed-key").textContent).toMatch(/paste the gateway log lines/);
    } finally { await gw.close(); await proxy.close(); }
  }, 30000);

  it("the spinner only animates when the user has not asked for reduced motion", () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/app.css"), "utf8");
    const m = /@media \(prefers-reduced-motion: no-preference\) \{[^}]*\.spinner \{ animation:/.exec(css);
    expect(m).toBeTruthy();
    expect(css.replace(m[0], "")).not.toMatch(/\.spinner[^}]*animation:/);
  });
});

describe("Real-only (not yet measured) cases", () => {
  it("Mock lists them with Run disabled, the tooltip and a visible note; the Scorecard says not measured", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    for (const id of ["keys-revoked", "fed-valid-token", "approval-held", "reg-key-created"]) {
      const btn = screen.getByTestId(`run-${id}`);
      expect(btn).toBeDisabled();
      expect(btn.getAttribute("title")).toBe("No recorded measurement yet. Real mode only.");
      expect(screen.getByTestId(`mockonly-${id}`).textContent).toBe("No recorded measurement yet. Real mode only.");
      expect(screen.getByTestId(`needs-${id}`).textContent).toMatch(/not measured.*Needs:/);
    }
    expect(screen.getByText(/Keys · not measured yet/)).toBeInTheDocument();
    await user.click(screen.getByTestId("nav-scorecard"));
    const row = await screen.findByTestId("row-keys-revoked");
    expect(within(row).getAllByText("not measured")).toHaveLength(4);
    expect(row.textContent).not.toMatch(/\bmet\b|\bmissing\b|\bpartial\b/);
    expect(screen.getByTestId("md-preview").value).toMatch(/\| Revoked agent key \| Keys \| not measured \| not measured \| not measured \| not measured \|/);
  });

  it("Real: the credential field is write-only (password input, cleared, never shown) and the console-action case has 'Look for entries since'", async () => {
    const gw = await fakeGw(); const proxy = await fakeProxy(gw, { mode: "ok" });
    lab = await realLab(gw, proxy);
    const user = userEvent.setup();
    try {
      render(<App />);
      await screen.findByTestId("run-page");
      expect(screen.getByTestId("run-keys-revoked")).toBeDisabled();
      const input = screen.getByTestId("bearer-input-keys-revoked");
      expect(input).toHaveAttribute("type", "password");
      await user.type(input, "owner-bearer-NOT-REAL-12345");
      await user.click(screen.getByTestId("bearer-set-keys-revoked"));
      await screen.findByTestId("bearer-on-keys-revoked");
      expect(input.value).toBe("");
      expect(document.body.textContent).not.toContain("owner-bearer-NOT-REAL-12345");
      expect(screen.getByTestId("run-keys-revoked")).not.toBeDisabled();
      expect(screen.getByTestId("since-reg-key-created")).toHaveAttribute("type", "datetime-local");
      expect(screen.getByTestId("run-reg-key-created").textContent).toBe("Look for entries");
      await user.click(screen.getByTestId("bearer-clear-keys-revoked"));
      await waitFor(() => expect(screen.queryByTestId("bearer-on-keys-revoked")).toBeNull());
    } finally { await gw.close(); await proxy.close(); }
  }, 30000);
  it("Real: the valid workload token case shows the issuer setup steps until the lab can mint, then says the lab mints the token", async () => {
    const gw = await fakeGw();
    lab = await realLab(gw);
    try {
      render(<App />);
      const panel = await screen.findByTestId("fed-setup");
      expect(panel).toHaveAttribute("open");
      expect(screen.getByTestId("fed-not-ready")).toBeInTheDocument();
      expect(screen.getByTestId("fed-issuer").textContent).toBe("https://privilege-logging-lab.invalid/workload");
      expect(screen.getByTestId("fed-problem").textContent).toMatch(/npm run fed-key/);
      expect(screen.queryByTestId("fed-jwks")).toBeNull();
      expect(screen.getByTestId("run-fed-valid-token")).toBeDisabled();
    } finally { await gw.close(); }
    await lab.close?.(); lab = null;
    const gw2 = await fakeGw();
    lab = await startLab({ env: { STANDALONE_ENV: "/nonexistent/settings.env", PRIV_LOG_GATEWAY_URL: gw2.url, PRIV_LOG_AGENT_KEY: KEY, PRIV_LOG_FED_SIGNING_SEED: "11".repeat(32), PRIV_LOG_FED_AUDIENCE: "priv-nhi-test-NOT-REAL" } });
    try {
      cleanup(); render(<App />);
      await screen.findByTestId("fed-ready");
      expect(screen.getByTestId("fed-setup")).not.toHaveAttribute("open");
      expect(JSON.parse(screen.getByTestId("fed-jwks").textContent).keys[0].alg).toBe("ES256");
      expect(document.body.textContent).not.toContain("11".repeat(32));
      expect(screen.getByTestId("run-fed-valid-token")).not.toBeDisabled();
    } finally { await gw2.close(); }
  }, 30000);
});
