import { installNetguard } from './netguard.js';
import { startHttpServer, createApp } from './app.js';
import { allPassed, runChecks } from './doctor.js';
import { assertBindAllowed, bindHost, resolvePort } from './safety.js';
import { modeFrom, realConfig } from './config.js';

installNetguard(); // before anything else can open a socket

const checks = await runChecks();
if (!allPassed(checks)) {
  for (const c of checks.filter((x) => x.level === 'fail')) console.error(`[privilege-logging-lab] refusing to start: ${c.id}: ${c.detail}`);
  process.exit(1);
}
console.log(`[privilege-logging-lab] starting in ${modeFrom()} mode`);
const host = assertBindAllowed(bindHost(), process.env);
const { url } = await startHttpServer({ port: resolvePort(), host, app: createApp() });
const real = realConfig();
console.log(`[privilege-logging-lab] lab at ${url} (loopback${real.ok ? `, Real configured for ${real.gateway.origin}${real.search ? ` and ${real.search.origin}` : ''}` : ', Mock only — no outbound network'})`);
console.log(`[privilege-logging-lab] health: ${url}api/health`);
