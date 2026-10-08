import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resourcePackPath, serveResourcePack } from '../src/resourcepack.js';

const bytes = readFileSync(new URL('../resourcepacks/97df9c175ed17072beaa5396ce3620dbaee4473c.zip', import.meta.url));
let server, base;
before(async () => {
  server = createServer((req, res) => {
    if (!serveResourcePack(req, res, new URL(req.url, 'http://local').pathname)) {
      res.writeHead(404); res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('public resource pack returns exact ZIP bytes and a content-addressed URL', async () => {
  const response = await fetch(base + resourcePackPath);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(Number(response.headers.get('content-length')), bytes.length);
  assert.match(response.headers.get('cache-control'), /immutable/);
  const received = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(received, bytes);
  assert.equal(resourcePackPath, `/resource-pack/${createHash('sha1').update(received).digest('hex')}.zip`);
});
test('HEAD and conditional GET preserve pack metadata without sending bytes', async () => {
  const head = await fetch(base + resourcePackPath, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), bytes.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const cached = await fetch(base + resourcePackPath, { headers: { 'If-None-Match': head.headers.get('etag') } });
  assert.equal(cached.status, 304);
  assert.equal((await cached.arrayBuffer()).byteLength, 0);
});
test('pack route rejects writes and arbitrary files', async () => {
  const post = await fetch(base + resourcePackPath, { method: 'POST', body: 'replace pack' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  for (const path of ['/resource-pack/', '/resource-pack/config.js', '/resource-pack/other.zip', '/resource-pack/%2e%2e%2fconfig.js']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
});
