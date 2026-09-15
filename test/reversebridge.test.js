import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

/**
 * TERS KÖPRÜ — uçtan uca HTTP testi.
 *
 * Burada "plugin"i taklit ediyoruz: gerçek plugin gibi bota DIŞA doğru
 * bağlanıp iş çekiyor, yerelde çalıştırıp sonucu geri yolluyor. Minecraft
 * tarafında hiçbir port dinlenmediği hâlde botun ve sitenin veriye
 * ulaşabildiğini kanıtlar.
 */

process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret-çok-gizli';
process.env.BRIDGE_ALLOW_LEGACY = '1';
const dbFile = join(tmpdir(), `nautilus-revbridge-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const { createRequestHandler } = await import('../src/httpserver.js');
const { bridgeQueue } = await import('../src/bridgequeue.js');
const { resetStatsCache } = await import('../src/statsproxy.js');

const SECRET = process.env.BRIDGE_SECRET;

const mockClient = {
  isReady: () => true,
  channels: { fetch: async () => ({ isTextBased: () => true, send: async () => ({ id: '1' }) }) },
};

let server;
let base;
before(async () => {
  server = createServer(createRequestHandler(mockClient));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  bridgeQueue.reset();
  try {
    rmSync(dbFile, { force: true });
    rmSync(`${dbFile}-wal`, { force: true });
    rmSync(`${dbFile}-shm`, { force: true });
  } catch { /* geçici dosya zaten yok */ }
});

/** Plugin'in ürettiğiyle aynı HMAC başlıkları. */
function sign(rawBody, { ts = Date.now(), nonce = randomUUID() } = {}) {
  return {
    'X-Nautilus-Timestamp': String(ts),
    'X-Nautilus-Nonce': nonce,
    'X-Nautilus-Signature': createHmac('sha256', SECRET).update(`${ts}.${nonce}.${rawBody}`).digest('hex'),
  };
}

/** Uzun-yoklama isteği (gövde boş → imza da boş gövde üzerinden). */
function poll(wait = 0, headers = null, instanceId = null) {
  const extra = instanceId ? { 'X-Bridge-Instance': instanceId } : {};
  return fetch(`${base}/api/bridge/jobs?wait=${wait}`, {
    headers: { ...(headers ?? sign('')), ...extra },
  });
}

function postResult(payload, headers = null) {
  const raw = JSON.stringify(payload);
  return fetch(`${base}/api/bridge/jobs/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? sign(raw)) },
    body: raw,
  });
}

/* ------------------------------------------------------------------ */
/* Kimlik doğrulama                                                    */
/* ------------------------------------------------------------------ */

test('yoklama: imzasız istek 401', async () => {
  const res = await fetch(`${base}/api/bridge/jobs?wait=0`);
  assert.equal(res.status, 401);
});

test('yoklama: bozuk imza 401', async () => {
  const bad = sign('');
  bad['X-Nautilus-Signature'] = 'f'.repeat(64);
  const res = await poll(0, bad);
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /unauthorized/);
});

test('yoklama: eski X-Bridge-Secret başlığı da kabul edilir', async () => {
  const res = await poll(0, { 'X-Bridge-Secret': SECRET });
  assert.equal(res.status, 200);
});

