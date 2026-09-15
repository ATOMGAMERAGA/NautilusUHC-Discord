import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Hesap bağlama doğrulaması — protokol 2 akışı (bot tarafı).
 *
 * Plugin modeli (test/support/fakeplugin.js) ile zamanlama ve hata enjekte
 * edilir; gerçek JAR + SQLite sözleşmesi linkintegration.test.js'tedir.
 */

process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret-çok-gizli';

const { createMcApi } = await import('../src/mcapi.js');
const { verifyLinkCode, createAttemptLimiter, FAILED_ATTEMPT_LIMIT } = await import('../src/linkflow.js');
const { createFakePlugin, createFakeBridge, LINK_WRITE_PATHS } = await import('./support/fakeplugin.js');

const CFG = {
  mcApiUrl: '', directFallbackDisabled: false, mcApiUrlError: null, bridgeSecret: 'x',
};
const SILENT = { log() {}, warn() {}, error() {} };
const UUID_A = '00000000-0000-4000-8000-00000000000a';
const UUID_B = '00000000-0000-4000-8000-00000000000b';
const DC_A = '300000000000000001';
const DC_B = '300000000000000002';

function apiOver(bridge) {
  return createMcApi({ queue: bridge, cfg: CFG, logger: SILENT });
}

function verify(api, code, discordId, extra = {}) {
  return verifyLinkCode({
    api, code, discordId, discordTag: 'oyuncu#0', logger: SILENT, sleep: async () => {}, retryDelayMs: 0, ...extra,
  });
}

const writes = (plugin) => plugin.calls.filter((c) => LINK_WRITE_PATHS.has(c.path));

test('V01 tek sunucu, iki Minecraft + iki Discord hesabı: doğru çiftler ve geri okuma', async () => {
  const plugin = createFakePlugin({ instanceId: 'mc-live' });
  plugin.issueCode(UUID_A, 'Ahmet', '9DAAAAAA');
  plugin.issueCode(UUID_B, 'Burak', '9DBBBBBB');
  const api = apiOver(createFakeBridge([plugin]));
  const a = await verify(api, '9daaaaaa', DC_A);
  const b = await verify(api, '9DBBBBBB', DC_B);
  assert.equal(a.outcome, 'linked');
  assert.equal(a.link.uuid, UUID_A);
  assert.equal(a.link.discordId, DC_A);
  assert.equal(b.link.uuid, UUID_B);
  assert.equal(plugin.linkByDiscord(DC_A).uuid, UUID_A);
  assert.equal(plugin.linkByDiscord(DC_B).uuid, UUID_B);
  assert.ok(plugin.calls.some((c) => c.path === '/api/link/v2/info'), 'başarı geri okunarak doğrulanmalı');
});

test('V02 kapsamlı kod yalnız kodu üreten sunucuya gider; diğer sunucuya hiç iş gitmez', async () => {
  const live = createFakePlugin({ instanceId: 'mc-live' });
  const testServer = createFakePlugin({ instanceId: 'mc-test' });
  live.issueCode(UUID_A, 'CanliOyuncu', '9DK7QX4M');
  testServer.issueCode(UUID_B, 'TestOyuncu', '4SK7QX4M');
  const api = apiOver(createFakeBridge([live, testServer]));
  const d = await verify(api, '4SK7QX4M', DC_B);
  assert.equal(d.outcome, 'linked');
  assert.equal(d.instance, 'mc-test');
  assert.equal(testServer.linkByDiscord(DC_B).uuid, UUID_B);
  assert.deepEqual(live.calls, [], 'kapsam dışı sunucuya yoklama bile gönderilmemeli');
});

test('V03 aynı kapsamı paylaşan iki bağımsız depoda kasıtlı aynı kod: hiçbir hesap eşlenmez', async () => {
  const b = createFakePlugin({ instanceId: 'mc-b' });
  const a559 = createFakePlugin({ instanceId: 'mc-a-559' });
  b.issueCode(UUID_A, 'Ahmet', 'UNK7QX4M');
  a559.issueCode(UUID_B, 'Zeynep', 'UNK7QX4M');
  const api = apiOver(createFakeBridge([b, a559]));
  const d = await verify(api, 'UNK7QX4M', DC_B);
  assert.equal(d.outcome, 'failed');
  assert.equal(d.failure.kind, 'code_conflict');
  assert.deepEqual([...writes(b), ...writes(a559)], []);
  assert.equal(b.linkByDiscord(DC_B), null);
  assert.equal(a559.linkByDiscord(DC_B), null);
});

