import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const resourcePackPath = '/resource-pack/97df9c175ed17072beaa5396ce3620dbaee4473c.zip';
const pack = readFileSync(new URL(`../resourcepacks/${resourcePackPath.split('/').at(-1)}`, import.meta.url));
const hash = createHash('sha1').update(pack).digest('hex');
if (resourcePackPath !== `/resource-pack/${hash}.zip`) throw new Error('Resource pack filename does not match its SHA-1');
const headers = {
  'Content-Type': 'application/zip',
  'Cache-Control': 'public, max-age=31536000, immutable',
  'ETag': `"${hash}"`,
  'X-Content-Type-Options': 'nosniff',
};

export function serveResourcePack(req, res, path) {
  if (path !== '/resource-pack' && !path.startsWith('/resource-pack/')) return false;
  if (path !== resourcePackPath) {
    res.writeHead(404); res.end(); return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true;
  }
  if (req.headers['if-none-match'] === headers.ETag) {
    res.writeHead(304, headers); res.end(); return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': pack.length });
  res.end(req.method === 'HEAD' ? undefined : pack);
  return true;
}
