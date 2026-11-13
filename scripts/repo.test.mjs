import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackHost, scanHosts } from '../server/src/safety.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('the files the standalone rules ask for are present', () => {
  for (const f of ['README.md', 'CLAUDE.md', 'LICENSE', 'Dockerfile', 'docker-compose.yml', '.github/workflows/ci.yml', 'docs/talk-track.md', 'docs/safety.md', 'docs/shelf-entry.json', 'content-pack.json', 'scripts/doctor.mjs', 'scripts/reset.mjs', 'scripts/check-no-ai-attribution.sh', 'server/data/capture.json']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});

test('the README declares the tier on its own line', () => {
  assert.match(read('README.md'), /^Tier: Tester\.$/m);
});

test('the shelf entry is valid and portable: relative composeFile, loopback url, health path, port 7801, no invented catalogId', () => {
  const e = JSON.parse(read('docs/shelf-entry.json')).demos[0];
  assert.equal(e.id, 'privilege-logging-lab');
  assert.equal(e.kind, 'Tester');
  assert.equal(e.healthPath, '/api/health');
  assert.equal(e.url, 'http://localhost:7801');
  assert.ok(!path.isAbsolute(e.composeFile), 'composeFile must be relative or a placeholder');
  assert.ok(!/\/Users\//.test(JSON.stringify(e)), 'no absolute home path');
  assert.equal(e.catalogId, undefined, 'no catalog row truly matches, so no catalogId');
  assert.deepEqual(e.pingProducts, []);
});

test('CI uses GitHub-hosted runners, Node 26 only, gitleaks, the forbidden-strings history check and the attribution check', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /runs-on: ubuntu-latest/);
  assert.doesNotMatch(ci, /self-hosted/);
  assert.match(ci, /node: \[26\]/);
  assert.match(ci, /gitleaks/);
  assert.match(ci, /FORBIDDEN_STRINGS/);
  assert.match(ci, /check-no-ai-attribution\.sh/);
});

test('the server test script uses a glob, never a directory (Node 22+)', () => {
  assert.equal(JSON.parse(read('server/package.json')).scripts.test, 'node --test test/*.test.js');
  assert.match(JSON.parse(read('package.json')).scripts.test, /node --test scripts\/\*\.test\.mjs/);
});

test('no shipped text carries a non-reserved host, a real-looking UUID or an AI-attribution credit', () => {
  const skip = new Set(['node_modules', 'dist', '.git', 'package-lock.json', 'e2e-output', 'coverage']);
  const hits = [];
  const credit = /[G]enerated with \[?[C]laude Code|[C]o-[A]uthored-[B]y:/i;
  const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (/\.(png|jpe?g|gif|ico|woff2?)$/.test(name) || name === 'check-no-ai-attribution.sh' || /repo\.test\.mjs$/.test(name)) continue;
      const t = fs.readFileSync(p, 'utf8');
      const rel = path.relative(root, p);
      if (credit.test(t)) hits.push(`${rel}: attribution`);
      if (uuid.test(t) && !/\.test\.(m?js|jsx)$/.test(name)) hits.push(`${rel}: uuid`);
      if (/\.(md|ya?ml)$/.test(name) || name === 'content-pack.json' || name === 'shelf-entry.json' || name === '.env.example') {
        // Docs and data files: github.com and the standards sites are the only real hosts they may name; everything else must be .example/.invalid/loopback
        const bad = scanHosts(t).map((h) => h.replace(/[`'")\]}]+$/, '').replace(/:\d+$/, '')).filter((h) => !/^(github\.com|raw\.githubusercontent\.com|www\.w3\.org|modelcontextprotocol\.io|local\.ping-devops\.com|privilege-logging-lab\.local\.ping-devops\.com|www\.rfc-editor\.org|registry\.npmjs\.org|playwright\.dev|example\.com|console\.pingone\.com|privilege\.pingone\.com|local\.procyon\.ai)$/.test(h) && !/^[\d.]+$/.test(h) && !h.endsWith('.local') && !isLoopbackHost(h));
        if (bad.length) hits.push(`${rel}: ${bad.join(', ')}`);
      }
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});

test('the settings names are the four documented ones, and the key is never read by any file that serves an API', () => {
  const env = read('.env.example');
  for (const n of ['PRIV_LOG_GATEWAY_URL', 'PRIV_LOG_AGENT_KEY', 'PRIV_LOG_SEARCH_URL', 'PRIV_LOG_SEARCH_INDEX']) assert.match(env, new RegExp(n));
  const consumers = ['app.js', 'lab.js', 'story.js', 'doctor.js', 'health.js'].map((f) => [f, read(`server/src/${f}`)]);
  for (const [f, text] of consumers) assert.doesNotMatch(text, /AGENT_KEY/, `${f} must not touch the key setting`);
});
