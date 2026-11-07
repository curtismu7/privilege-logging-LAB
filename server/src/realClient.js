// The Real-mode HTTP client (owner-run). It is the ONLY code that sends anything to a configured origin, and it is deliberately small:
//   - it contacts ONLY the origins it was built with (the gateway and the optional search endpoint): any other URL is refused
//     before a socket is opened ("origin_not_allowed");
//   - https, or http on loopback only; no credentials in URLs;
//   - SSRF guard: a host NAME is resolved here and refused when any address is private, link-local, metadata, CGNAT or reserved
//     (loopback hosts excepted, on purpose, for a gateway on this machine); the checked address is the one connected to (no re-resolve);
//   - redirects are NEVER followed: a 3xx comes back as a response with `redirect: true` (so a cross-origin Location is never contacted);
//   - time cap (whole request) and body size cap (reading stops at the cap, `truncated: true`);
//   - the secrets it was given are redacted from every string it hands back (request echo, response text, error messages).
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isLoopbackHost, isPrivateAddress } from './safety.js';

export class RealError extends Error {
  constructor(code, detail, status = 502) { super(detail); this.code = code; this.detail = detail; this.status = status; }
}

export const LIMITS = { timeoutMs: 8000, maxBytes: 262_144, maxRequestBytes: 16_384 };

export function createRealClient({ origins, secrets = [], lookup = dns.lookup, timeoutMs = LIMITS.timeoutMs, maxBytes = LIMITS.maxBytes, now = Date.now } = {}) {
  const allowed = new Set(origins);
  const secretList = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  const redact = (text) => secretList.reduce((t, s) => t.split(s).join('***'), String(text));

  // dns.lookup replacement handed to the socket: validates the answer, then returns the one address it validated.
  const guardedLookup = (hostname, options, cb) => {
    const opts = typeof options === 'function' ? {} : options;
    const done = typeof options === 'function' ? options : cb;
    lookup(hostname, { all: true, ...(opts && typeof opts === 'object' ? { family: opts.family, hints: opts.hints } : {}) }, (err, addrs) => {
      if (err) return done(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
      if (!list.length) return done(new RealError('no_address', `no address for ${hostname}`));
      if (!isLoopbackHost(hostname) && list.some((a) => isPrivateAddress(a.address))) return done(new RealError('blocked_address', `${hostname} resolves to a private or reserved address`, 403));
      return opts && opts.all ? done(null, list) : done(null, list[0].address, list[0].family);
    });
  };

  function request({ url, method = 'GET', headers = {}, body, maxBytes: cap = maxBytes }) {
    let u;
    try { u = new URL(url); } catch { return Promise.reject(new RealError('bad_url', 'not a URL', 400)); }
    if (!allowed.has(u.origin)) return Promise.reject(new RealError('origin_not_allowed', `only the configured origins may be contacted (refused ${u.origin})`, 403));
    if (u.username || u.password) return Promise.reject(new RealError('bad_url', 'credentials in URLs are refused', 400));
    const loop = isLoopbackHost(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) return Promise.reject(new RealError('insecure_origin', 'https is required (http only on loopback)', 403));
    if (!loop && isPrivateAddress(u.hostname)) return Promise.reject(new RealError('blocked_address', 'private or reserved address', 403));
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    if (payload && payload.length > LIMITS.maxRequestBytes) return Promise.reject(new RealError('request_too_large', 'request body over the cap', 413));

    const started = now();
    return new Promise((resolve, reject) => {
      const lib = u.protocol === 'https:' ? https : http;
      let settled = false;
      const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
      const req = lib.request({
        protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname + u.search, method, lookup: guardedLookup, agent: false,
        headers: { ...headers, ...(payload ? { 'content-length': String(payload.length) } : {}), connection: 'close' },
      }, (res) => {
        const chunks = []; let size = 0; let truncated = false;
        res.on('data', (c) => {
          if (truncated) return;
          size += c.length;
          if (size > cap) { truncated = true; chunks.push(c.subarray(0, Math.max(0, c.length - (size - cap)))); res.destroy(); finish(resolve, shape(res, chunks, truncated)); return; }
          chunks.push(c);
        });
        res.on('end', () => finish(resolve, shape(res, chunks, truncated)));
        res.on('error', (e) => { if (!truncated) finish(reject, wrap(e)); });
        res.on('close', () => finish(resolve, shape(res, chunks, truncated)));
      });
      const shape = (res, chunks, truncated) => ({
        status: res.statusCode, redirect: res.statusCode >= 300 && res.statusCode < 400, headers: lower(res.headers),
        text: redact(Buffer.concat(chunks).toString('utf8')), truncated, ms: now() - started,
      });
      const wrap = (e) => (e instanceof RealError ? new RealError(e.code, redact(e.detail), e.status) : new RealError(e.code === 'ECONNREFUSED' ? 'connect_refused' : 'network_error', redact(`${e.code || 'error'}: ${e.message}`.slice(0, 200))));
      const timer = setTimeout(() => { req.destroy(); finish(reject, new RealError('timeout', `no answer within ${timeoutMs} ms`, 504)); }, timeoutMs);
      req.on('error', (e) => finish(reject, wrap(e)));
      if (payload) req.write(payload);
      req.end();
    });
  }
  return { request, redact, origins: [...allowed] };
}

const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v)]));
