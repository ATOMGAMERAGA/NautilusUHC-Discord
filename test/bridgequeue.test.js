import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.js DISCORD_TOKEN ister; db.js dosya açar (statsproxy zinciri config'i
// çeker) — ikisini de test için ayarla.
process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret-çok-gizli';

const { createBridgeQueue, MAX_POLL_WAIT_MS } = await import('../src/bridgequeue.js');
const { publicStats, isAllowedStatsPath, resetStatsCache } = await import('../src/statsproxy.js');

/* ------------------------------------------------------------------ */
/* İş kuyruğu                                                          */
/* ------------------------------------------------------------------ */

test('kuyruk: iş yoklamayla teslim edilir ve sonuç çağırana döner', async () => {
  const q = createBridgeQueue();
  const promise = q.enqueue({ method: 'GET', path: '/api/status' });

  const jobs = await q.takeJobs(1000);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].path, '/api/status');
  assert.equal(jobs[0].method, 'GET');
  assert.ok(jobs[0].jobId, 'işin bir jobId değeri olmalı');

  assert.equal(q.completeJob(jobs[0].jobId, 200, { ok: true, players: 7 }), true);
  const res = await promise;
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { ok: true, players: 7 });
});

test('kuyruk: yoklama beklerken gelen iş hemen teslim edilir', async () => {
  const q = createBridgeQueue();
  // Önce yoklama başlar (iş yok), sonra iş gelir.
  const polling = q.takeJobs(3000);
  const promise = q.enqueue({ path: '/api/teams' });

  const jobs = await polling;
  assert.equal(jobs.length, 1, 'bekleyen yoklamacıya anında teslim edilmeli');
  assert.equal(jobs[0].path, '/api/teams');

  q.completeJob(jobs[0].jobId, 200, {});
  await promise;
});

test('kuyruk: iş yoksa yoklama süre dolunca boş döner', async () => {
  const q = createBridgeQueue();
  const started = Date.now();
  const jobs = await q.takeJobs(120);
  assert.deepEqual(jobs, []);
  assert.ok(Date.now() - started >= 100, 'istenen süre kadar beklemeli');
});

test('kuyruk: yoklama süresi üst sınırla kırpılır', async () => {
  const q = createBridgeQueue();
  // Devasa bir bekleme istense bile MAX_POLL_WAIT_MS'i aşmamalı; testi
  // bekletmemek için sadece sınırın kendisini doğruluyoruz.
  assert.equal(MAX_POLL_WAIT_MS, 25_000);
  const jobs = await q.takeJobs(0);
  assert.deepEqual(jobs, []);
});

test('kuyruk: yanıt gelmezse iş zaman aşımına uğrar ve kuyruktan düşer', async () => {
  const q = createBridgeQueue();
  await assert.rejects(
    () => q.enqueue({ path: '/api/status' }, 60),
    /zaman aşımı/,
  );
  // Zaman aşımına uğrayan iş artık teslim edilmemeli.
  const jobs = await q.takeJobs(0);
  assert.deepEqual(jobs, [], 'zaman aşımına uğrayan iş kuyrukta kalmamalı');
});

test('kuyruk: bilinmeyen jobId sonucu sessizce yoksayılır', () => {
  const q = createBridgeQueue();
  assert.equal(q.completeJob('yok-böyle-bir-iş', 200, {}), false);
});

test('kuyruk: pluginConnected yalnız yakın zamanda yoklama olduysa true', async () => {
  let clock = 1_000_000;
  const q = createBridgeQueue({ now: () => clock });
  assert.equal(q.pluginConnected(), false, 'hiç yoklama olmadan bağlı sayılmaz');

  await q.takeJobs(0);
  assert.equal(q.pluginConnected(), true);

  clock += 30_000; // hâlâ pencere içinde
  assert.equal(q.pluginConnected(), true);

  clock += 60_000; // pencere aşıldı
  assert.equal(q.pluginConnected(), false);
});

test('kuyruk: yol verilmeyen iş reddedilir', async () => {
  const q = createBridgeQueue();
  await assert.rejects(() => q.enqueue({ method: 'GET' }), /yol/);
});

