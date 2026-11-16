// "What Privilege did" (Rule 25) on the Trace page, against the real lab server (a child process) in Mock, and in Real against a FAKE gateway.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import http from "node:http";
import App from "./App";
import { setJsonView } from "./components/JsonPane.jsx";
import { KEY, startLab } from "./testServer";

let lab;
afterEach(async () => { cleanup(); await lab?.close(); window.location.hash = ""; try { window.sessionStorage.clear(); } catch { /* ignore */ } });
beforeEach(() => { window.location.hash = ""; setJsonView("raw"); });

const openTrace = async (user, id) => user.click(await screen.findByTestId(`open-${id}`, {}, { timeout: 8000 }));

// A tiny FAKE gateway on loopback (never a real one).
const fakeGateway = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => {
      const m = JSON.parse(Buffer.concat(c).toString() || "{}");
      if (m.method === "initialize") { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-fake-0123456789" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })); }
      if (m.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "sunny" }] } }));
    });
  });
  server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/demo-mcp-app/mcp`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) }));
});

describe("What Privilege did on the Trace page", () => {
  it("Mock: a replay shows the request Real would send, the recorded outcome and decisions read from it (never checked), with no secret", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("run-mcp-tool-not-granted"));
    await openTrace(user, "mcp-tool-not-granted");
    const panel = await screen.findByTestId("gateway-trace", {}, { timeout: 5000 });
    expect(within(panel).getByRole("heading", { name: "What Privilege did" })).toBeInTheDocument();
    expect(screen.getByTestId("gateway-trace-basis").textContent).toMatch(/Replay of the transaction recorded on 2026-11-07/);
    expect(screen.getByTestId("gateway-trace-basis").textContent).toMatch(/computes no gateway decision/);
    expect(screen.getByTestId("gateway-trace-basis").textContent).not.toMatch(/what it computed/);
    expect(screen.getByTestId("trace-1").textContent).toMatch(/Replay: tools\/call no_such_tool/);
    expect(screen.getByTestId("trace-1").textContent).toMatch(/HTTP 403/);
    const decisions = screen.getByTestId("trace-1-decisions").textContent;
    expect(decisions).toMatch(/Grant/); expect(decisions).toMatch(/FAIL/);
    expect(decisions).toMatch(/inferred from the outcome/);
    expect(decisions).not.toMatch(/checked/i);
    expect(screen.getByTestId("trace-1-request-box").textContent).toMatch(/gateway\.example\.invalid/);
    expect(screen.getByTestId("trace-1-response-box").textContent).toMatch(/recordedNote/);
    expect(document.body.textContent).not.toContain(KEY);
  }, 30000);

  it("Mock: a case whose route is not measured says there is no gateway call to show, and shows no panel", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("run-a2a-call"));
    await openTrace(user, "a2a-call");
    expect(await screen.findByTestId("gateway-trace-none", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByTestId("gateway-trace")).toBeNull();
  }, 30000);

  it("Real: the exact request and answer of the call, the session calls around it, and decisions that are inferred, never checked; the key and the whole session id are absent", async () => {
    const gw = await fakeGateway();
    lab = await startLab({ env: { STANDALONE_ENV: "/nonexistent/settings.env", PRIV_LOG_GATEWAY_URL: gw.url, PRIV_LOG_AGENT_KEY: KEY } });
    const user = userEvent.setup();
    try {
      render(<App />);
      await screen.findByTestId("run-page");
      await waitFor(() => expect(screen.getByTestId("mode-select")).toHaveValue("real"));
      await user.click(screen.getByTestId("run-mcp-allowed-key"));
      await user.click(await screen.findByTestId("gate-confirm"));
      await waitFor(() => expect(screen.getByTestId("run-mcp-allowed-key")).not.toBeDisabled(), { timeout: 5000 });
      await openTrace(user, "mcp-allowed-key");
      const panel = await screen.findByTestId("gateway-trace", {}, { timeout: 5000 });
      expect(screen.getByTestId("gateway-trace-basis").textContent).toMatch(/Real gateway/);
      expect(screen.getByTestId("trace-1").textContent).toMatch(/Gateway call: tools\/call get_weather/);
      expect(screen.getByTestId("trace-1").textContent).toMatch(/HTTP 200/);
      expect(screen.getByTestId("trace-1-request-box").textContent).toMatch(/"method": "tools\/call"/);
      expect(screen.getByTestId("trace-1-request-box").textContent).toMatch(/audit-[0-9a-f]{8}/);
      expect(screen.getByTestId("trace-1-response-box").textContent).toMatch(/sunny/);
      expect(screen.getByTestId("trace-1-setup").textContent).toMatch(/initialize HTTP 200, notifications\/initialized HTTP 202/);
      const decisions = screen.getByTestId("trace-1-decisions").textContent;
      expect(decisions).toMatch(/inferred from the outcome/);
      expect(decisions).not.toMatch(/checked/i);
      expect(panel.textContent).not.toContain(KEY);
      expect(panel.textContent).not.toContain("session-fake-0123456789");
    } finally { await gw.close(); }
  }, 30000);
});
