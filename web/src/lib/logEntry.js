// Turns one log line into a JSON value for the tree viewer. Never throws, never drops a line:
//   logrus text   time="..." level=info msg="..." key=value  ->  { time, level, msg, file?, ...pairs }
//   JSON record   {"Event":...} (also after a text prefix)   ->  the parsed object (a prefix is kept as "_prefix")
//   anything else                                             ->  the whole line as one string
// Bounded: a line is cut at MAX_LINE characters before anything reads it, and the logrus tokenizer is one linear pass.
export const MAX_LINE = 20000;

const ORDER = ['time', 'level', 'msg', 'file'];
const KEY_CH = /[A-Za-z0-9_.@-]/;

function typed(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d{1,15}(\.\d{1,10})?$/.test(raw)) return Number(raw);
  return raw;
}

// key=value pairs; a value is "quoted" (with \" and \\ escapes) or runs to the next space.
export function parseLogfmt(text) {
  const pairs = []; const free = []; let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && text[i] === ' ') i += 1;
    let k = i; while (k < n && KEY_CH.test(text[k])) k += 1;
    if (k === i || text[k] !== '=') {
      // not a key=value token: free text. Skip to the next space (always moves forward, so this cannot loop).
      const s = i; while (i < n && text[i] !== ' ') i += 1;
      free.push(text.slice(s, i));
      continue;
    }
    const key = text.slice(i, k); i = k + 1;
    let value; let quoted = false;
    if (text[i] === '"') {
      quoted = true; i += 1; let out = '';
      while (i < n && text[i] !== '"') { if (text[i] === '\\' && i + 1 < n) { const c = text[i + 1]; out += c === 'n' ? '\n' : c === 't' ? '\t' : c; i += 2; } else { out += text[i]; i += 1; } }
      i += 1; value = out;
    } else { const s = i; while (i < n && text[i] !== ' ') i += 1; value = text.slice(s, i); }
    pairs.push([key, quoted ? value : typed(value)]);
  }
  return { pairs, free };
}

export function parseLogLine(line) {
  const text = String(line ?? '').slice(0, MAX_LINE);
  const b = text.indexOf('{');
  if (b >= 0) {
    const e = text.lastIndexOf('}');
    if (e > b) {
      try {
        const doc = JSON.parse(text.slice(b, e + 1));
        if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
          const prefix = text.slice(0, b).trim();
          const suffix = text.slice(e + 1).trim();
          return { kind: 'json', value: prefix || suffix ? { ...(prefix ? { _prefix: prefix } : {}), ...doc, ...(suffix ? { _suffix: suffix } : {}) } : doc };
        }
      } catch { /* not JSON: try logrus */ }
    }
  }
  const logrus = /\b(level|time|msg)=/.test(text.slice(0, 300));
  if (logrus || text.includes('=')) {
    const { pairs, free } = parseLogfmt(text);
    // logrus: time/level/msg/file first, then the rest. Other lines with at least two key=value pairs: the free text becomes "msg".
    if (pairs.length >= (logrus ? 1 : 2)) {
      const obj = {};
      for (const k of ORDER) { const p = pairs.find(([key]) => key === k); if (p) obj[k] = p[1]; }
      if (!logrus && free.length) obj.msg = free.join(' ');
      // Own-key check and defineProperty: a field named like an Object.prototype member (constructor, toString, __proto__) is a
      // real field and must show; `k in obj` would skip it and a plain `obj.__proto__ = v` would set the prototype instead.
      for (const [k, v] of pairs) if (!Object.hasOwn(obj, k)) Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
      return { kind: logrus ? 'logrus' : 'logfmt', value: obj };
    }
  }
  return { kind: 'text', value: text };
}
