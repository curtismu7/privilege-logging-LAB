import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API runs on PORT (default 7801, npm start). Vite runs on VITE_PORT (a dev-only port, default 5299) and proxies /api,
// so the browser only ever talks to one origin (same-origin writes). The one published/host port of this app is 7801.
const api = { target: `http://127.0.0.1:${Number(process.env.PORT) || 7801}` };

export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: Number(process.env.VITE_PORT) || 5299, strictPort: false, proxy: { "/api": api } },
  test: { environment: "jsdom", globals: true, setupFiles: "./src/testSetup.js" },
});
