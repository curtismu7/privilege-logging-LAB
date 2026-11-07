// Test helper: runs the real lab server in its own process (the jsdom test environment cannot import it directly) and prints its URL.
// LAB_ENV is a JSON object of settings (never the developer's own); the app is created exactly as in production, on an ephemeral loopback port.
import { createApp, startHttpServer } from "../../server/src/app.js";
import { createHealth } from "../../server/src/health.js";

const env = JSON.parse(process.env.LAB_ENV || "{}");
const opts = JSON.parse(process.env.LAB_OPTS || "{}");
const health = createHealth({ intervalMs: 3_600_000 });
await health.ready;
const { url } = await startHttpServer({ port: 0, host: "127.0.0.1", app: createApp({ health, env, useSettingsFile: false, ...opts }) });
console.log(`URL ${url}`);