test('kuyruk: stats() teşhis bilgisi verir', async () => {
  const q = createBridgeQueue();
  const promise = q.enqueue({ path: '/api/status' }, 500);
  assert.equal(q.stats().pending, 1);
  assert.equal(q.stats().waiting, 1);
  const jobs = await q.takeJobs(0);
  q.completeJob(jobs[0].jobId, 200, {});
  await promise;
  assert.equal(q.stats().pending, 0);
  assert.equal(q.stats().waiting, 0);
});

/* ------------------------------------------------------------------ */
/* Public stats proxy                                                  */
/* ------------------------------------------------------------------ */

test('stats: yalnız beyaz listedeki yollar kabul edilir', () => {
  for (const ok of ['/live', '/schedule', '/leaderboard', '/player', '/player/matches', '/matches', '/match/42', '']) {
    assert.equal(isAllowedStatsPath(ok), true, `${ok} izinli olmalı`);
  }
  // Yönetim uçlarına tünel açılmasını engelleyen asıl koruma.
  for (const bad of ['/../api/mod', '/mod', '/links', '/match/abc', '/player/../../api/mod']) {
    assert.equal(isAllowedStatsPath(bad), false, `${bad} REDDEDİLMELİ`);
  }
});

test('stats: izinsiz yol kuyruğa hiç gitmeden 404 döner', async () => {
  resetStatsCache();
  let called = false;
  const queue = { enqueue: async () => { called = true; return { status: 200, data: {} }; } };
  const res = await publicStats('/links', '', { queue });
  assert.equal(res.status, 404);
  assert.equal(called, false, 'izinsiz yol için plugin sorgulanmamalı');
});

test('stats: sonuç önbelleğe alınır, ikinci istek plugin’e gitmez', async () => {
  resetStatsCache();
  let calls = 0;
  const queue = {
    enqueue: async () => { calls++; return { status: 200, data: { top: [1, 2, 3] } }; },
  };
  const first = await publicStats('/leaderboard', '?stat=elo', { queue });
  const second = await publicStats('/leaderboard', '?stat=elo', { queue });
  assert.equal(calls, 1, 'TTL içinde plugin bir kez sorgulanmalı');
  assert.deepEqual(first.body, second.body);
});

test('stats: farklı sorgu dizesi ayrı önbellek anahtarıdır', async () => {
  resetStatsCache();
  let calls = 0;
  const queue = {
    enqueue: async ({ path }) => { calls++; return { status: 200, data: { path } }; },
  };
  await publicStats('/leaderboard', '?stat=elo', { queue });
  await publicStats('/leaderboard', '?stat=kills', { queue });
  assert.equal(calls, 2);
});

test('stats: plugin ulaşılamazken bayat önbellek sunulur', async () => {
  resetStatsCache();
  let fail = false;
  const queue = {
    enqueue: async () => {
      if (fail) throw new Error('zaman aşımı');
      return { status: 200, data: { top: ['a'] } };
    },
  };
  let clock = 1_000_000;
  const now = () => clock;
  await publicStats('/leaderboard', '', { queue, now });

  clock += 60_000; // TTL doldu
  fail = true;
  const stale = await publicStats('/leaderboard', '', { queue, now });
  assert.equal(stale.status, 200);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.body, { top: ['a'] });
});

test('stats: önbellek de yoksa 503 ve Türkçe mesaj döner', async () => {
  resetStatsCache();
  const queue = { enqueue: async () => { throw new Error('zaman aşımı'); } };
  const res = await publicStats('/live', '', { queue });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'mc_unavailable');
  assert.match(res.body.mesaj, /ulaşılamıyor/);
});

test('stats: 5xx yanıtı önbelleğe alınmaz', async () => {
  resetStatsCache();
  let calls = 0;
  const queue = {
    enqueue: async () => { calls++; return { status: 500, data: { error: 'internal_error' } }; },
  };
  await publicStats('/live', '', { queue });
  await publicStats('/live', '', { queue });
  assert.equal(calls, 2, 'geçici plugin hatası TTL boyunca yapışmamalı');
});
