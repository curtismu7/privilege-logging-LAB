// Pins the fixes from the two-reviewer pass on the web: each test fails on the old behaviour.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import App, { BANNER_MODE_UNKNOWN } from "./App";
import ConfirmGate from "./components/ConfirmGate";
import JsonTree from "./components/JsonTree";
import PatternDiagram, { MIN_ZOOM, applyNodeChanges } from "./components/PatternDiagram";
import { parseLogLine } from "./lib/logEntry";
import { startLab } from "./testServer";

const css = (f) => fs.readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
// Wrap the lab's fetch: `fail` decides per path whether a request rejects; every path is counted.
function wrapFetch(fail) {
  const inner = globalThis.fetch; const seen = [];
  globalThis.fetch = (u, o) => { const p = String(u); seen.push(p); return fail(p) ? Promise.reject(new TypeError("network down")) : inner(u, o); };
  return { seen, restore: () => { globalThis.fetch = inner; } };
}

let lab;
afterEach(async () => { cleanup(); await lab?.close(); lab = null; window.location.hash = ""; try { window.sessionStorage.clear(); } catch { /* ignore */ } });
beforeEach(() => { window.location.hash = ""; });

describe("log parsing keeps fields named like Object.prototype members", () => {
  it("constructor, toString, hasOwnProperty, valueOf and __proto__ are real fields; nothing is polluted", () => {
    const r = parseLogLine("level=info msg=hi constructor=x toString=y hasOwnProperty=z valueOf=1 __proto__=2 foo=bar");
    expect(Object.keys(r.value)).toEqual(["level", "msg", "constructor", "toString", "hasOwnProperty", "valueOf", "__proto__", "foo"]);
    expect(r.value.constructor).toBe("x"); expect(r.value.__proto__).toBe(2); expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
    expect(({}).foo).toBeUndefined();
    expect(Object.keys(parseLogLine("time=1 foo=bar constructor=x").value)).toContain("constructor");
  });
});

describe("Real confirm gate", () => {
  it("scrolls itself into view and takes focus when it opens", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<ConfirmGate gate={{ gatewayOrigin: "https://gw.example", queue: [] }} onConfirm={() => {}} onCancel={() => {}} busy={false} />);
    expect(document.activeElement).toBe(screen.getByTestId("confirm-gate"));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("honest mode when /api/info fails", () => {
  it("shows MODE UNKNOWN (never the Mock 'nothing is sent' banner), disables Run, offers Retry, and recovers", async () => {
    lab = await startLab();
    const w = wrapFetch((p) => p.includes("/api/info"));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await waitFor(() => expect(screen.getByTestId("banner").textContent).toBe(BANNER_MODE_UNKNOWN));
    expect(screen.getByTestId("banner").textContent).not.toMatch(/nothing is sent/);
    expect(screen.getByTestId("banner")).toHaveAttribute("data-state", "unknown");
    expect(screen.getByTestId("mode").textContent).toBe("Unknown");
    expect(screen.getByTestId("run-mcp-allowed-key")).toBeDisabled();
    expect(screen.getByTestId("run-all")).toBeDisabled();
    w.restore();
    await user.click(screen.getByTestId("mode-retry"));
    await waitFor(() => expect(screen.getByTestId("banner").textContent).toMatch(/nothing is sent/));
    expect(screen.getByTestId("run-mcp-allowed-key")).not.toBeDisabled();
    expect(screen.queryByTestId("mode-retry")).toBeNull();
  });
});

describe("Run page accessibility and focus", () => {
  it("each Run button and card is named after its case; the disabled Real button's how-to is on the page", async () => {
    lab = await startLab();
    render(<App />);
    await screen.findByTestId("run-page");
    const card = screen.getByTestId("case-mcp-allowed-key");
    const title = card.querySelector("h3").textContent;
    expect(screen.getByRole("article", { name: title })).toBe(card);
    expect(screen.getByRole("button", { name: `Run: ${title}` })).toBe(screen.getByTestId("run-mcp-allowed-key"));
    expect(screen.queryAllByRole("button", { name: "Run" })).toHaveLength(0);
    await waitFor(() => expect(screen.getByTestId("real-hint").textContent).toMatch(/PRIV_LOG_GATEWAY_URL/));
    expect(screen.getByTestId("mode-real")).toHaveAttribute("aria-describedby", "real-hint");
  });

  it("after a Run opens its Trace, focus is on the Trace heading, not lost to <body>", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await waitFor(() => expect(screen.getByTestId("run-mcp-allowed-key")).not.toBeDisabled());
    await user.click(screen.getByTestId("run-mcp-allowed-key"));
    await screen.findByTestId("lines-gateway-log", {}, { timeout: 5000 });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 })));
    expect(document.activeElement.textContent).toMatch(/^Trace/);
  });

  it("Run all gives focus back to Run all when the browser dropped it while the buttons were disabled", async () => {
    lab = await startLab();
    render(<App />);
    await screen.findByTestId("run-page");
    await waitFor(() => expect(screen.getByTestId("run-all")).not.toBeDisabled());
    // A browser drops focus to <body> when the focused button becomes disabled; jsdom keeps it on the disabled button, so
    // start the run with focus on <body> (a click event without focusing), which is the state the browser ends up in.
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByTestId("run-all"));
    await waitFor(() => expect(screen.getByTestId("run-all")).toBeDisabled());
    await waitFor(() => expect(screen.getByTestId("open-intent-encoder-unreachable")).toBeInTheDocument(), { timeout: 10_000 });
    await waitFor(() => expect(screen.getByTestId("run-all")).not.toBeDisabled(), { timeout: 4000 });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("run-all")));
  }, 15_000);

  it("a failed log fetch offers Retry, and Retry fetches again without re-running the case", async () => {
    lab = await startLab();
    let down = true;
    const w = wrapFetch((p) => down && p.includes("/api/fetch-log"));
    const user = userEvent.setup();
    try {
      render(<App />);
      await screen.findByTestId("run-page");
      await waitFor(() => expect(screen.getByTestId("run-mcp-allowed-key")).not.toBeDisabled());
      await user.click(screen.getByTestId("run-mcp-allowed-key"));
      await screen.findByTestId("retry-mcp-allowed-key", {}, { timeout: 5000 });
      expect(screen.getByTestId("busy-mcp-allowed-key").textContent).toMatch(/Failed/);
      const runs = w.seen.filter((p) => /\/api\/run$/.test(p)).length;
      expect(runs).toBe(1);
      down = false;
      await user.click(screen.getByTestId("retry-mcp-allowed-key"));
      await waitFor(() => expect(screen.queryByTestId("busy-mcp-allowed-key")).toBeNull(), { timeout: 5000 });
      expect(w.seen.filter((p) => /\/api\/run$/.test(p)).length).toBe(runs);
      expect(within(screen.getByTestId("case-mcp-allowed-key")).getByLabelText("score")).toBeInTheDocument();
    } finally { w.restore(); }
  });

  it("Ctrl+P and Cmd+P (print) do not toggle presenter mode; plain P does", async () => {
    lab = await startLab();
    render(<App />);
    await screen.findByTestId("run-page");
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    expect(screen.getByTestId("presenter")).toHaveAttribute("aria-pressed", "false");
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    expect(screen.getByTestId("presenter")).toHaveAttribute("aria-pressed", "false");
    fireEvent.keyDown(window, { key: "p" });
    expect(screen.getByTestId("presenter")).toHaveAttribute("aria-pressed", "true");
  });

  it("Scorecard totals are h2 under the page h1 (heading order) inside a labelled group", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    await user.click(screen.getByTestId("nav-scorecard"));
    const total = await screen.findByTestId("total-user");
    expect(total.querySelector("h2")).toBeTruthy(); expect(total.querySelector("h3")).toBeNull();
    expect(screen.getByRole("group", { name: "Totals" })).toContainElement(total);
  });
});

