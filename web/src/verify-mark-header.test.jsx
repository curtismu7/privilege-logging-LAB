import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import App from "./App";
import { startLab } from "./testServer";

// The header shows this lab's own Verified / In progress mark, read from the same /api/shelf call the Shelf link makes (through the lab-proxy that
// call reaches the shelf, whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
let lab;
afterEach(async () => { cleanup(); await lab?.close(); window.location.hash = ""; });
beforeEach(() => { window.location.hash = ""; });

const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });
function withShelf(payload) {
  const real = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url) === "/api/shelf" ? Promise.resolve(new Response(JSON.stringify(payload))) : real(url, init));
  return () => { globalThis.fetch = real; };
}

describe("verification mark in the header", () => {
  it("shows this lab's own mark beside the Shelf link, and no other lab's", async () => {
    lab = await startLab();
    const restore = withShelf({ shelfUrl: "http://shelf.example", demos: [{ id: "other-lab", verification: mark("in-progress", "In progress") }, { id: "privilege-logging-lab", verification: mark("verified", "Verified", { note: "Every case replayed on the mock" }) }] });
    try {
      render(<App />);
      const bar = within(await screen.findByTestId("top-menu"));
      expect(await bar.findByText("Verified")).toBeInTheDocument();
      await waitFor(() => expect(document.querySelector("a.shelf-link")).not.toBeNull()); // the lab's own ShelfLink (TopMenu also has its own Shelf button: pre-existing)
      expect(bar.queryByText("In progress")).toBeNull();
      expect(document.querySelectorAll(".verify")).toHaveLength(1);
      expect(bar.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("Every case replayed on the mock"));
    } finally { restore(); }
  });

  it("shows nothing when the lab is opened on its own port (its /api/shelf has no demos) or the shelf has no mark for it", async () => {
    lab = await startLab();
    for (const payload of [{ shelfUrl: "http://shelf.example" }, { shelfUrl: "http://shelf.example", demos: [{ id: "privilege-logging-lab", verification: null }] }]) {
      const restore = withShelf(payload);
      try {
        const { unmount } = render(<App />);
        const bar = within(await screen.findByTestId("top-menu"));
        await waitFor(() => expect(document.querySelector("a.shelf-link")).not.toBeNull()); // the shelf answered, and still no badge
        expect(document.querySelector(".verify")).toBeNull();
        unmount();
      } finally { restore(); }
    }
  });

  it("the header renders VerifyMark with this lab's shelf id (removing the line fails the first test above)", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src", "App.jsx"), "utf8");
    expect(src).toMatch(/<VerifyMark id="privilege-logging-lab" \/>/);
    expect(JSON.parse(fs.readFileSync(path.join(process.cwd(), "..", "docs", "shelf-entry.json"), "utf8")).demos[0].id).toBe("privilege-logging-lab");
  });
});
