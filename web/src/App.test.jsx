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
    expect(visible("a‮b\u0000c")).toBe("a\\u202eb\\u0000c");
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
    for (const tab of ["trace", "scorecard", "sinks", "diagram", "talk", "run"]) {
      await user.click(screen.getByTestId(`nav-${tab}`));
      expect(screen.getByTestId("banner").textContent).toMatch(/nothing is sent/);
    }
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("run-mcp-allowed-key"));
    await user.click(await screen.findByTestId("open-mcp-allowed-key"));
    const lines = await screen.findByTestId("lines-gateway-log");
    const marked = [...lines.querySelectorAll("mark")].map((m) => [m.getAttribute("data-field"), m.textContent]);
    expect(marked).toContainEqual(["tool", "get_weather"]);
    expect(marked).toContainEqual(["agent", "audit-test"]);
    expect(marked.some(([f]) => f === "decision")).toBe(true);
    expect(screen.getByTestId("trace-source").textContent).toMatch(/MOCK replay of 2026-11-07/);
    expect(screen.getByTestId("score").textContent).toMatch(/partial/);
    expect(screen.getByTestId("not-read").textContent).toMatch(/Audit-Trail header/);
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
    await user.click(screen.getByTestId("nav-scorecard"));
    const table = await screen.findByTestId("scorecard-table");
    expect(table.querySelectorAll("tbody tr[data-testid^=row-]").length).toBe(17);
    expect(within(screen.getByTestId("row-mcp-allowed-key")).getAllByText(/met|partial/).length).toBeGreaterThanOrEqual(4);
    expect(within(screen.getByTestId("row-llm-allowed")).getAllByText("missing").length).toBe(3);
    await user.click(screen.getByTestId("copy-md"));
    expect(clipboard).toMatch(/^Measured on 2026-11-07/);
    expect(clipboard.split("\n").filter((l) => l.startsWith("| ")).length).toBe(19);
    expect(screen.getByTestId("copy-status").textContent).toMatch(/Copied/);
  });

  it("the paste box scores lines with the same scorer and renders hostile text inert", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("nav-trace"));
    const box = await screen.findByTestId("paste-box");
    await user.click(box);
    await user.paste('Access token found for user: <img src=x onerror=alert(1)>, client: audit-test\nMCP call detected for method tools with target: t‮gnp.');
    await user.click(screen.getByTestId("paste-score"));
    const res = await screen.findByTestId("paste-result");
    expect(res.querySelector("img")).toBeNull();
    expect(res.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(res.textContent).toContain("\\u202e");
    expect(within(res).getAllByText("met").length).toBeGreaterThanOrEqual(3);
  });

  it("Reset clears this tab's runs; the diagram page offers one diagram per flow with Simulate and Reset", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("run-no-credential"));
    await screen.findByTestId("open-no-credential");
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
      expect(screen.getByTestId("run-llm-allowed")).toBeDisabled();
      // first send: the gate appears and nothing is sent yet
      await user.click(screen.getByTestId("run-mcp-allowed-key"));
      const gate = await screen.findByTestId("confirm-gate");
      expect(screen.getByTestId("gate-gateway").textContent).toBe(new URL(gw.url).origin);
      expect(screen.queryByTestId("open-mcp-allowed-key")).toBeNull();
      await user.click(screen.getByTestId("gate-confirm"));
      await screen.findByTestId("open-mcp-allowed-key");
      expect(gate).not.toBeInTheDocument();
      // no search URL: the run is not scored and says so
      expect(screen.getByText(/paste log lines to score/)).toBeInTheDocument();
      await user.click(screen.getByTestId("open-mcp-allowed-key"));
      expect(await screen.findByTestId("unscored")).toBeInTheDocument();
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
