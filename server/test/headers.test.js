import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A stand-in web/dist so the page route is served (WEB_DIST is read when app.js loads, so set it before importing).
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'plog-dist-'));
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>t</title>');
process.env.WEB_DIST = dist;
const { get, withServer } = await import('./helpers.js');

test('every answer refuses framing (click-jacking) and keeps nosniff: the page and the API', async () => {
  try {
    await withServer(async (url) => {
      for (const p of ['/', '/trace', '/index.html', '/api/info', '/api/health']) {
        const r = await get(url, p);
        await r.arrayBuffer();
        assert.equal(r.status, 200, p);
        assert.equal(r.headers.get('x-frame-options'), 'DENY', p);
        assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/, p);
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
      }
    });
  } finally { fs.rmSync(dist, { recursive: true, force: true }); }
});
