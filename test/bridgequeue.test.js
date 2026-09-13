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
/* Plugin instance kimliği (birden fazla sunucu koruması)              */
/* ------------------------------------------------------------------ */

test('kuyruk: kimliksiz yoklama tek anonim instance sayılır (geriye uyumluluk)', async () => {
  const q = createBridgeQueue();
  await q.takeJobs(0);
  await q.takeJobs(0);
  assert.deepEqual(q.activeInstances(), ['ip:bilinmeyen']);
  assert.equal(q.stats().instances, 1);
});

test('kuyruk: iki farklı instance yoklarsa ikisi de görülür', async () => {
  const q = createBridgeQueue();
  await q.takeJobs(0, { instanceId: 'mc-canli' });
  await q.takeJobs(0, { instanceId: 'mc-test' });
  assert.deepEqual(q.activeInstances().sort(), ['mc-canli', 'mc-test']);
  assert.equal(q.stats().instances, 2, 'belirsizlik tespit edilebilmeli');
});

test('kuyruk: hedef denemeleri en son görülen instance ile başlar', async () => {
  let clock = 1_000_000;
  const q = createBridgeQueue({ now: () => clock });
  await q.takeJobs(0, { instanceId: 'mc-eski' });
  clock += 100;
  await q.takeJobs(0, { instanceId: 'mc-guncel' });
  assert.deepEqual(q.activeInstances(), ['mc-guncel', 'mc-eski']);
});

test('kuyruk: instance kaydı bağlantı penceresi dışında düşer', async () => {
  let clock = 1_000_000;
  const q = createBridgeQueue({ now: () => clock });
  await q.takeJobs(0, { instanceId: 'mc-eski' });
  clock += 30_000;
  await q.takeJobs(0, { instanceId: 'mc-yeni' });
  assert.equal(q.activeInstances().length, 2);

  // Bağlantı penceresi 60 sn: mc-eski 75 sn önce, mc-yeni 45 sn önce yokladı.
  clock += 45_000;
  assert.deepEqual(q.activeInstances(), ['mc-yeni']);
});

test('kuyruk: hedefli iş yalnız hedef instance\'a teslim edilir', async () => {
  const q = createBridgeQueue();
  const promise = q.enqueue({ path: '/api/link/verify', targetInstance: 'mc-canli' }, 2000);

  const yanlis = await q.takeJobs(0, { instanceId: 'mc-test' });
  assert.deepEqual(yanlis, [], 'iş yanlış instance\'a verilmemeli');

  const dogru = await q.takeJobs(0, { instanceId: 'mc-canli' });
  assert.equal(dogru.length, 1);
  q.completeJob(dogru[0].jobId, 200, { mc: 'Oyuncu1' });
  assert.deepEqual((await promise).data, { mc: 'Oyuncu1' });
});

test('kuyruk: hedefsiz iş herhangi bir instance tarafından alınır', async () => {
  const q = createBridgeQueue();
  const promise = q.enqueue({ path: '/api/status' }, 2000);
  const jobs = await q.takeJobs(0, { instanceId: 'mc-test' });
  assert.equal(jobs.length, 1);
  q.completeJob(jobs[0].jobId, 200, {});
  await promise;
});

test('kuyruk: bekleyen yoklamacı hedefli işi yalnız kendisi içinse alır', async () => {
  const q = createBridgeQueue();
  const bekleyen = q.takeJobs(300, { instanceId: 'mc-test' });
  const promise = q.enqueue({ path: '/api/link/verify', targetInstance: 'mc-canli' }, 2000);

  assert.deepEqual(await bekleyen, [], 'başka instance\'ın işi teslim edilmemeli');
  const dogru = await q.takeJobs(0, { instanceId: 'mc-canli' });
  assert.equal(dogru.length, 1);
  q.completeJob(dogru[0].jobId, 200, {});
  await promise;
});

test('kuyruk: stats() açık poller ve instance sayısını verir', async () => {
  const q = createBridgeQueue();
  const bekleyen = q.takeJobs(200, { instanceId: 'mc-canli' });
  assert.equal(q.stats().pollers, 1);
  assert.equal(q.stats().instances, 1);
  assert.ok(q.stats().lastPollAt > 0, 'son yoklama zamanı görünmeli');
  await bekleyen;
  assert.equal(q.stats().pollers, 0);
});

/* ------------------------------------------------------------------ */
/* Ters vekil arkasındaki çoklu plugin (kimlik sayımının kör noktası)  */
/* ------------------------------------------------------------------ */

test('kuyruk: aynı IP\'den iki eşzamanlı yoklama belirsizlik sayılır', async () => {
  const q = createBridgeQueue();
  // Dokploy/Traefik arkasında İKİ plugin: ikisi de aynı proxy IP'sinden gelir,
  // kimlik başlığı göndermezler → kimlik sayımı 1 der, yani KÖRDÜR.
  const a = q.takeJobs(300, { instanceId: 'ip:172.18.0.1' });
  const b = q.takeJobs(300, { instanceId: 'ip:172.18.0.1' });

  assert.equal(q.activeInstances().length, 1, 'kimlik sayımı burada kör kalır');
  const routing = q.routingAmbiguity();
  assert.equal(routing.ambiguous, true, 'eşzamanlı yoklama sayısı belirsizliği yakalamalı');
  assert.equal(routing.reason, 'concurrent_pollers');

  await Promise.all([a, b]);
});