test('sonuç: imzasız istek 401', async () => {
  const res = await fetch(`${base}/api/bridge/jobs/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 401);
});

/* ------------------------------------------------------------------ */
/* Uçtan uca: bot → kuyruk → "plugin" → kuyruk → bot                   */
/* ------------------------------------------------------------------ */

test('uçtan uca: bot isteği plugin tarafından yanıtlanır', async () => {
  const pending = bridgeQueue.enqueue({ method: 'GET', path: '/api/status' }, 5000);

  const res = await poll(2000);
  assert.equal(res.status, 200);
  const { ok, jobs } = await res.json();
  assert.equal(ok, true);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].path, '/api/status');

  const done = await postResult({ jobId: jobs[0].jobId, status: 200, data: { online: 12 } });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { ok: true, unknown: false });

  const settled = await pending;
  assert.equal(settled.status, 200);
  assert.deepEqual(settled.data, { online: 12 });
  // İşi hangi yoklamanın aldığı teşhis için sonuca iliştirilir.
  assert.ok(settled.claimedPollId, 'işi alan yoklamanın kimliği taşınmalı');
});

test('uçtan uca: POST gövdesi plugin’e aktarılır', async () => {
  const pending = bridgeQueue.enqueue(
    { method: 'POST', path: '/api/link/verify', body: { code: 'ABC123', discordId: '42' } },
    5000,
  );
  const { jobs } = await (await poll(2000)).json();
  assert.equal(jobs[0].method, 'POST');
  assert.deepEqual(jobs[0].body, { code: 'ABC123', discordId: '42' });

  await postResult({ jobId: jobs[0].jobId, status: 200, data: { mc: 'Oyuncu1' } });
  assert.deepEqual((await pending).data, { mc: 'Oyuncu1' });
});

test('sonuç: bilinmeyen jobId 200 + unknown döner (plugin tekrar denemesin)', async () => {
  const res = await postResult({ jobId: 'olmayan-is', status: 200, data: {} });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, unknown: true });
});

test('yoklama: iş yokken boş liste döner', async () => {
  const { ok, jobs } = await (await poll(0)).json();
  assert.equal(ok, true);
  assert.deepEqual(jobs, []);
});

/* ------------------------------------------------------------------ */
/* Plugin instance kimliği (hesap bağlama belirsizliğine karşı)        */
/* ------------------------------------------------------------------ */

test('yoklama: X-Bridge-Instance başlığı kimliği taşır ve yanıtta yankılanır', async () => {
  bridgeQueue.reset();
  const res = await poll(0, null, 'mc-canli');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).instanceId, 'mc-canli');
  assert.deepEqual(bridgeQueue.activeInstances(), ['mc-canli']);
});

test('yoklama: başlıksız (eski) plugin IP tabanlı kimlik alır — geriye uyumlu', async () => {
  bridgeQueue.reset();
  const res = await poll(0);
  assert.equal(res.status, 200);
  assert.match((await res.json()).instanceId, /^ip:/);
  assert.equal(bridgeQueue.activeInstances().length, 1);
});

test('yoklama: iki farklı instance köprüde belirsizlik olarak görünür', async () => {
  bridgeQueue.reset();
  await poll(0, null, 'mc-canli');
  await poll(0, null, 'mc-test');
  assert.equal(bridgeQueue.stats().instances, 2);
});

/* ------------------------------------------------------------------ */
/* Public stats (sitenin okuduğu uç — kimlik doğrulaması YOK)          */
/* ------------------------------------------------------------------ */

test('public stats: imzasız okunur ve veri ters köprüden gelir', async () => {
  resetStatsCache();
  // "Plugin" arka planda yoklama yapıp gelen işi yanıtlar.
  const pluginLoop = (async () => {
    const { jobs } = await (await poll(3000)).json();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].path, '/api/v1/stats/leaderboard?stat=elo&topN=3');
    await postResult({ jobId: jobs[0].jobId, status: 200, data: { top: [{ name: 'A', elo: 1200 }] } });
  })();

  const res = await fetch(`${base}/api/v1/stats/leaderboard?stat=elo&topN=3`);
  await pluginLoop;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await res.json(), { top: [{ name: 'A', elo: 1200 }] });
});

test('public stats: yönetim uçlarına tünel açılamaz', async () => {
  resetStatsCache();
  for (const path of ['/api/v1/stats/links', '/api/v1/stats/mod', '/api/v1/stats/match/abc']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, `${path} 404 olmalı`);
  }
});

test('public stats: OPTIONS ön-uçuşu CORS ile 204 döner', async () => {
  const res = await fetch(`${base}/api/v1/stats/live`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('public stats: GET dışındaki metotlar 405', async () => {
  const res = await fetch(`${base}/api/v1/stats/live`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 405);
});

test('public stats: plugin bağlı değilken 503 + Türkçe mesaj', async () => {
  resetStatsCache();
  bridgeQueue.reset();
  const res = await fetch(`${base}/api/v1/stats/live`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'mc_unavailable');
  assert.match(body.mesaj, /ulaşılamıyor/);
});

/* ------------------------------------------------------------------ */
/* Mevcut davranış korunuyor mu                                        */
/* ------------------------------------------------------------------ */

test('bilinmeyen yol hâlâ 404', async () => {
  const res = await fetch(`${base}/api/bilinmeyen`);
  assert.equal(res.status, 404);
});

test('/health hâlâ çalışıyor', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, bot: true });
});

/* ------------------------------------------------------------------ */
/* Hesap bağlama protokolü ve sonuç eşleşmesi (HTTP)                   */
/* ------------------------------------------------------------------ */

test('yoklama: X-Bridge-Link-Protocol başlığı instance başına kaydedilir', async () => {
  bridgeQueue.reset();
  await poll(0, { ...sign(''), 'X-Bridge-Link-Protocol': '2' }, 'mc-yeni');
  assert.deepEqual(bridgeQueue.instanceMeta().map((m) => [m.id, m.linkProtocol]), [['mc-yeni', 2]]);
});

test('sonuç: zaman aşımına uğramış işin geç gelen sonucu late olarak işaretlenir', async () => {
  bridgeQueue.reset();
  const pending = bridgeQueue.enqueue({ method: 'POST', path: '/api/link/v2/verify', targetInstance: 'mc-canli' }, 200)
    .catch((err) => err);
  const { jobs } = await (await poll(1000, null, 'mc-canli')).json();
  assert.ok((await pending) instanceof Error, 'ön koşul: iş zaman aşımına uğramalı');
  const raw = JSON.stringify({ jobId: jobs[0].jobId, status: 200, data: { result: 'linked' } });
  const res = await fetch(`${base}/api/bridge/jobs/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sign(raw), 'X-Bridge-Instance': 'mc-canli' },
    body: raw,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, unknown: true, late: true });
});
