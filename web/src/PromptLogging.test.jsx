import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App, { TABS } from "./App";
import PromptLoggingPage, { BANNER_PROMPTS } from "./components/PromptLoggingPage";
import { SAMPLES } from "./lib/promptSamples";
import { startLab } from "./testServer";

// Spec: docs/specs/2026-11-24-prompt-logging-crypto-demo.md. Real cryptography, no mocks of the crypto.
let lab;
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await lab?.close(); lab = null; window.location.hash = ""; });
beforeEach(() => { window.location.hash = ""; });

const generate = async (user) => { await user.click(screen.getByTestId("pl-generate")); await screen.findByTestId("pl-fresh"); };
const seal = async (user) => { await user.click(screen.getByTestId("pl-seal")); await screen.findByTestId("pl-records"); };
const recordButtons = () => within(screen.getByTestId("pl-records")).getAllByRole("button");

describe("Prompt logging tab: the happy path", () => {
  it("generate a key pair, seal a sample, open it with the key, and see the plaintext only after opening", async () => {
    const user = userEvent.setup();
    render(<PromptLoggingPage />);
    await generate(user);
    const pub = JSON.parse(screen.getByTestId("pl-public").value);
    expect(pub).toMatchObject({ kty: "OKP", crv: "X25519" });
    expect("d" in pub).toBe(false);
    expect(JSON.parse(screen.getByTestId("pl-private-shown").textContent).d).toBeTruthy();

    await seal(user);
    const sealedPane = screen.getByTestId("pl-sealed").textContent;
    expect(sealedPane).toContain("ciphertext");
    expect(sealedPane).not.toContain("alice@example.com"); // the content is not in the sealed record
    expect(screen.queryByTestId("pl-opened")).toBeNull();

    await user.click(screen.getByTestId("pl-use-key"));
    await user.click(screen.getByTestId("pl-open"));
    const out = await screen.findByTestId("pl-opened");
    expect(within(out).getByTestId("pl-plaintext").textContent).toBe(SAMPLES[0].text);
    expect(out.textContent).toMatch(/OPENED IN THIS TAB/);
  });

  it("the SIEM pane shows the metadata and the request id and no content, ciphertext or key material", async () => {
    const user = userEvent.setup();
    render(<PromptLoggingPage />);
    await generate(user); await seal(user);
    const siem = JSON.parse(screen.getByTestId("pl-siem").textContent);
    expect(Object.keys(siem)).toEqual(expect.arrayContaining(["requestId", "id", "surface", "kind", "user", "agentKey", "decision", "kid"]));
    for (const k of ["enc", "ciphertext", "content", "text"]) expect(k in siem).toBe(false);
    expect(screen.getByTestId("pl-siem").textContent).not.toContain("alice@example.com");
    expect(screen.getByTestId("pl-siem-note").textContent).toMatch(/No content/);
  });

  it("every sample seals and opens back to its own text", async () => {
    const user = userEvent.setup();
    render(<PromptLoggingPage />);
    await generate(user);
    for (const s of SAMPLES) {
      await user.selectOptions(screen.getByTestId("pl-sample"), s.id);
      await seal(user);
      await user.click(screen.getByTestId("pl-use-key"));
      await user.click(screen.getByTestId("pl-open"));
      expect((await screen.findByTestId("pl-plaintext")).textContent).toBe(s.text);
    }
  });

  it("the size limit truncates and the record and the opened text say so", async () => {
    const user = userEvent.setup();
    render(<PromptLoggingPage />);
    await generate(user);
    await user.type(screen.getByTestId("pl-max"), "10");
    await seal(user);
    expect(recordButtons()[0].textContent).toMatch(/TRUNCATED/);
    await user.click(screen.getByTestId("pl-use-key"));
    await user.click(screen.getByTestId("pl-open"));
    const out = await screen.findByTestId("pl-opened");
    expect(out.textContent).toMatch(/TRUNCATED: \d+ bytes were cut/);
    expect(within(out).getByTestId("pl-plaintext").textContent).toBe(SAMPLES[0].text.slice(0, 10));
  });
});

