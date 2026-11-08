// Runs the Privilege logs bridge on the owner's Mac (it needs the local PingOne Privilege console).
//   npm run bridge            every 60 s until stopped (Ctrl+C)
//   npm run bridge -- --once  one pass, then exit (exit 1 on failure)
import { installNetguard, setAllowedHosts } from '../server/src/netguard.js';
import { bridgeConfig, runOnce, stateFile, TARGET_INDEX, BRIDGE_INDICES } from '../server/src/bridge.js';

installNetguard();
const cfg = bridgeConfig();
if (!cfg.ok) { console.error(`[bridge] not configured: ${cfg.problem}`); process.exit(2); }
setAllowedHosts([cfg.decisions.host, cfg.es.host]);
const once = process.argv.includes('--once');
console.log(`[bridge] ${BRIDGE_INDICES.join(', ')} from the console ${cfg.decisions.origin} -> ${cfg.es.origin}/${TARGET_INDEX} (key set, not shown); state ${stateFile()}`);

async function pass() {
  try {
    const r = await runOnce({ log: (m) => console.log(`[bridge] ${m}`) });
    console.log(`[bridge] ${new Date().toISOString()} copied ${r.copied} record(s) for ${r.from} .. ${r.to}`);
    return true;
  } catch (e) {
    console.error(`[bridge] ${new Date().toISOString()} pass failed, will catch up next time: ${e.detail || e.message}`);
    return false;
  }
}

if (once) process.exit((await pass()) ? 0 : 1);
await pass();
setInterval(pass, 60_000);
