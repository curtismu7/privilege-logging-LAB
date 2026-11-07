// The flow diagrams are diagram-studio/1 DATA (server/diagrams/*.json, built from the capture by scripts/build-diagrams.mjs), loaded by
// name and checked with the studio's own validator copy. Nothing here builds nodes or edges by hand. Each step is one edge, walked in
// order by Simulate; a dashed edge means the sink held nothing or was not read back.
import fs from 'node:fs';
import { validateDiagram } from './diagramStudioValidate.js';

const DIR = new URL('../diagrams/', import.meta.url);
export const DIAGRAM_NAMES = ['mcp', 'ai-guard', 'rejected', 'aggregate', 'a2a', 'llm', 'intent'];

export function loadDiagram(name) {
  const doc = JSON.parse(fs.readFileSync(new URL(`${name}.json`, DIR), 'utf8'));
  const problems = validateDiagram(doc);
  if (problems.length) throw new Error(`diagram ${name} is not valid diagram-studio/1: ${problems.join('; ')}`);
  return doc;
}
const DOCS = Object.fromEntries(DIAGRAM_NAMES.map((n) => [n, loadDiagram(n)]));
export const rawDiagram = (name = DIAGRAM_NAMES[0]) => DOCS[name];

export function buildDiagram(name = DIAGRAM_NAMES[0]) {
  const d = DOCS[name] || DOCS[DIAGRAM_NAMES[0]];
  return {
    name: DOCS[name] ? name : DIAGRAM_NAMES[0], title: d.title, intro: d.lede,
    nodes: d.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.group, x: n.x, y: n.y })),
    steps: d.steps.map((s) => { const e = d.edges[s.edges[0]]; return { from: e.source, to: e.target, label: s.title, say: s.what, dashed: !!e.dashed }; }),
  };
}