describe("Prompt logging tab: failures are shown, not hidden", () => {
  it("rotation: a record sealed under key 1 is refused by key 2 (its id is named) and still opens with key 1", async () => {
    const user = userEvent.setup();
    render(<PromptLoggingPage />);
    await generate(user); await seal(user); // sealed to key 1
    const firstKid = screen.getByTestId("pl-needs-kid").textContent;
    await generate(user); // rotate: key 2 is now the current key and the one shown
    expect(screen.getByTestId("pl-rotation").textContent).toMatch(/2 keys/);
    const key2 = screen.getByTestId("pl-private-shown").textContent;
    await user.click(screen.getByTestId("pl-private")); await user.paste(key2);
    await user.click(screen.getByTestId("pl-open"));
    expect((await screen.findByTestId("pl-err-code")).textContent).toBe("KID_MISMATCH");
    expect(screen.getByTestId("pl-err-open").textContent).toContain(firstKid);
    await user.click(screen.getByTestId("pl-use-key")); // finds key 1 by its id
    await user.click(screen.getByTestId("pl-open"));
    expect((await screen.findByTestId("pl-plaintext")).textContent).toBe(SAMPLES[0].text);
  });

  it("tampering is caught and the record is marked", async () => {
    const user = userEvent.setup();
    render(<PromptLoggingPage />);
    await generate(user); await seal(user);
    await user.click(screen.getByTestId("pl-tamper"));
    expect(recordButtons()[0].textContent).toMatch(/TAMPERED/);
    await user.click(screen.getByTestId("pl-use-key"));
    await user.click(screen.getByTestId("pl-open"));
    expect((await screen.findByTestId("pl-err-code")).textContent).toBe("OPEN_FAILED");
    expect(screen.queryByTestId("pl-opened")).toBeNull();
  });

  it("a private key pasted into the public box is refused", async () => {
    const user = userEvent.setup();
    render(<PromptLoggingPage />);
    await generate(user);
    const priv = screen.getByTestId("pl-private-shown").textContent;
    await user.clear(screen.getByTestId("pl-public")); await user.click(screen.getByTestId("pl-public")); await user.paste(priv);
    await user.click(screen.getByTestId("pl-seal"));
    expect((await screen.findByTestId("pl-err-seal")).textContent).toMatch(/PRIVATE_IN_PUBLIC/);
    expect(screen.queryByTestId("pl-records")).toBeNull();
  });

  it("no public key, an empty prompt and a limit above the maximum each give a named error and make no record", async () => {
    const user = userEvent.setup();
    render(<PromptLoggingPage />);
    await user.click(screen.getByTestId("pl-seal"));
    expect((await screen.findByTestId("pl-err-seal")).textContent).toMatch(/BAD_PUBLIC_KEY/);
    await generate(user);
    await user.clear(screen.getByTestId("pl-content"));
    await user.click(screen.getByTestId("pl-seal"));
    await waitFor(() => expect(screen.getByTestId("pl-err-seal").textContent).toMatch(/EMPTY/));
    await user.type(screen.getByTestId("pl-content"), "something");
    await user.type(screen.getByTestId("pl-max"), "999999");
    await user.click(screen.getByTestId("pl-seal"));
    await waitFor(() => expect(screen.getByTestId("pl-err-seal").textContent).toMatch(/BAD_SIZE/));
    expect(screen.queryByTestId("pl-records")).toBeNull();
  });

  it("a double click on Seal makes one record, not two", async () => {
    const user = userEvent.setup();
    render(<PromptLoggingPage />);
    await generate(user);
    await user.dblClick(screen.getByTestId("pl-seal"));
    await screen.findByTestId("pl-records");
    await new Promise((r) => setTimeout(r, 50));
    expect(recordButtons()).toHaveLength(1);
  });

  it("Close and forget empties the private box, the opened text and the keys; records stay sealed", async () => {
    const user = userEvent.setup();
    render(<PromptLoggingPage />);
    await generate(user); await seal(user);
    await user.click(screen.getByTestId("pl-use-key")); await user.click(screen.getByTestId("pl-open"));
    await screen.findByTestId("pl-opened");
    await user.click(screen.getByTestId("pl-forget"));
    expect(screen.getByTestId("pl-private")).toHaveValue("");
    expect(screen.queryByTestId("pl-opened")).toBeNull();
    expect(screen.queryByTestId("pl-fresh")).toBeNull();
    expect(recordButtons()).toHaveLength(1);
    await user.click(screen.getByTestId("pl-use-key")); // no key made in this tab any more
    expect((await screen.findByTestId("pl-err-code")).textContent).toBe("NO_KEY");
  });
});

describe("Prompt logging tab: nothing leaves the page", () => {
  it("no network call, no storage write and no console output holds a key or the plaintext", async () => {
    const user = userEvent.setup();
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const logs = ["log", "info", "warn", "error", "debug"].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    window.localStorage.clear(); window.sessionStorage.clear();
    render(<PromptLoggingPage />);
    await generate(user); await seal(user);
    const d = JSON.parse(screen.getByTestId("pl-private-shown").textContent).d;
    await user.click(screen.getByTestId("pl-use-key")); await user.click(screen.getByTestId("pl-open"));
    await screen.findByTestId("pl-opened");
    expect(f).not.toHaveBeenCalled();
    for (const store of [window.localStorage, window.sessionStorage]) {
      const all = JSON.stringify(Object.fromEntries(Array.from({ length: store.length }, (_, i) => [store.key(i), store.getItem(store.key(i))])));
      expect(all).not.toContain(d); expect(all).not.toContain("alice@example.com");
    }
    expect(window.location.hash).not.toContain(d);
    for (const l of logs) expect(l).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("copy that the browser blocks says so instead of failing silently", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } });
    render(<PromptLoggingPage />);
    await generate(user);
    await user.click(screen.getByText("Copy public key"));
    expect(await screen.findByText(/Copy is blocked here/)).toBeInTheDocument();
  });
});

