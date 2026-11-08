import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import JsonTree, { FieldLegend } from "./components/JsonTree";
import LogEntries from "./components/LogEntries";
import { buildNodes, MAX_DEPTH, MAX_NODES, STR_CAP, visibleRows, defaultExpanded } from "./lib/jsonTree";
import { parseLogLine } from "./lib/logEntry";
import { redactText } from "./lib/clipboard";

afterEach(cleanup);
const entry = { time: "2026-11-07T10:00:00Z", level: "info", n: 42, ok: true, gone: null, nested: { a: [1, "two"] }, msg: "Access token found for user: u-1, client: lab-agent-key" };

describe("logEntry parsing", () => {
  it("logrus text becomes time, level, msg, file first, then the rest, with typed unquoted values", () => {
    const r = parseLogLine('level=info extra=5 time="2026-11-07T10:00:00Z" msg="hello \\"x\\"" file="a.go:12" flag=true');
    expect(r.kind).toBe("logrus");
    expect(Object.keys(r.value)).toEqual(["time", "level", "msg", "file", "extra", "flag"]);
    expect(r.value.msg).toBe('hello "x"'); expect(r.value.extra).toBe(5); expect(r.value.flag).toBe(true);
  });
  it("JSON records are shown as parsed, also after a text prefix; free text with key=value pairs becomes msg plus pairs; anything else is one string node, never dropped", () => {
    expect(parseLogLine('{"Event":"mcp_response_blocked","TopScore":1}').value).toEqual({ Event: "mcp_response_blocked", TopScore: 1 });
    expect(parseLogLine('Received HTTP request {"User":"u"}').value).toEqual({ _prefix: "Received HTTP request", User: "u" });
    expect(parseLogLine("[mcpgw] auth rejected: reason=token_not_found app=x").value).toEqual({ msg: "[mcpgw] auth rejected:", reason: "token_not_found", app: "x" });
    for (const t of ["just words", "", "{not json", "x=1", "}{"]) { const r = parseLogLine(t); expect(r.kind).toBe("text"); expect(r.value).toBe(t); }
  });
  it("hostile lines finish fast: 5 MB of text, 200k pairs, deep brackets", () => {
    const t = Date.now();
    parseLogLine("a=1 ".repeat(200_000)); parseLogLine("x".repeat(5_000_000)); parseLogLine("{".repeat(100_000) + "}".repeat(100_000)); parseLogLine('a="' + "\\".repeat(100_000));
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe("tree walker caps", () => {
  it("is iterative and bounded: depth limit, node cap, child cap, and a deeply nested value cannot overflow the stack", () => {
    let deep = { v: 1 }; for (let i = 0; i < 100_000; i += 1) deep = { d: deep };
    const t0 = Date.now(); const tree = buildNodes(deep);
    expect([...tree.nodes.values()].some((n) => n.depthLimited)).toBe(true);
    expect(Math.max(...[...tree.nodes.values()].map((n) => n.depth))).toBeLessThanOrEqual(MAX_DEPTH);
    const wide = buildNodes({ list: Array.from({ length: 5000 }, (_, i) => ({ i, a: { b: [i] } })) });
    expect(wide.nodes.size).toBeLessThanOrEqual(MAX_NODES);
    expect(visibleRows(wide, new Set([...wide.nodes.keys()])).length).toBeLessThanOrEqual(MAX_NODES);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("JsonTree component", () => {
  it("renders each value type with its own class, role=tree and treeitems with aria-level", () => {
    render(<JsonTree value={entry} raw="raw" />);
    expect(screen.getByRole("tree")).toBeInTheDocument();
    const items = screen.getAllByRole("treeitem");
    expect(items[0]).toHaveAttribute("aria-level", "1"); expect(items[0]).toHaveAttribute("aria-expanded", "true");
    expect(items.some((i) => i.getAttribute("aria-level") === "3")).toBe(true);
    const types = new Set([...document.querySelectorAll(".jt__row [data-type]")].map((e) => e.getAttribute("data-type")));
    for (const t of ["string", "number", "boolean", "null"]) expect(types.has(t)).toBe(true);
    expect(document.querySelector(".jt__key")).toBeTruthy();
  });

  it("collapses and expands one node, and Collapse all / Expand all work", async () => {
    const user = userEvent.setup();
    render(<JsonTree value={entry} raw="raw" />);
    const root = screen.getAllByRole("treeitem")[0];
    await user.click(within(root).getByRole("button", { name: /Collapse entry/ }));
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    expect(screen.getAllByRole("treeitem")[0]).toHaveAttribute("aria-expanded", "false");
    await user.click(within(screen.getAllByRole("treeitem")[0]).getByRole("button", { name: /Expand entry/ }));
    const nested = screen.getAllByRole("treeitem").find((i) => i.querySelector(".jt__key")?.textContent === "nested");
    expect(nested).toHaveAttribute("aria-expanded", "true");
    await user.click(within(nested).getByRole("button", { name: /Collapse nested/ }));
    expect(screen.getAllByRole("treeitem").find((i) => i.querySelector(".jt__key")?.textContent === "nested")).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByTestId("entry-expand"));
    expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(8);
    await user.click(screen.getByTestId("entry-collapse"));
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
  });

  it("keyboard: arrows move between rows, Right expands, Left collapses and goes to the parent, Enter toggles, Home and End jump", async () => {
    const user = userEvent.setup();
    render(<JsonTree value={entry} raw="raw" />);
    const first = screen.getAllByRole("treeitem")[0]; first.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getAllByRole("treeitem")[1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getAllByRole("treeitem").at(-1));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(screen.getAllByRole("treeitem")[0]);
    await user.keyboard("{ArrowLeft}");
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    await user.keyboard("{ArrowRight}");
    expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(1);
    await user.keyboard("{Enter}");
    expect(screen.getAllByRole("treeitem")).toHaveLength(1);
    // only one row is in the tab order (roving tabindex)
    expect(screen.getAllByRole("treeitem").filter((i) => i.tabIndex === 0)).toHaveLength(1);
  });

  it("the Raw toggle shows the original line and goes back", async () => {
    const user = userEvent.setup();
    render(<JsonTree value={entry} raw={'time="x" level=info'} />);
    await user.click(screen.getByTestId("entry-raw"));
    expect(screen.getByTestId("entry-rawtext").textContent).toBe('time="x" level=info');
    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.getByTestId("entry-raw")).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByTestId("entry-raw"));
    expect(screen.getByRole("tree")).toBeInTheDocument();
  });

  it("Copy JSON copies the entry as redacted JSON and says so", async () => {
    const user = userEvent.setup(); let clip = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { clip = t; } } });
    render(<JsonTree value={{ msg: "call with Authorization: Bearer abcdefgh12345678", user: "u-1", password: "hunter2222" }} raw="" />);
    await user.click(screen.getByTestId("entry-copy"));
    const parsed = JSON.parse(clip);
    expect(parsed.user).toBe("u-1");
    expect(clip).not.toContain("abcdefgh12345678"); expect(clip).not.toContain("hunter2222");
    expect(screen.getByTestId("entry-copied").textContent).toMatch(/Copied/);
    expect(redactText("api_key=placeholdervalue")).toBe("api_key=***");
  });

  it("long strings are truncated with Show more, and a hostile 10 MB string cannot hang the render", async () => {
    const user = userEvent.setup();
    const t = Date.now();
    render(<JsonTree value={{ big: "A".repeat(10_000_000), mid: "B".repeat(STR_CAP + 50) }} raw="" />);
    const strs = screen.getAllByTestId("jt-string");
    expect(strs[0].textContent.length).toBeLessThan(STR_CAP + 10);
    expect(Date.now() - t).toBeLessThan(3000);
    await user.click(screen.getAllByRole("button", { name: /Show more/ })[1]);
    expect(screen.getAllByTestId("jt-string")[1].textContent.length).toBeGreaterThan(STR_CAP + 40);
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.getAllByTestId("jt-string")[1].textContent.length).toBeLessThan(STR_CAP + 10);
    await user.click(screen.getAllByRole("button", { name: /Show more/ })[0]);
    expect(screen.getAllByTestId("jt-string")[0].textContent.length).toBeLessThan(20_100);
    expect(screen.getByText(/cut at 20000 characters/)).toBeInTheDocument();
  });

  it("caps: a huge wide object shows 'more not shown', a deep one stops at the depth limit, and the node cap note appears", () => {
    let deep = "leaf"; for (let i = 0; i < 40; i += 1) deep = { d: deep };
    render(<JsonTree value={{ wide: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, i])), deep }} raw="" testId="caps" />);
    fireEvent.click(screen.getByTestId("caps-expand"));
    expect(screen.getByText(/200 more not shown/)).toBeInTheDocument();
    expect(screen.getByText(/depth limit reached/)).toBeInTheDocument();
    cleanup();
    render(<JsonTree value={Array.from({ length: 200 }, (_, i) => ({ a: { b: { c: [i, i, i, i, i, i, i, i, i, i] } } }))} raw="" testId="cut" />);
    expect(screen.getByTestId("jt-cut").textContent).toMatch(/more node\(s\) not shown/);
  });

  it("an XSS string, in a value, a key and a prefix, is rendered as text: no element is created", () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    render(<JsonTree value={{ [evil]: evil, arr: [evil] }} raw={evil} marks={[]} />);
    expect(document.querySelector("img")).toBeNull(); expect(document.querySelector("script")).toBeNull();
    expect(screen.getAllByTestId("jt-string")[0].textContent).toContain("<img src=x");
    expect(screen.getAllByTestId("jt-key")[0].textContent).toContain("<script>");
  });

  it("control and bidirectional characters are shown as visible escapes", () => {
    render(<JsonTree value={{ k: "a‮b\u0000c" }} raw="" />);
    expect(screen.getByTestId("jt-string").textContent).toContain("\\u202e");
  });

  it("the four requirement fields are marked in the tree with a badge and underline, and the legend names them", () => {
    render(<><FieldLegend /><JsonTree value={entry} raw="" marks={[{ field: "user", level: "met", text: "u-1", why: "w" }, { field: "agent", level: "met", text: "lab-agent-key", why: "w" }]} /></>);
    expect(screen.getByTestId("badge-user")).toBeInTheDocument(); expect(screen.getByTestId("badge-agent")).toBeInTheDocument();
    expect(screen.queryByTestId("badge-tool")).toBeNull();
    expect([...document.querySelectorAll("mark")].map((m) => `${m.dataset.field}:${m.textContent}`).sort()).toEqual(["agent:lab-agent-key", "user:u-1"]);
    expect(screen.getByTestId("field-legend").querySelectorAll(".fbadge")).toHaveLength(4);
  });
});

