// The Requirement 9 tab against the real lab server: Mock (the recorded sample, placeholder values) for coverage, ledger, picker,
// deep link and the bad-id fallback; Real against a FAKE console (loopback) behind the confirm gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import http from "node:http";
import App from "./App";
import Req9Page, { matches, shortUser } from "./components/Req9Page";
import { KEY, startLab } from "./testServer";

let lab;
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await lab?.close(); lab = null; window.location.hash = ""; });
beforeEach(() => { window.location.hash = ""; });

const NEWEST = "0000000000000a01";
const RELEASE = "0000000000000a05";
const page = async (props = {}) => {
  lab = await startLab();
  const onSelect = vi.fn();
  render(<Req9Page info={{ source: "mock" }} signal={0} rid={null} onSelect={onSelect} {...props} />);
  await screen.findByTestId("req9-coverage");
  return onSelect;
};
const rid = () => screen.getByTestId("req9-selected-rid").textContent;

describe("helpers", () => {
  it("short user and the picker search over RequestID, user, agent key, tool and app", () => {
    expect(shortUser("01234567-89ab-4cde-8f01-23456789abcd")).toBe("01234567…");
    expect(shortUser(null)).toBe("no user");
    const r = { requestId: "abc123", user: "u-1", agent: "demo-agent-key", tool: "SearchIndexTool", app: "demo-app" };
    for (const q of ["ABC1", "u-1", "agent-key", "searchindex", "demo-app", ""]) expect(matches(r, q)).toBe(true);
    expect(matches(r, "nothing")).toBe(false);
    expect(matches({ ...r, agent: null }, "agent")).toBe(false);
  });
});

describe("Requirement 9 tab when the read fails", () => {
  it("still lists the requirement's four parts a-d next to the error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ENOTFOUND: getaddrinfo ENOTFOUND console.example"));
    render(<Req9Page info={{ source: "real" }} signal={0} rid={null} onSelect={vi.fn()} />);
    await screen.findByTestId("req9-error");
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items.slice(0, 4)).toEqual([
      "User on whose behalf the MCP tool call was made",
      "Agent identity acting on behalf of the user",
      "Which tool was called",
      "What was the authorization policy decision",
    ]);
  });
});

describe("Requirement 9 tab (Mock)", () => {
  it("coverage tiles a-d, the ledger with dashed missing parts, the three gaps and the diagram filled with the newest record", async () => {
    await page();
    expect(screen.getByTestId("req9-cov-a-count").textContent).toBe("8 / 8");
    expect(screen.getByTestId("req9-cov-b-count").textContent).toBe("4 / 8");
    expect(screen.getByTestId("req9-cov-b-status").textContent).toBe("PARTIAL");
    expect(screen.getByTestId("req9-cov-c-status").textContent).toBe("MET ON DECISIONS");
    expect(screen.getByTestId("req9-cov-d-status").textContent).toBe("PARTIAL");
    expect(screen.getByTestId("req9-mock-note").textContent).toMatch(/placeholder/i);
    for (const id of ["full-held", "full-denied", "non-human", "no-agent", "released-new-rid", "plain-allowed"]) expect(screen.getByTestId(`req9-row-${id}`)).toHaveAttribute("data-found", "true");
    expect(screen.getByTestId("req9-lane-no-agent-b")).toHaveAttribute("data-missing", "true");
    expect(screen.getByTestId("req9-lane-no-agent-b").textContent).toMatch(/no agent key/);
    for (const k of ["b", "c", "d"]) expect(screen.getByTestId(`req9-lane-plain-allowed-${k}`)).toHaveAttribute("data-missing", "true");
    expect(screen.getByTestId("req9-lane-plain-allowed-a")).not.toHaveAttribute("data-missing");
    expect(screen.getByTestId("req9-lane-full-held-b")).not.toHaveAttribute("data-missing");
    expect(screen.getByTestId("req9-row-no-agent").textContent).toMatch(/matched by user, tool and time/);
    expect(screen.getByTestId("req9-gap-agent").textContent).toMatch(/4 of 8 decision records/);
    expect(screen.getByTestId("req9-gap-allowed").textContent).toMatch(/question for Ping/);
    expect(screen.getByTestId("req9-gap-release").textContent).toMatch(/new RequestID/);
    expect(rid()).toBe(NEWEST);
    expect(await screen.findByTestId("pattern-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("req9-linked").textContent).toMatch(/policy_approval_required.*same RequestID/);
  }, 15000);

  it("picker: newest first, search narrows the list, a row picks its RequestID, Previous and Next walk the list", async () => {
    const user = userEvent.setup();
    const onSelect = await page();
    const rows = () => within(screen.getByTestId("req9-list")).queryAllByTestId("req9-pick-row");
    expect(rows()).toHaveLength(6);
    expect(rows()[0]).toHaveAttribute("aria-pressed", "true");
    expect(rows()[0].textContent).toMatch(/2026-11-07 22:16:53Z/);
    expect(screen.getByTestId("req9-prev")).toBeDisabled();
    await user.click(screen.getByTestId("req9-next"));
    expect(onSelect).toHaveBeenLastCalledWith("0000000000000a02");
    await user.type(screen.getByTestId("req9-search"), "demo-nhi");
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId("req9-pick-count").textContent).toMatch(/^1 of 6/);
    await user.click(rows()[0]);
    expect(onSelect).toHaveBeenLastCalledWith("0000000000000a03");
    await user.clear(screen.getByTestId("req9-search"));
    await user.type(screen.getByTestId("req9-search"), "zzz-none");
    expect(screen.getByTestId("req9-list").textContent).toMatch(/No record matches/);
    await user.click(screen.getByTestId("req9-open-released-new-rid"));
    expect(onSelect).toHaveBeenLastCalledWith(RELEASE);
  }, 15000);

  it("deep link: a RequestID opens that record and its release-to-hold link", async () => {
    await page({ rid: RELEASE });
    await waitFor(() => expect(rid()).toBe(RELEASE));
    expect(screen.getByTestId("req9-linked").textContent).toMatch(/0000000000000a04.*matched by user, tool and time/);
    expect(screen.queryByTestId("req9-note")).not.toBeInTheDocument();
  }, 15000);

  it("bad id: not sent to the server, falls back to the newest with a note; an unknown valid id falls back with the server's note", async () => {
    lab = await startLab();
    const spy = vi.spyOn(globalThis, "fetch");
    const { unmount } = render(<Req9Page info={{ source: "mock" }} signal={0} rid={"<script>"} onSelect={() => {}} />);
    await screen.findByTestId("req9-coverage");
    expect(screen.getByTestId("req9-note").textContent).toMatch(/not a valid one/);
    expect(rid()).toBe(NEWEST);
    expect(spy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/api/req9"))).toEqual(["/api/req9"]);
    unmount();
    render(<Req9Page info={{ source: "mock" }} signal={0} rid="ffffffffffffffff" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("req9-note").textContent).toMatch(/ffffffffffffffff is not among the decision records read/));
    expect(rid()).toBe(NEWEST);
  }, 15000);

  it("App: #req9/<RequestID> opens the tab on that record, picking a row moves the hash, the tab shows the banner and the toggle", async () => {
    lab = await startLab();
    window.location.hash = `#req9/${RELEASE}`;
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("req9-page");
    await waitFor(() => expect(rid()).toBe(RELEASE));
    expect(screen.getByTestId("banner").textContent).toMatch(/nothing is sent/);
    expect(screen.getByTestId("mode-select")).toBeInTheDocument();
    expect(screen.getByTestId("nav-req9")).toHaveAttribute("aria-current", "page");
    await user.click(within(screen.getByTestId("req9-list")).getAllByTestId("req9-pick-row")[0]);
    await waitFor(() => expect(window.location.hash).toBe(`#req9/${NEWEST}`));
    await waitFor(() => expect(rid()).toBe(NEWEST));
  }, 20000);
});

// A FAKE gateway (only needs to exist for Real to be configured) and a FAKE console answering elasticlog like the local one does.
const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) }));
});
const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const RECORDS = [
  { _index: "policy-decision-log", _source: { "@timestamp": at(3_600_000), Data: { User: "u-real-1", PrincipalKind: "User", AgentKey: KEY, Target: "get_weather", App: "demo-mcp-app", Method: "tools/call", Decision: "deny", Event: "policy_decision", RequestID: "realreq01", PolicyIDs: ["p:1"], Reason: "r" } } },
  { _index: "policy-decision-log", _source: { "@timestamp": at(3_000_000), Data: { User: "u-real-1", PrincipalKind: "User", Target: "get_weather", App: "demo-mcp-app", Method: "tools/call", Decision: "hitl", Event: "policy_decision", RequestID: "realreq02", PolicyIDs: ["p:2"], Reason: "r" } } },
  { _index: "proxy-audit-log", _source: { "@timestamp": at(2_000_000), Data: { User: "u-real-1", Method: "POST", Path: "/demo-mcp-app/mcp" } } },
];

