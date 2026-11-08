// The Privilege -> Elasticsearch explorer against the real lab server in Mock (the recorded sample): filters, custom range, chart zoom,
// table/JSON, related records, export and the Kibana link.
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PrivilegePage, { toUtcInput } from "./components/PrivilegePage";
import { csvCell, toCsv } from "./lib/privExport";
import { KEY, startLab } from "./testServer";

let lab;
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await lab?.close(); lab = null; });

const page = async () => {
  lab = await startLab();
  const user = userEvent.setup();
  render(<PrivilegePage info={{ source: "mock" }} signal={0} />);
  await screen.findByTestId("priv-table");
  return user;
};
const rows = () => screen.queryAllByTestId("priv-row");
const blobText = (b) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsText(b); });
const settle = () => waitFor(() => expect(screen.queryByTestId("priv-busy")).not.toBeInTheDocument());

describe("CSV export cells", () => {
  it("quotes every cell, doubles quotes, and defuses formula starts", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    for (const v of ["=1+1", "+cmd", "-2", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(v).startsWith(`"'`)).toBe(true);
    expect(csvCell(null)).toBe('""');
    expect(csvCell("a,b\nc")).toBe('"a,b\nc"');
    const csv = toCsv([{ at: "2026-11-07T22:00:00.000Z", index: "audit-log", kind: "console", text: "=HYPERLINK(1)", fields: { user: "u" } }]);
    expect(csv.split("\r\n")[0]).toMatch(/^"time","index","kind","user"/);
    expect(csv).toContain(`"'=HYPERLINK(1)"`);
  });
});

