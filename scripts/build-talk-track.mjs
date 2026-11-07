// Writes docs/talk-track.md from the talk-track data (so the doc and the web talk-track view cannot drift).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCapture } from '../server/src/capture.js';
import { renderTalkTrackMarkdown } from '../server/src/story.js';

const file = fileURLToPath(new URL('../docs/talk-track.md', import.meta.url));
fs.writeFileSync(file, renderTalkTrackMarkdown(loadCapture()));
console.log('wrote docs/talk-track.md');
