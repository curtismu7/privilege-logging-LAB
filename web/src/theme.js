// Theme picker (auto / light / dark). Sets data-theme on <html>; the shared stylesheet's tokens do the rest.
// Storage can be blocked, so every access is guarded and the page works without it.
const KEY = "privlog.theme";
export const THEMES = ["auto", "light", "dark"];

export function savedTheme() {
  try { const v = window.localStorage.getItem(KEY); return THEMES.includes(v) ? v : "auto"; } catch { return "auto"; }
}
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme); else root.removeAttribute("data-theme");
  try { window.localStorage.setItem(KEY, theme); } catch { /* blocked */ }
}
