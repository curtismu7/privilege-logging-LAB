// An iterative walker over a JSON value that yields the visible rows of a tree, with caps so a hostile entry cannot hang the page.
//   Depth limit MAX_DEPTH, node cap MAX_NODES, string display cap STR_CAP (full text only behind "Show more", itself capped at STR_MAX).
// No recursion over the data: an explicit stack. Keys are shown as text, values are never interpreted.
export const MAX_DEPTH = 10;
export const MAX_NODES = 1500;
export const MAX_CHILDREN = 200;
export const STR_CAP = 200;
export const STR_MAX = 20000;

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// Walk the whole value once (bounded) into nodes: { path, key, type, value, depth, children[] (paths), more }.
export function buildNodes(root) {
  const nodes = new Map(); let count = 0; let cut = 0;
  const stack = [{ path: '$', key: null, value: root, depth: 0 }];
  while (stack.length) {
    const { path, key, value, depth } = stack.pop();
    if (count >= MAX_NODES) { cut += 1; continue; }
    count += 1;
    const type = typeOf(value);
    const node = { path, key, type, depth, children: [], more: 0, value: type === 'object' || type === 'array' ? undefined : value };
    nodes.set(path, node);
    if (type === 'object' || type === 'array') {
      const entries = type === 'array' ? value.map((v, i) => [String(i), v]) : Object.entries(value);
      node.size = entries.length;
      if (depth >= MAX_DEPTH) { node.more = entries.length; node.depthLimited = true; continue; }
      const shown = entries.slice(0, MAX_CHILDREN);
      node.more = entries.length - shown.length;
      for (let i = shown.length - 1; i >= 0; i -= 1) { const [k, v] = shown[i]; stack.push({ path: `${path}/${k}`, key: k, value: v, depth: depth + 1 }); }
      node.children = shown.map(([k]) => `${path}/${k}`);
    }
  }
  return { nodes, root: '$', cut, count };
}

// The rows to draw given which container paths are expanded. Iterative, in document order.
export function visibleRows(tree, expanded) {
  const rows = []; const stack = [{ path: tree.root, level: 1, pos: 1, size: 1 }];
  while (stack.length) {
    const { path, level, pos, size } = stack.pop();
    const node = tree.nodes.get(path);
    if (!node) continue; // beyond the node cap
    rows.push({ node, level, pos, size });
    if ((node.type === 'object' || node.type === 'array') && expanded.has(path)) {
      const kids = node.children.filter((c) => tree.nodes.has(c));
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push({ path: kids[i], level: level + 1, pos: i + 1, size: kids.length });
    }
  }
  return rows;
}

export const containerPaths = (tree) => [...tree.nodes.values()].filter((n) => n.type === 'object' || n.type === 'array').map((n) => n.path);

// Default: containers down to depth 2 are open, so a typical log entry is fully visible at once.
export function defaultExpanded(tree, depth = 2) {
  return new Set([...tree.nodes.values()].filter((n) => (n.type === 'object' || n.type === 'array') && n.depth < depth).map((n) => n.path));
}

// Plain JSON text of a value, for Copy. The value is already redacted (the server redacts every line it serves).
export function toJsonText(value) {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