describe("LogEntries", () => {
  const lines = ['time="2026-11-07T10:00:00Z" level=info msg="Access token found for user: u-1, client: lab-agent-key"', '{"Event":"mcp_response_blocked","User":"u-1","Client":"lab-agent-key"}', "plain unparseable words"];
  const marks = { 0: [{ field: "user", level: "met", start: 78, end: 81, why: "x" }, { field: "agent", level: "met", start: 91, end: 101, why: "y" }], 1: [{ field: "decision", level: "met", start: 10, end: 31, why: "z" }] };
  it("every line becomes a tree (logrus, JSON, text), is tagged with how it matched, and the missing fields are listed", () => {
    render(<LogEntries lines={lines} methods={["marker", "window", "window"]} marks={marks} />);
    const items = screen.getAllByTestId("entry-item");
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByTestId("entry-method").textContent).toBe("matched by marker");
    expect(within(items[1]).getByTestId("entry-method").textContent).toMatch(/time window: inferred/);
    expect(within(items[2]).getByTestId("jt-string").textContent).toContain("plain unparseable words");
    expect(screen.getByTestId("not-present").textContent).toMatch(/Not present in this entry: Tool\./);
  });
  it("a long list shows 50 entries then 'Show all'", async () => {
    const user = userEvent.setup();
    render(<LogEntries lines={Array.from({ length: 120 }, (_, i) => `line ${i}`)} methods={[]} marks={{}} />);
    expect(screen.getAllByTestId("entry-item")).toHaveLength(50);
    await user.click(screen.getByTestId("entries-all"));
    expect(screen.getAllByTestId("entry-item")).toHaveLength(120);
  });
});