test('V04 commit zaman aşımına uğrayıp işlem gerçekleşmişse aynı sunucuda uzlaştırılır', async () => {
  const live = createFakePlugin({ instanceId: 'mc-live' });
  const other = createFakePlugin({ instanceId: 'mc-test' });
  live.issueCode(UUID_A, 'Ahmet', '9DK7QX4M');
  let faulted = false;
  const bridge = createFakeBridge([live, other], {
    faults: {
      onJob: (job) => {
        if (!faulted && job.path === '/api/link/v2/verify') {
          faulted = true;
          return 'apply_then_timeout';
        }
        return null;
      },
    },
  });
  const d = await verify(apiOver(bridge), '9DK7QX4M', DC_A);
  assert.equal(d.outcome, 'linked', 'kalıcı olarak yapılan eşleme uzlaştırmayla başarı sayılmalı');
  assert.ok(live.calls.some((c) => c.path === '/api/link/v2/operation'), 'işlem kimliğiyle sorgulanmalı');
  assert.equal(writes(live).length, 1, 'aynı yazma körlemesine tekrarlanmamalı');
  assert.deepEqual(other.calls, [], 'başka sunucuya hiçbir iş gönderilmemeli');
});

test('V05 commit zaman aşımı + işlem gerçekleşmemiş: kod hatası değil erişim hatası; kod sonra çalışır', async () => {
  const live = createFakePlugin({ instanceId: 'mc-live' });
  live.issueCode(UUID_A, 'Ahmet', '9DK7QX4M');
  let faulted = false;
  const bridge = createFakeBridge([live], {
    faults: {
      onJob: (job) => {
        if (!faulted && job.path === '/api/link/v2/verify') {
          faulted = true;
          return 'timeout';
        }
        return null;
      },
    },
  });
  const api = apiOver(bridge);
  const first = await verify(api, '9DK7QX4M', DC_A);
  assert.equal(first.outcome, 'failed');
  assert.equal(first.failure.kind, 'unreachable');
  const retry = await verify(api, '9DK7QX4M', DC_A);
  assert.equal(retry.outcome, 'linked');
});

test('V06 geri okunan kayıt farklı sürümdeyse başarı gösterilmez', async () => {
  const live = createFakePlugin({ instanceId: 'mc-live' });
  live.issueCode(UUID_A, 'Ahmet', '9DK7QX4M');
  const bridge = createFakeBridge([live]);
  const original = live.handle;
  live.handle = (job) => {
    const res = original(job);
    if (String(job.path).startsWith('/api/link/v2/info') && res.data.link) {
      res.data = { ...res.data, link: { ...res.data.link, linkId: 'baska-surum' } };
    }
    return res;
  };
  const d = await verify(apiOver(bridge), '9DK7QX4M', DC_A);
  assert.equal(d.outcome, 'failed');
  assert.equal(d.failure.kind, 'state_changed');
});

test('V07 hedeflenen instance dışından gelen yanıt başarı sayılmaz', async () => {
  const live = createFakePlugin({ instanceId: 'mc-live' });
  live.issueCode(UUID_A, 'Ahmet', '9DK7QX4M');
  const bridge = createFakeBridge([live]);
  const enqueue = bridge.enqueue;
  bridge.enqueue = async (job, timeout) => ({ ...(await enqueue(job, timeout)), claimedBy: 'mc-sahte' });
  const d = await verify(apiOver(bridge), '9DK7QX4M', DC_A);
  assert.equal(d.outcome, 'failed');
  assert.equal(d.failure.kind, 'verification_mismatch');
});

test('V08 geri okuma hiç yapılamazsa sonuç "doğrulanamadı" olur, başarı değil', async () => {
  const live = createFakePlugin({ instanceId: 'mc-live' });
  live.issueCode(UUID_A, 'Ahmet', '9DK7QX4M');
  const bridge = createFakeBridge([live], {
    faults: { onJob: (job) => (String(job.path).startsWith('/api/link/v2/info') ? 'timeout' : null) },
  });
  const d = await verify(apiOver(bridge), '9DK7QX4M', DC_A);
  assert.equal(d.outcome, 'failed');
  assert.equal(d.failure.kind, 'unconfirmed');
  assert.ok(live.linkByDiscord(DC_A), 'eşleme kalıcı; kullanıcıya /link ile kontrol etmesi söylenir');
});

test('V09 plugin depo hatası (503) kod hatası olarak gösterilmez', async () => {
  const live = createFakePlugin({ instanceId: 'mc-live' });
  const bridge = createFakeBridge([live]);
  const original = live.handle;
  live.handle = (job) => (job.path === '/api/link/v2/verify'
    ? { status: 503, data: { error: 'store_unavailable', instance: 'mc-live' } }
    : original(job));
  const d = await verify(apiOver(bridge), '9DK7QX4M', DC_A);
  assert.equal(d.outcome, 'failed');
  assert.equal(d.failure.kind, 'store_unavailable');
});

