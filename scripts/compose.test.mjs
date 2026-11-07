import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { portProblem } from '../server/src/safety.js';

// Every published port must be bound to loopback on the host. A small line parser (no YAML dependency).
export function publishedPorts(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)ports:\s*$/.exec(lines[i]);
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s*-\s*["']?([^"'\s#]+)["']?/.exec(lines[j]);
      if (!item || lines[j].search(/\S/) <= m[1].length) break;
      out.push(item[1]);
    }
  }
  return out;
}
const here = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('docker-compose.yml publishes only on 127.0.0.1', () => {
  const ports = publishedPorts(here('docker-compose.yml'));
  assert.ok(ports.length > 0, 'the parser found the published port');
  for (const p of ports) assert.match(p, /^127\.0\.0\.1:/, `${p} must start with 127.0.0.1:`);
});

test('the parser flags an unbound or wildcard publish', () => {
  for (const bad of ['- "7801:7801"', '- "0.0.0.0:7801:7801"', '- 7801', '- "::1:7801:7801"']) {
    const ports = publishedPorts(`services:\n  a:\n    ports:\n      ${bad}\n`);
    assert.equal(ports.length, 1);
    assert.doesNotMatch(ports[0], /^127\.0\.0\.1:/);
  }
});

test('compose default host port and Dockerfile port are allowed ports and agree', () => {
  const compose = here('docker-compose.yml');
  const host = Number(/\$\{HOST_PORT:-(\d+)\}/.exec(compose)[1]);
  assert.equal(portProblem(host), null);
  const docker = here('Dockerfile');
  const port = Number(/^EXPOSE (\d+)/m.exec(docker)[1]);
  assert.equal(portProblem(port), null);
  assert.match(compose, new RegExp(`:${port}"`));
  assert.match(docker, /^ENV PRIV_LOG_BIND=0\.0\.0\.0$/m);
  assert.match(docker, /^USER node$/m);
});

test('the container is locked down: read-only fs, no capabilities, no new privileges', () => {
  const compose = here('docker-compose.yml');
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop: \[ALL\]/);
  assert.match(compose, /no-new-privileges:true/);
});

test('exactly one published port, 127.0.0.1:7801, and the default mode in Docker is Mock (Real is never on by default)', () => {
  const compose = here('docker-compose.yml');
  assert.deepEqual(publishedPorts(compose), ['127.0.0.1:${HOST_PORT:-7801}:7801']);
  assert.match(compose, /MODE: \$\{MODE:-mock\}/);
  assert.match(here('Dockerfile'), /^ENV NODE_ENV=production PORT=7801 MODE=mock$/m);
  assert.match(here('Dockerfile'), /^FROM node:26-alpine/m);
});

test('the compose file never sets a key or gateway default, and mounts nothing from the host', () => {
  const compose = here('docker-compose.yml');
  assert.match(compose, /PRIV_LOG_GATEWAY_URL: \$\{PRIV_LOG_GATEWAY_URL:-\}/);
  assert.match(compose, /PRIV_LOG_AGENT_KEY: \$\{PRIV_LOG_AGENT_KEY:-\}/);
  assert.doesNotMatch(compose, /^\s*volumes:/m);
  assert.doesNotMatch(compose, /docker\.sock|network_mode|privileged/);
});