describe("Requirement 9 tab (Real, fake console)", () => {
  it("asks for the confirm first, then shows counts computed from the console's records, and never shows the key", async () => {
    const gw = await listen((_q, res) => { res.writeHead(200); res.end("{}"); });
    let reads = 0;
    const cons = await listen((req, res) => {
      const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => {
        reads += 1;
        const q = JSON.parse(Buffer.concat(c).toString() || "{}");
        const hits = RECORDS.slice(q.From || 0, (q.From || 0) + (q.Size || 200));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ Response: Buffer.from(JSON.stringify({ hits: { total: { value: RECORDS.length }, hits } })).toString("base64") }));
      });
    });
    try {
      lab = await startLab({ env: { STANDALONE_ENV: "/nonexistent/settings.env", PRIV_LOG_GATEWAY_URL: `${gw.base}/demo-mcp-app/mcp`, PRIV_LOG_AGENT_KEY: KEY, PRIV_LOG_CONSOLE_URL: cons.base, PRIV_LOG_CONSOLE_TENANT: ["00000000", "0000", "4000", "8000", "00000000c0de"].join("-") } });
      window.location.hash = "#req9";
      const user = userEvent.setup();
      render(<App />);
      await waitFor(() => expect(screen.getByTestId("mode-select")).toHaveValue("real"));
      await screen.findByTestId("confirm-gate");
      expect(reads).toBe(0);
      await user.click(screen.getByTestId("gate-confirm"));
      await screen.findByTestId("req9-coverage");
      expect(screen.getByTestId("req9-cov-a-count").textContent).toBe("2 / 2");
      expect(screen.getByTestId("req9-cov-b-count").textContent).toBe("1 / 2");
      expect(screen.queryByTestId("req9-mock-note")).not.toBeInTheDocument();
      expect(rid()).toBe("realreq02");
      expect(document.body.textContent.includes(KEY)).toBe(false);
      expect(screen.getByTestId("req9-row-plain-allowed")).toHaveAttribute("data-found", "true");
      await user.selectOptions(screen.getByTestId("mode-select"), "mock");
      await waitFor(() => expect(screen.getByTestId("req9-cov-a-count").textContent).toBe("8 / 8"));
    } finally { await gw.close(); await cons.close(); }
  }, 20000);
});