test('kuyruk: farklı kimliklerin yanında yinelenen kimlik ayrıca yakalanır', async () => {
  const q = createBridgeQueue();
  const held = [
    q.takeJobs(200, { instanceId: 'mc-a' }),
    q.takeJobs(200, { instanceId: 'mc-b' }),
    q.takeJobs(200, { instanceId: 'mc-b' }),
  ];

  const routing = q.routingAmbiguity();
  assert.equal(routing.ambiguous, true);
  assert.equal(routing.reason, 'duplicate_instance');
  assert.deepEqual(routing.duplicateInstances, ['mc-b']);
  await Promise.all(held);
});

test('kuyruk: belirsizlik yoklamalar kapandıktan sonra da pencere boyunca hatırlanır', async () => {
  let clock = 1_000_000;
  const q = createBridgeQueue({ now: () => clock });
  await Promise.all([
    q.takeJobs(0, { instanceId: 'ip:172.18.0.1' }),
    q.takeJobs(0, { instanceId: 'ip:172.18.0.1' }),
  ]);
  // wait=0 olduğu için iki yoklama da hemen kapandı; yine de ikinci bir plugin
  // olduğunu biliyoruz — ikincisi iki yoklama arasında olabilir.
  const q2 = createBridgeQueue();
  const held = [
    q2.takeJobs(200, { instanceId: 'ip:172.18.0.1' }),
    q2.takeJobs(200, { instanceId: 'ip:172.18.0.1' }),
  ];
  await Promise.all(held);
  assert.equal(q2.routingAmbiguity().ambiguous, true, 'kapanmış yoklamalar da sayılmalı');
  assert.equal(q2.stats().peakPollers, 2);
});

test('kuyruk: tek plugin tek yoklama tutar — belirsizlik YOK', async () => {
  const q = createBridgeQueue();
  const first = q.takeJobs(120, { instanceId: 'ip:172.18.0.1' });
  await first;
  const second = q.takeJobs(120, { instanceId: 'ip:172.18.0.1' });
  await second;
  const routing = q.routingAmbiguity();
  assert.equal(routing.ambiguous, false, 'ardışık yoklamalar belirsizlik değildir');
  assert.equal(q.stats().peakPollers, 1);
});

test('kuyruk: sonuç, işi hangi yoklamanın aldığını taşır', async () => {
  const q = createBridgeQueue();
  const promise = q.enqueue({ path: '/api/link/verify' }, 2000);
  const jobs = await q.takeJobs(0, { instanceId: 'mc-canli' });
  q.completeJob(jobs[0].jobId, 404, { error: 'invalid_code' });
  const res = await promise;
  assert.equal(res.claimedBy, 'mc-canli');
  assert.ok(res.claimedPollId, 'yoklama kimliği sonuca iliştirilmeli');
});

test('kuyruk: arka arkaya iki iş, iki bekleyen yoklamaya BÖLÜNÜR (arızanın mekaniği)', async () => {
  const q = createBridgeQueue();
  const a = q.takeJobs(500, { instanceId: 'ip:172.18.0.1' });
  const b = q.takeJobs(500, { instanceId: 'ip:172.18.0.1' });
  q.enqueue({ path: '/api/link/status' }, 2000).catch(() => {});
  q.enqueue({ method: 'POST', path: '/api/link/verify' }, 2000).catch(() => {});

  const [jobsA, jobsB] = await Promise.all([a, b]);
  assert.deepEqual(jobsA.map((j) => j.path), ['/api/link/status']);
  assert.deepEqual(jobsB.map((j) => j.path), ['/api/link/verify'],
    'sorgu ve doğrulama farklı pluginlere düşüyor — sahte invalid_code tam olarak budur');
  q.reset();
});

test('kuyruk: kopan bağlantının yoklaması hemen düşer (yanlış pozitif koruması)', async () => {
  const q = createBridgeQueue();
  const ac = new AbortController();
  const terk = q.takeJobs(5000, { instanceId: 'ip:172.18.0.1', signal: ac.signal });
  assert.equal(q.stats().pollers, 1);

  // Plugin yeniden başladı: eski bağlantı koptu.
  ac.abort();
  assert.deepEqual(await terk, []);
  assert.equal(q.stats().pollers, 0, 'terk edilen yoklama açık sayılmamalı');

  // Yeni süreç yoklamaya başlar — bu TEK plugin'dir, belirsizlik olmamalı.
  const yeni = q.takeJobs(120, { instanceId: 'ip:172.18.0.1' });
  assert.equal(q.routingAmbiguity().ambiguous, false,
    'yeniden başlatma "iki plugin" sanılmamalı — hesap bağlama boş yere bloklanmaz');
  await yeni;
});

test('kuyruk: zaten iptal edilmiş sinyalle yoklama anında boş döner', async () => {
  const q = createBridgeQueue();
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await q.takeJobs(5000, { instanceId: 'mc-1', signal: ac.signal }), []);
  assert.equal(q.stats().pollers, 0);
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