test('V10 Discord başka hesaba bağlıysa 409 → zaten bağlı uyarısı', async () => {
  const live = createFakePlugin({ instanceId: 'mc-live' });
  live.issueCode(UUID_A, 'Ahmet', '9DAAAAAA');
  live.issueCode(UUID_B, 'Burak', '9DBBBBBB');
  const api = apiOver(createFakeBridge([live]));
  assert.equal((await verify(api, '9DAAAAAA', DC_A)).outcome, 'linked');
  const d = await verify(api, '9DBBBBBB', DC_A);
  assert.equal(d.failure.kind, 'already_linked_other');
  assert.equal(live.linkByDiscord(DC_A).uuid, UUID_A);
});

test('V11 kısa sürede çok fazla hatalı kod denemesi köprüye gitmeden durdurulur', async () => {
  const live = createFakePlugin({ instanceId: 'mc-live' });
  const api = apiOver(createFakeBridge([live]));
  const limiter = createAttemptLimiter();
  for (let i = 0; i < FAILED_ATTEMPT_LIMIT; i++) {
    assert.equal((await verify(api, `9DZZZZ${'23456789'[i]}2`, DC_A, { limiter })).failure.kind, 'bad_code');
  }
  const before = live.calls.length;
  const blocked = await verify(api, '9DZZZZZZ', DC_A, { limiter });
  assert.equal(blocked.failure.kind, 'too_many_attempts');
  assert.equal(live.calls.length, before, 'engellenen deneme plugin\'e gitmemeli');
});

test('V12 büyük Discord ID\'si köprü gövdesinde string kalır ve hassasiyet kaybetmez', async () => {
  const max = '18446744073709551615';
  const live = createFakePlugin({ instanceId: 'mc-live' });
  live.issueCode(UUID_A, 'Buyuk', '9DK7QX4M');
  const bridge = createFakeBridge([live]);
  const d = await verify(apiOver(bridge), '9DK7QX4M', max);
  assert.equal(d.outcome, 'linked');
  const body = bridge.jobs.find((j) => j.path === '/api/link/v2/verify').body;
  const wire = JSON.parse(JSON.stringify(body));
  assert.equal(typeof wire.discordId, 'string');
  assert.equal(wire.discordId, max);
  assert.notEqual(String(Number(max)), max, 'Number dönüşümü bu ID\'yi bozar — kullanılmamalı');
  assert.equal(live.linkByDiscord(max).uuid, UUID_A);
});

test('V13 kullanıcı adı değiştiyse güncel ad UUID üzerinden gösterilir', async () => {
  const live = createFakePlugin({ instanceId: 'mc-live' });
  live.issueCode(UUID_A, 'EskiAd', '9DK7QX4M');
  live.names.set(UUID_A, 'YeniAd');
  const d = await verify(apiOver(createFakeBridge([live])), '9DK7QX4M', DC_A);
  assert.equal(d.outcome, 'linked');
  assert.equal(d.mc, 'YeniAd');
  assert.equal(d.link.mcName, 'EskiAd');
});

test('V14 1.2.1 plugin (protokol 2 yok) tek sunucuda eski uçla çalışır ve geri okunur', async () => {
  const legacy = createFakePlugin({ instanceId: 'mc-eski', linkProtocol: 0 });
  legacy.issueCode(UUID_A, 'EskiPlugin', 'K7QX4M');
  const d = await verify(apiOver(createFakeBridge([legacy])), 'k7qx4m', DC_A);
  assert.equal(d.outcome, 'linked');
  assert.equal(d.legacy, true);
  assert.deepEqual(legacy.calls.map((c) => c.path), ['/api/link/verify', '/api/link/status']);
});

test('V15 kaybolan başarılı yanıttan sonra aynı hesabın tekrarı başarıdır, başka hesabınki değildir', async () => {
  const live = createFakePlugin({ instanceId: 'mc-live' });
  live.issueCode(UUID_A, 'Ahmet', '9DK7QX4M');
  live.handle({
    method: 'POST', path: '/api/link/v2/verify', body: { code: '9DK7QX4M', discordId: DC_A, requestId: 'kayip' },
  });
  const api = apiOver(createFakeBridge([live]));
  const same = await verify(api, '9DK7QX4M', DC_A);
  assert.equal(same.outcome, 'linked');
  assert.equal(same.replay, true);
  const other = await verify(api, '9DK7QX4M', DC_B);
  assert.equal(other.failure.kind, 'bad_code');
});