describe("Privilege -> Elasticsearch explorer (Mock)", () => {
  it("filters narrow the table and the counts; free text searches the record; Clear brings everything back", async () => {
    const user = await page();
    expect(rows()).toHaveLength(8);
    expect(screen.getByTestId("priv-count-total").textContent).toBe("8");
    expect(screen.getByTestId("priv-count-hitl").textContent).toBe("4");
    expect(screen.getByTestId("priv-count-aiguard").textContent).toMatch(/mcp_response_blocked 1/);
    expect(screen.getByTestId("priv-clock").textContent).toMatch(/end of the recording/);
    await user.selectOptions(screen.getByTestId("priv-decision"), "deny");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].textContent).toMatch(/GenericOpenSearchApiTool/);
    expect(screen.getByTestId("priv-count-deny").textContent).toBe("1");
    await user.selectOptions(screen.getByTestId("priv-decision"), "");
    await user.selectOptions(screen.getByTestId("priv-f-tool"), "SearchIndexTool");
    await waitFor(() => expect(rows()).toHaveLength(4));
    await user.click(screen.getByTestId("priv-clear"));
    await user.type(screen.getByTestId("priv-q"), "Received HTTP");
    await user.click(screen.getByTestId("priv-q-apply"));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].textContent).toMatch(/proxy-audit-log/);
    await user.click(screen.getByTestId("priv-clear"));
    await waitFor(() => expect(rows()).toHaveLength(8));
    await user.click(screen.getByTestId("priv-range-15m"));
    await waitFor(() => expect(rows()).toHaveLength(7));
    expect(screen.getByTestId("priv-range-15m")).toHaveAttribute("aria-pressed", "true");
  }, 15000);

  it("custom range: From must be before To and within 90 days; a valid range shows only its records", async () => {
    const user = await page();
    await user.click(screen.getByTestId("priv-range-custom"));
    const from = screen.getByTestId("priv-from"); const to = screen.getByTestId("priv-to");
    fireEvent.change(from, { target: { value: toUtcInput("2026-11-04T16:00:00Z") } });
    fireEvent.change(to, { target: { value: toUtcInput("2026-11-04T15:00:00Z") } });
    await user.click(screen.getByTestId("priv-apply"));
    expect(screen.getByTestId("priv-custom-error").textContent).toMatch(/From must be before To/);
    fireEvent.change(from, { target: { value: toUtcInput("2026-07-01T00:00:00Z") } });
    fireEvent.change(to, { target: { value: toUtcInput("2026-07-02T00:00:00Z") } });
    expect(from).not.toHaveAttribute("min"); expect(to).not.toHaveAttribute("max");
    await user.click(screen.getByTestId("priv-apply"));
    expect(screen.getByTestId("priv-custom-error").textContent).toMatch(/90 days/);
    fireEvent.change(from, { target: { value: "2026-11-07T21:00" } });
    fireEvent.change(to, { target: { value: "2026-11-07T23:59" } });
    await user.click(screen.getByTestId("priv-apply"));
    expect(screen.getByTestId("priv-custom-error").textContent).toMatch(/To may not be in the future/);
    fireEvent.change(from, { target: { value: toUtcInput("2026-11-04T15:00:00Z") } });
    fireEvent.change(to, { target: { value: toUtcInput("2026-11-04T16:00:00Z") } });
    await user.click(screen.getByTestId("priv-apply"));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].textContent).toMatch(/audit-log/);
    expect(screen.getByTestId("priv-range-custom")).toHaveAttribute("aria-pressed", "true");
  });

  it("the custom picker is in UTC, like the rest of the page: it opens on the shown range and the typed time is read as UTC", async () => {
    const user = await page();
    await user.click(screen.getByTestId("priv-range-custom"));
    expect(screen.getByTestId("priv-from").value).toBe("2026-11-07T21:20");
    expect(screen.getByTestId("priv-to").value).toBe("2026-11-07T22:20");
    expect(screen.getByTestId("priv-custom").textContent).toMatch(/From \(UTC\).*To \(UTC\)/);
    fireEvent.change(screen.getByTestId("priv-from"), { target: { value: "2026-11-04T15:00" } });
    fireEvent.change(screen.getByTestId("priv-to"), { target: { value: "2026-11-04T16:00" } });
    await user.click(screen.getByTestId("priv-apply"));
    await waitFor(() => expect(screen.getByTestId("priv-summary").textContent).toMatch(/2026-11-04 15:00:00Z to 2026-11-04 16:00:00Z/));
    expect(toUtcInput("2026-11-04T15:07:00.000Z")).toBe("2026-11-04T15:07");
  });

  it("only chart bars with entries are buttons and tab stops; at 1 minute per bar a single bar does not zoom and the caption says why", async () => {
    const user = await page();
    await user.click(screen.getByTestId("priv-range-90d"));
    await waitFor(() => expect(rows()).toHaveLength(9));
    const chart = screen.getByTestId("priv-chart");
    const all = chart.querySelectorAll("[data-testid^=priv-bar-]");
    const full = [...all].filter((b) => Number(b.getAttribute("data-count")) > 0);
    expect(all.length).toBeGreaterThan(full.length);
    expect(within(chart).getAllByRole("button")).toHaveLength(full.length);
    expect(chart.querySelectorAll("[tabindex]")).toHaveLength(full.length);
    // a 1-minute range
    await user.click(screen.getByTestId("priv-range-custom"));
    fireEvent.change(screen.getByTestId("priv-from"), { target: { value: "2026-11-07T22:16" } });
    fireEvent.change(screen.getByTestId("priv-to"), { target: { value: "2026-11-07T22:17" } });
    await user.click(screen.getByTestId("priv-apply"));
    await waitFor(() => expect(screen.getByTestId("priv-summary").textContent).toMatch(/22:16:00Z to 2026-11-07 22:17:00Z/));
    const one = screen.getByTestId("priv-chart");
    expect(one.querySelectorAll("[data-testid^=priv-bar-]")).toHaveLength(1);
    expect(Number(screen.getByTestId("priv-bar-0").getAttribute("data-count"))).toBeGreaterThan(0);
    expect(within(one).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByTestId("priv-chart-caption").textContent).toMatch(/1 minute is the finest step/);
    expect(screen.getByTestId("priv-chart-caption").textContent).not.toMatch(/Click a bar/);
  });

  it("clicking a bar narrows the range to that bucket", async () => {
    const user = await page();
    await user.click(screen.getByTestId("priv-range-7d"));
    await waitFor(() => expect(rows()).toHaveLength(9));
    const bars = within(screen.getByTestId("priv-chart")).getAllByRole("button");
    const hit = bars.find((b) => Number(b.getAttribute("data-count")) === 1 && /2026-11-04/.test(b.getAttribute("aria-label")));
    expect(hit).toBeTruthy();
    await user.click(hit);
    await settle();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].textContent).toMatch(/audit-log/);
    expect(screen.getByTestId("priv-range-custom")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("priv-summary").textContent).toMatch(/2026-11-04/);
  });

  it("the table is the default; JSON shows the colour view of the same entries", async () => {
    const user = await page();
    expect(screen.getByTestId("priv-view-table")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("priv-lines")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("priv-view-json"));
    expect(within(screen.getByTestId("priv-lines")).getAllByTestId("entry-item")).toHaveLength(8);
    expect(screen.queryByTestId("priv-table")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("priv-view-table"));
    expect(screen.getByTestId("priv-table")).toBeInTheDocument();
  });

  it("a row opens Related records: the decision, its AI Guard record (request id) and the HTTP record (its trace id), each with index and kind", async () => {
    const user = await page();
    await user.click(screen.getByRole("button", { name: /Related records for the policy-decision-log entry at 2026-11-07 22:16:54Z/ }));
    const panel = await screen.findByTestId("priv-related");
    const items = await within(panel).findAllByTestId("priv-related-item");
    expect(items.map((i) => i.textContent.match(/(policy-decision-log|aiguard-log|proxy-audit-log)/)[1])).toEqual(["proxy-audit-log", "policy-decision-log", "aiguard-log"]);
    expect(items[0].textContent).toMatch(/runtime.*linked through another related record/);
    expect(items[2].textContent).toMatch(/shares request id/);
    await user.click(within(panel).getByTestId("priv-related-close"));
    expect(screen.queryByTestId("priv-related")).not.toBeInTheDocument();
  });

  it("Related moves focus to its heading on open and back to the row's button on Close", async () => {
    const user = await page();
    const btn = screen.getByRole("button", { name: /Related records for the policy-decision-log entry at 2026-11-07 22:16:54Z/ });
    btn.focus();
    await user.keyboard("{Enter}");
    await screen.findAllByTestId("priv-related-item");
    expect(document.activeElement).toBe(screen.getByTestId("priv-related-heading"));
    screen.getByTestId("priv-related-close").focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("priv-related")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(btn);
  });

  it("export downloads the page and the whole filtered set as JSON and CSV", async () => {
    const blobs = [];
    globalThis.URL.createObjectURL = vi.fn((b) => { blobs.push(b); return "blob:x"; });
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const user = await page();
    await user.selectOptions(screen.getByTestId("priv-kind"), "runtime");
    await waitFor(() => expect(rows()).toHaveLength(7));
    await user.click(screen.getByTestId("priv-export-page-csv"));
    await waitFor(() => expect(blobs).toHaveLength(1));
    const csv = await blobText(blobs[0]);
    expect(csv.trim().split("\r\n")).toHaveLength(8);
    await user.click(screen.getByTestId("priv-export-all-json"));
    await waitFor(() => expect(blobs).toHaveLength(2));
    const j = JSON.parse(await blobText(blobs[1]));
    expect(j.entries).toHaveLength(7); expect(j.filters).toEqual({ kind: "runtime" }); expect(j.label).toBe("recorded shapes, placeholder values");
    expect(screen.getByTestId("priv-export-status").textContent).toMatch(/7 entries as JSON/);
  });

  it("Open in Kibana carries the range and the filters as KQL, with the port-forward hint", async () => {
    const user = await page();
    await user.selectOptions(screen.getByTestId("priv-f-app"), "demo-approval-app");
    await waitFor(() => expect(screen.getByTestId("priv-kql").textContent).toBe('privilege.app : "demo-approval-app"'));
    const href = screen.getByTestId("priv-kibana-link").getAttribute("href");
    expect(href.startsWith("http://localhost:5601/app/discover#/?_g=")).toBe(true);
    expect(decodeURIComponent(href)).toContain("time:(from:'2026-11-07T21:20:00.000Z',to:'2026-11-07T22:20:00.000Z')");
    expect(decodeURIComponent(href)).toContain(`query:'privilege.app : "demo-approval-app"'`);
    expect(screen.getByTestId("priv-kibana-link")).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByTestId("priv-kibana-hint").textContent).toMatch(/port-forward svc\/kibana-siem 5601:5601/);
  });
});

