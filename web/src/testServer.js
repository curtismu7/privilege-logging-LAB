// The web tests talk to the REAL lab server (a child process on loopback), so the UI is checked against the real API, not a copy of it.
import { spawn } from "node:child_process";
import path from "node:path";

export const KEY = "test-agent-key-NOT-REAL-7f3a91c2";
export async function startLab({ env = { STANDALONE_ENV: "/nonexistent/settings.env" } } = {}) {
  const child = spawn(process.execPath, [path.resolve(process.cwd(), "src/labProcess.mjs")], { env: { PATH: process.env.PATH, LAB_ENV: JSON.stringify(env) }, stdio: ["ignore", "pipe", "inherit"] });
  const base = await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; const m = /URL (http:\/\/127\.0\.0\.1:\d+)\//.exec(buf); if (m) resolve(m[1]); });
    child.once("exit", (code) => reject(new Error(`lab process exited early (${code})`)));
    setTimeout(() => reject(new Error("lab process did not start")), 15000);
  });
  const realFetch = globalThis.fetch;
  // The page calls relative URLs; send them to the lab process and add the same-origin header a browser would.
  globalThis.fetch = (u, o = {}) => realFetch(new URL(String(u), base), { ...o, headers: { origin: base, ...(o.headers || {}) } });
  return { base, close: async () => { globalThis.fetch = realFetch; child.removeAllListeners("exit"); child.kill(); } };
}
