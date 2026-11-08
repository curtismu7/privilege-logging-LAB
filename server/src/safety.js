// Safety rules. Pure functions plus two tiny middlewares. No I/O.
//  1. Loopback bind only unless PRIV_LOG_BIND is set on purpose.
//  2. Host header must be a loopback name (DNS-rebinding defence).
//  3. A write must be same-origin: a cross-origin Origin, or a cross-site Sec-Fetch-Site, is refused.
//  4. Every host in any shipped text is reserved (.invalid / .example / apex of example.com|net|org).
//  5. The one port is 7801 (allocated 2026-11-07, demo-shelf-LAB registry row pending owner) and never one of the forbidden ones.
//  6. Every key-looking string is an obviously fake sk-MOCK- value.

export function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(h);
}

export function bindHost(env = process.env) { return env.PRIV_LOG_BIND || '127.0.0.1'; }

export function assertBindAllowed(host, env = process.env) {
  if (isLoopbackHost(host) || env.PRIV_LOG_BIND) return host;
  throw new Error(`refusing to bind ${host}: loopback only. Set PRIV_LOG_BIND to opt in.`);
}

export const PORT_MIN = 7801;
export const PORT_MAX = 7801;
export const DEFAULT_PORT = 7801;
const FORBIDDEN_PORTS = new Set([8080, 5173, 3900, 4000, 4400, 4510, 4600, 4601, 4840, 18080, 19080, 19090]);
export function portProblem(port) {
  if (!Number.isInteger(port)) return 'PORT is not an integer';
  if (FORBIDDEN_PORTS.has(port)) return `port ${port} is reserved for something else`;
  if (port < PORT_MIN || port > PORT_MAX) return `port ${port} is not this app's allocated port ${PORT_MIN}`;
  return null;
}
export function resolvePort(env = process.env) {
  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_PORT : Number(env.PORT);
  const problem = portProblem(port);
  if (problem) throw new Error(problem);
  return port;
}

export function isReservedHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return /(^|\.)(invalid|example)$/.test(h);
}

const NETWORK_URL = /\b(?:https?|wss?|ftp|sftp|ssh|smtp|tcp|udp):\/\/([^\s/?#"'<>\\()]+)/gi; // ( and ) never belong to an authority: a URL in parentheses must not swallow the ")"
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const stripAuthority = (a) => a.replace(/^[^@]*@/, '').replace(/:\d+$/, '');

// Every hostname or IP in text that is not reserved. Loopback names in URLs are allowed. Empty = clean.
export function scanHosts(text) {
  const found = new Set();
  const s = String(text);
  for (const m of s.matchAll(NETWORK_URL)) found.add(stripAuthority(m[1]).toLowerCase());
  for (const m of s.matchAll(EMAIL)) found.add(m[1].toLowerCase());
  for (const m of s.matchAll(IPV4)) found.add(m[0]);
  return [...found].filter((h) => !isReservedHost(h) && !isLoopbackHost(h)).sort();
}

// Any "sk-" secret that is not an obviously fake sk-MOCK- value. Empty = clean.
export function scanKeys(text) {
  return [...String(text).matchAll(/\bsk-(?!MOCK-)[A-Za-z0-9_-]{8,}/g)].map((m) => `${m[0].slice(0, 8)}...`);
}

// Free text from a caller (custodian, description): control characters stripped, length capped. Rendered as text, never as markup.
export function cleanText(value, max = 80) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').trim().slice(0, max);
}

// Extra Host names this lab answers to (family standard): LAB_ALLOWED_HOSTS, comma separated
// validated host names that point at this Mac, such as local.ping-devops.com. Loopback always works.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
export function allowedExtraHosts(env = process.env) {
  const extra = String(env.LAB_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const h of extra) if (!HOSTNAME.test(h)) throw new Error(`LAB_ALLOWED_HOSTS: not a host name: ${h}`);
  return new Set(extra);
}

export function hostCheck(req, res, next) {
  const raw = String(req.headers.host || '');
  const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.replace(/:\d+$/, '');
  if (!isLoopbackHost(host) && !allowedExtraHosts().has(host.toLowerCase())) {
    return res.status(403).json({ error: 'bad_host', message: 'Host must be loopback or on LAB_ALLOWED_HOSTS' });
  }
  next();
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export function sameOriginWrites(req, res, next) {
  if (!WRITE.has(req.method)) return next();
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'cross_origin', message: 'writes must be same-origin' });
  const origin = req.headers.origin;
  if (origin) {
    // Behind the shared lab-proxy the browser origin is local.ping-devops.com:8443 while Host is the lab's
    // own name: trust X-Forwarded-Host, which only the proxy sets, when it is there.
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
    let ok = false;
    try { ok = new URL(origin).host.toLowerCase() === host; } catch { /* malformed */ }
    if (!ok) return res.status(403).json({ error: 'cross_origin', message: 'writes must be same-origin' });
  }
  next();
}

// SSRF guard helpers. A non-loopback destination must not be a private, link-local, metadata, CGNAT, multicast or reserved address.
// Loopback is separate (isLoopbackHost): a loopback gateway is allowed on purpose, so the Real client checks loopback first.
const v4 = (s) => { const p = s.split('.').map(Number); return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null; };
export function isPrivateAddress(ip) {
  const text = String(ip).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  const a = v4(mapped ? mapped[1] : text);
  if (a) {
    const [x, y] = a;
    return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31)
      || (x === 192 && y === 0 && a[2] === 0) || (x === 192 && y === 168) || (x === 198 && (y === 18 || y === 19)) || x >= 224;
  }
  if (!text.includes(':')) return false; // a name, not an address
  if (text === '::' || text === '::1') return true;
  const g = v6groups(text);
  if (!g) return true; // not a parsable IPv6 literal: refuse rather than guess
  const [first, second] = g;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00
    || (first === 0x64 && second === 0xff9b) // NAT64
    || first === 0x2002 // 6to4: carries an IPv4 address (2002:a9fe:a9fe:: is 169.254.169.254); deprecated, refused outright
    || (first === 0x2001 && second === 0) // Teredo
    || g.slice(0, 5).every((n) => n === 0); // ::/80: IPv4-compatible (::a9fe:a9fe), IPv4-mapped (::ffff:...) and ::, ::1
}
// Eight 16-bit groups of an IPv6 literal (with :: expanded and a dotted IPv4 tail converted), or null when it does not parse.
function v6groups(text) {
  let t = text;
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
  if (tail) { const q = v4(tail[2]); if (!q) return null; t = `${tail[1]}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`; }
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const part = (s) => (s ? s.split(':') : []);
  const head = part(halves[0]); const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 2 && fill < 1)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...rest];
  if (all.length !== 8 || !all.every((x) => /^[0-9a-f]{1,4}$/.test(x))) return null;
  return all.map((x) => parseInt(x, 16));
}