describe("Privilege tab in Real before the confirmation", () => {
  it("asks for the confirmation once and does not re-read in a loop when the parent re-renders with a new callback", async () => {
    // Real configured on loopback ports nothing listens on: a 412 comes back before any outbound call.
    lab = await startLab({ env: { STANDALONE_ENV: "/nonexistent/settings.env", PRIV_LOG_GATEWAY_URL: "http://127.0.0.1:9/mcp", PRIV_LOG_AGENT_KEY: KEY, PRIV_LOG_CONSOLE_URL: "http://127.0.0.1:9", PRIV_LOG_CONSOLE_TENANT: "00000000-0000-4000-8000-00000000c0de" } });
    const mode = await (await fetch("/api/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "real" }) })).json();
    expect(mode.source).toBe("real");
    const inner = globalThis.fetch; let reads = 0;
    globalThis.fetch = (u, o) => { if (String(u).startsWith("/api/privilege-logs")) reads += 1; return inner(u, o); };
    let asks = 0;
    // Like App: every ask sets new state and passes a fresh inline callback.
    function Parent() {
      const [, setGate] = useState(null);
      return <PrivilegePage info={{ source: "real", real: {} }} signal={0} onConfirmNeeded={() => { asks += 1; setGate({ queue: [] }); }} />;
    }
    render(<Parent />);
    await screen.findByTestId("priv-error");
    await new Promise((r) => setTimeout(r, 600));
    expect(reads).toBe(1);
    expect(asks).toBe(1);
    globalThis.fetch = inner;
  });
});