describe("JSON viewer", () => {
  it("a plain-text line has no Expand/Collapse and copies the line itself, not a JSON string literal", async () => {
    const user = userEvent.setup(); let clip = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { clip = t; } } });
    render(<JsonTree value="plain words here" raw="plain words here" />);
    expect(screen.queryByTestId("entry-expand")).toBeNull(); expect(screen.queryByTestId("entry-collapse")).toBeNull();
    await user.click(screen.getByTestId("entry-copy"));
    expect(screen.getByTestId("entry-copy").textContent).toBe("Copy line");
    expect(clip).toBe("plain words here");
  });
  it("token colours do not reuse the status colours: true is not red, strings are not the 'met' green", () => {
    const t = css("./tokens.css");
    expect(t).toMatch(/--json-bool:\s*var\(--text\)/);
    expect(t).not.toMatch(/--json-bool:\s*var\(--danger-text\)/);
    expect(t).not.toMatch(/--json-string:\s*var\(--status-ok\)/);
  });
});

describe("styles that carry contrast and state", () => {
  it("partial marks keep full opacity, and a disabled primary button does not keep the enabled red gradient", () => {
    const a = css("./app.css");
    const partial = /mark\[data-level="partial"\]\s*\{([^}]*)\}/.exec(a)[1];
    expect(partial).not.toMatch(/opacity/);
    const dis = /button\.primary:disabled\s*\{([^}]*)\}/.exec(a)[1];
    expect(dis).toMatch(/background:\s*var\(--surface-2\)/); expect(dis).toMatch(/color:\s*var\(--muted\)/);
  });
});

describe("diagram", () => {
  const pattern = { title: "T", intro: "i", nodes: [{ id: "a", label: "Agent", kind: "caller", x: 0, y: 0 }, { id: "b", label: "Gateway", kind: "gateway", x: 300, y: 0 }], steps: [{ from: "a", to: "b", label: "call", say: "s" }] };
  it("node changes from React Flow (select, then arrow-key position) are applied, so boxes move by keyboard", () => {
    const moved = []; const sel = [];
    applyNodeChanges([{ type: "select", id: "a", selected: true }, { type: "position", id: "a", position: { x: 5, y: 0 } }, { type: "dimensions", id: "a" }], { onMove: (id, p) => moved.push([id, p.x]), onSelect: (id, on) => sel.push([id, on]) });
    expect(sel).toEqual([["a", true]]); expect(moved).toEqual([["a", 5]]);
  });
  it("boxes are named, the steps are listed as text, there is one Reset per behaviour, and text never fits below about 9 px", () => {
    render(<PatternDiagram pattern={pattern} />);
    const node = document.querySelector('[data-testid="rf__node-a"]');
    expect(node.getAttribute("aria-label")).toMatch(/^Agent: box/);
    expect(within(screen.getByTestId("pattern-steps")).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["call"]);
    expect(screen.queryAllByRole("button", { name: "Reset" })).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Stop walkthrough" })).toBeInTheDocument();
    expect(screen.getByTestId("pattern-reset")).toBeInTheDocument();
    expect(13 * MIN_ZOOM).toBeGreaterThanOrEqual(9);
  });
});
