// Preflight checks shared by `npm run doctor` and GET /api/health. Never prints a secret, needs no network.
// Each check: { id, level: 'pass' | 'info' | 'fail', detail }.
import { assertBindAllowed, bindHost, portProblem, scanHosts, scanKeys, DEFAULT_PORT, PORT_MIN } from './safety.js';
import { netguardSelfTest } from './netguard.js';
import { loadCapture, FIELDS } from './capture.js';
import { scoreLines } from './scorer.js';
import { buildStory, STATUSES, bannerMock } from './story.js';
import { modeFrom, realConfig } from './config.js';
import { DIAGRAM_NAMES, buildDiagram } from './diagramData.js';
import { naFields } from './lab.js';

export async function runChecks({ env = process.env } = {}) {
  const checks = [];
  const add = (id, level, detail) => checks.push({ id, level, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 20 ? 'pass' : 'fail', `v${process.versions.node} (need >= 20; Node 26 is the CI and Docker version)`);

  const cfg = realConfig(env);
  try { add('mode', 'pass', `mode=${modeFrom(env)}${cfg.ok ? ' (Real configured)' : ' (Mock only)'}`); } catch (e) { add('mode', 'fail', e.message); }
  add('real-settings', 'info', cfg.ok ? `Real is configured: gateway origin ${cfg.gateway.origin}, key set (not shown), ${cfg.search ? `search origin ${cfg.search.origin}` : 'no search URL (paste box)'}` : `Real is not configured (${cfg.problem.split('.')[0]}). Mock keeps working.`);

  try { add('bind', 'pass', `${assertBindAllowed(bindHost(env), env)}${env.PRIV_LOG_BIND ? ' (PRIV_LOG_BIND opt-in)' : ' (loopback)'}`); } catch (e) { add('bind', 'fail', e.message); }

  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_PORT : Number(env.PORT);
  const problem = portProblem(port);
  add('port-range', problem ? 'fail' : 'pass', problem || `${port} is the allocated port ${PORT_MIN} and not reserved`);

  let capture = null;
  try { capture = loadCapture(); add('capture', 'pass', `${capture.cases.length} cases, ${capture.sinks.length} sinks, schema valid (measured ${capture.capturedOn})`); } catch (e) { add('capture', 'fail', e.message); }
  if (capture) {
    // The scorer must reproduce the recorded score for every field with no fixed exception (see test/scorer.test.js for the five documented ones).
    const sampleOk = capture.cases.every((c) => FIELDS.every((f) => scoreLines(c.logged.flatMap((l) => l.lines), { na: naFields(c) }).score[f] !== undefined));
    add('scorer', sampleOk ? 'pass' : 'fail', 'the scorer runs on every recorded case');
    const story = buildStory(capture);
    const bad = story.facts.filter((f) => !STATUSES.includes(f.status));
    add('facts-labelled', bad.length ? 'fail' : 'pass', bad.length ? 'a fact has no status label' : 'every fact is labelled measured, inferred or UNVERIFIED');
    add('banner', bannerMock(capture.capturedOn).includes(`Replay of transactions measured on ${capture.capturedOn}; nothing is sent.`) ? 'pass' : 'fail', 'the Mock banner states the replay date and that nothing is sent');
    const text = JSON.stringify(story);
    const hosts = scanHosts(text); const keys = scanKeys(text);
    add('story-hosts', hosts.length ? 'fail' : 'pass', hosts.length ? `non-reserved hosts: ${hosts.join(', ')}` : 'every host in the story is .invalid or .example');
    add('story-keys', keys.length ? 'fail' : 'pass', keys.length ? 'key-looking values in the story' : 'no key-looking values in the story');
  }
  try { add('diagrams', DIAGRAM_NAMES.every((n) => buildDiagram(n).steps.length > 0) ? 'pass' : 'fail', `${DIAGRAM_NAMES.length} diagram-studio/1 diagrams load and validate`); } catch (e) { add('diagrams', 'fail', e.message); }

  const ng = await netguardSelfTest();
  add('netguard', ng.ok ? 'pass' : 'fail', ng.ok ? `blocked fetch, socket, socket-by-IP, dns lookup, dns resolve and udp to a non-loopback host (${ng.blocked}/6)` : ng.detail);
  add('tenant', 'pass', 'mock needs no tenant, key or credential and makes no outbound call; Real contacts only the two origins you configure');
  return checks;
}

export const allPassed = (checks) => checks.every((c) => c.level !== 'fail');
