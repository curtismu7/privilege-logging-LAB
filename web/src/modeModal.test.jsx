import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import http from "node:http";
import App, { modeLines } from "./App";
import { KEY, startLab } from "./testServer";

// The Real-or-mock modal (shared/mode-modal) replaced the simulation banner. These tests pin its wiring in this lab:
// the Mock and Real lines, the dismissal for the session, held until the mode is known, and the banner being gone.
// A tiny FAKE gateway on loopback: configuring it is what makes the lab start in Real. Nothing in these tests sends a run.
const fakeGateway = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/demo-mcp-app/mcp`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) }));
});
const realLab = async () => { gw = await fakeGateway(); lab = await startLab({ env: { STANDALONE_ENV: "/nonexistent/settings.env", PRIV_LOG_GATEWAY_URL: gw.url, PRIV_LOG_AGENT_KEY: KEY } }); };

let lab; let gw;
afterEach(async () => { cleanup(); globalThis.__held?.(); globalThis.__held = null; await lab?.close(); await gw?.close(); lab = null; gw = null; window.location.hash = ""; });
beforeEach(() => { window.location.hash = ""; });

describe("Real-or-mock modal", () => {
  it("opens on MOCK with the replay line and its second sentence, Got it closes it, a remount in the same session does not reopen it", async () => {
    lab = await startLab();
    const { unmount } = render(<App />);
    const modal = await screen.findByTestId("mode-modal");
    expect(modal).toHaveAttribute("data-mode", "mock");
    expect(modal).toHaveTextContent("MOCK");
    expect(modal.textContent).toContain(modeLines("2026-11-07").mock);
    expect(modal.textContent).toMatch(/no gateway, search endpoint or tenant is contacted/);
    fireEvent.click(screen.getByTestId("mode-modal-ok"));
    expect(screen.queryByTestId("mode-modal")).toBeNull();
    unmount();
    render(<App />);
    await screen.findByTestId("run-page");
    expect(screen.queryByTestId("mode-modal")).toBeNull();
  });

  it("opens on REAL when the lab is configured for Real, with the owner-run line", async () => {
    await realLab();
    render(<App />);
    const modal = await screen.findByTestId("mode-modal");
    expect(modal).toHaveAttribute("data-mode", "real");
    expect(modal).toHaveTextContent("REAL");
    expect(modal.textContent).toContain(modeLines().real);
    expect(modal.textContent).toMatch(/anything not checked is UNVERIFIED/);
  });

  it("is held until /api/info answers: no MOCK flash on a Real lab, then REAL appears", async () => {
    await realLab();
    const inner = globalThis.fetch;
    let release; const gate = new Promise((r) => { release = r; });
    globalThis.__held = () => { release(); globalThis.fetch = inner; };
    globalThis.fetch = (u, o) => (String(u).includes("/api/info") ? gate.then(() => inner(u, o)) : inner(u, o));
    render(<App />);
    await screen.findByTestId("run-page");
    expect(screen.queryByTestId("mode-modal")).toBeNull();
    release();
    const modal = await screen.findByTestId("mode-modal");
    expect(modal).toHaveAttribute("data-mode", "real");
  });

  it("the simulation banner is gone: no banner element on the Run page, and the modal is the only mode label", async () => {
    lab = await startLab();
    render(<App />);
    await screen.findByTestId("mode-modal");
    await screen.findByTestId("run-page");
    expect(screen.queryByTestId("banner")).toBeNull();
    expect(screen.queryByTestId("mode-unknown")).toBeNull();
    expect(screen.queryByTestId("prompts-banner")).toBeNull();
    expect(document.querySelector("main > .banner")).toBeNull();
  });
});