describe("Prompt logging tab inside the app", () => {
  it("is a tab, with its own honest banner (real cryptography, sample prompts) and the other tabs keep theirs", async () => {
    expect(TABS.map((t) => t.id)).toContain("prompts");
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    expect(screen.getByTestId("banner").textContent).toMatch(/Replay of transactions measured on 2026-11-07; nothing is sent\./);
    await user.click(screen.getByTestId("nav-prompts"));
    expect(await screen.findByTestId("pl-page")).toBeInTheDocument();
    expect(screen.getByTestId("banner").textContent).toBe(BANNER_PROMPTS);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/Prompt logging/);
    expect(window.location.hash).toBe("#prompts");
    await user.click(screen.getByTestId("nav-run"));
    expect(screen.getByTestId("banner").textContent).toMatch(/Replay of transactions/);
  });
});

describe("Prompt logging tab: review fixes", () => {
  it("a key id that was already made in this tab is refused", async () => {
    const user = userEvent.setup();
    render(<PromptLoggingPage />);
    await user.type(screen.getByTestId("pl-kid"), "k1"); await generate(user);
    await user.type(screen.getByTestId("pl-kid"), "k1");
    await user.click(screen.getByTestId("pl-generate"));
    expect((await screen.findByTestId("pl-err-keys")).textContent).toMatch(/DUPLICATE_KID/);
    expect(screen.queryByTestId("pl-rotation")).toBeNull(); // still one key
    await user.clear(screen.getByTestId("pl-kid")); await user.type(screen.getByTestId("pl-kid"), "k2");
    await user.click(screen.getByTestId("pl-generate"));
    await waitFor(() => expect(screen.getByTestId("pl-rotation").textContent).toMatch(/2 keys/));
  });

  it("Flip one byte works once: the button is disabled afterwards, so the record cannot be flipped back to a valid one while labelled TAMPERED", async () => {
    const user = userEvent.setup();
    render(<PromptLoggingPage />);
    await generate(user); await seal(user);
    await user.click(screen.getByTestId("pl-tamper"));
    expect(screen.getByTestId("pl-tamper")).toBeDisabled();
    await user.click(screen.getByTestId("pl-tamper")); // a second click does nothing
    await user.click(screen.getByTestId("pl-use-key")); await user.click(screen.getByTestId("pl-open"));
    expect((await screen.findByTestId("pl-err-code")).textContent).toBe("OPEN_FAILED");
    expect(recordButtons()[0].textContent).toMatch(/TAMPERED/);
  });

  it("each Copied note appears only next to its own control and is cleared by the next action", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<PromptLoggingPage />);
    await generate(user);
    await user.click(screen.getByText("Copy private key"));
    await waitFor(() => expect(screen.getByTestId("pl-note-private").textContent).toMatch(/Copied\. It stays on your clipboard/));
    expect(screen.getByTestId("pl-note-public").textContent).toBe("");
    await user.click(screen.getByText("Copy public key"));
    await waitFor(() => expect(screen.getByTestId("pl-note-public").textContent).toBe("Copied."));
    expect(screen.getByTestId("pl-note-private").textContent).toBe("");
    await seal(user); // the next action clears it
    expect(screen.getByTestId("pl-note-public").textContent).toBe("");
    expect(writeText).toHaveBeenCalledTimes(2);
  });
});

describe("Prompt logging tab inside the app: no server needed", () => {
  it("works with the lab server down: the tab renders and the banner is its own; the other tabs say the lab could not load", async () => {
    window.location.hash = "#prompts";
    vi.stubGlobal("fetch", () => Promise.reject(new Error("down")));
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByTestId("pl-page")).toBeInTheDocument();
    expect(screen.getByTestId("banner").textContent).toBe(BANNER_PROMPTS);
    await generate(user); await seal(user); // the whole flow runs with no server
    await user.click(screen.getByTestId("nav-run"));
    expect(await screen.findByText(/Could not load the lab/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("the 'Real is unavailable' hint shows on the other tabs and not above the Prompt logging banner", async () => {
    lab = await startLab();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("run-page");
    expect(screen.getByTestId("real-hint")).toBeInTheDocument();
    await user.click(screen.getByTestId("nav-prompts"));
    await screen.findByTestId("pl-page");
    expect(screen.queryByTestId("real-hint")).toBeNull();
  });
});
