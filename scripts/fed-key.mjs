// One-time setup for the "Valid workload token" case: make the lab's signing seed and put it in the settings file
// (~/Development/.env, or STANDALONE_ENV), then print the PUBLIC values to enter in the Privilege console. The seed is never printed.
// Refuses to replace a seed that is already set: a new seed is a new key, and the Federated Identity would stop trusting the lab.
import fs from 'node:fs';
import { readSettings, settingsFile } from '../server/src/config.js';
import { FED_ISSUER, FED_SUBJECT, FED_TOKEN_LIFE_SEC, newSeed, signerFrom } from '../server/src/fedIssuer.js';

const file = settingsFile();
const existing = readSettings(process.env).PRIV_LOG_FED_SIGNING_SEED;
let seed = existing;
if (existing) {
  console.log(`PRIV_LOG_FED_SIGNING_SEED is already set (${file} or the environment); keeping it.`);
} else {
  seed = newSeed();
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.appendFileSync(file, `${before && !before.endsWith('\n') ? '\n' : ''}# privilege-logging-LAB: signing seed for the lab's workload-token issuer (secret; never share)\nPRIV_LOG_FED_SIGNING_SEED=${seed}\n`, { mode: 0o600 });
  console.log(`Wrote PRIV_LOG_FED_SIGNING_SEED to ${file} (the value is not shown).`);
}
let signer;
try { signer = signerFrom(seed); } catch (e) { console.error(`The seed in the settings is unusable: ${e.message}. Remove that line and run this again.`); process.exit(1); }
console.log(`
Enter these in the Privilege console (Federated Identity, platform OIDC):
  Issuer:              ${FED_ISSUER}
  Subject:             ${FED_SUBJECT}   (pin it; leave "allow any subject" off)
  Keys (paste JWKS):   ${JSON.stringify(signer.jwks)}
  Max token lifetime:  ${FED_TOKEN_LIFE_SEC} seconds or more (the lab's tokens live ${FED_TOKEN_LIFE_SEC} s)
  Scopes:              mcp
Then copy the Audience the console shows into PRIV_LOG_FED_AUDIENCE in ${file}.
The same values are on the "Valid workload token" case in the lab (Real mode).`);
