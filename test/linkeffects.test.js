import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

/**
 * Hesap bağlama yan işlemleri (linkeffects.js): kalıcı eşleme/kaldırma sonrası
 * audit/log/rol işleri sınırlı ve idempotent yeniden denenir; eski olaylar yeni
 * bağlantının rollerini bozamaz; yalnız tier rolleri temizlenir.
 */

process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret';
const dbFile = join(tmpdir(), `nautilus-linkeffects-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const { config } = await import('../src/config.js');
const {
  createLinkEffects, createDefaultHandlers, linkCreatedEffects, linkRemovedEffects, handleLinkRemovedEvent,
  MAX_ATTEMPTS, RETRY_DELAYS_MS,
} = await import('../src/linkeffects.js');
const { linkSideEffects, setSetting, db } = await import('../src/db.js');
const { createMcApi } = await import('../src/mcapi.js');
const { createFakePlugin, createFakeBridge } = await import('./support/fakeplugin.js');

after(() => {
  try {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true });
  } catch { /* Windows'ta açık dosya */ }
});

const SILENT = { log() {}, warn() {}, error() {} };
const DC = '300000000000000001';
const UUID_A = '00000000-0000-4000-8000-00000000000a';

function guildWith(member) {
  const roles = new Map([
    ['tier-altin', { id: 'tier-altin', position: 5, managed: false }],
    ['tier-elmas', { id: 'tier-elmas', position: 6, managed: false }],
    ['vip', { id: 'vip', position: 7, managed: false }],
  ]);
  return {
    id: config.guildId,
    roles: { cache: { get: (id) => roles.get(id) } },
    members: {
      me: { roles: { highest: { position: 50 } } },
      fetch: async (id) => (member && id === member.id ? member : Promise.reject(new Error('yok'))),
    },
  };
}

function memberWith(roleIds) {
  const cache = new Map(roleIds.map((id) => [id, true]));
  return {
    id: DC,
    roles: {
      cache,
      add: async (id) => { cache.set(id, true); },
      remove: async (id) => { cache.delete(id); },
    },
  };
}

const clientFor = (guild) => ({ guilds: { cache: { get: (id) => (id === config.guildId ? guild : null) } } });

test('E01 kalıcı hata sınırlı sayıda geri çekilerek denenir ve görünür kalır', async () => {
  let now = 10_000;
  let attempts = 0;
  const effects = createLinkEffects({
    store: linkSideEffects,
    handlers: { log: async () => { attempts += 1; throw new Error('log kanalı erişilemez'); } },
    now: () => now,
    logger: SILENT,
  });
  await effects.enqueue([{ key: 'test:e01:log', kind: 'log', payload: {} }], { client: {} });
  for (const delay of RETRY_DELAYS_MS) {
    now += delay;
    await effects.processDue({ client: {} });
  }
  now += 10 * 3600_000;
  await effects.processDue({ client: {} });
  const row = linkSideEffects.get('test:e01:log');
  assert.equal(attempts, MAX_ATTEMPTS, 'deneme sayısı sınırlı olmalı');
  assert.equal(row.status, 'failed');
  assert.match(row.last_error, /log kanalı erişilemez/);
  assert.ok(linkSideEffects.recentProblems(5).some((p) => p.effect_key === 'test:e01:log'));
});

test('E02 aynı yan işlem anahtarı ikinci kez kuyruğa girmez (işlem başına bir kez)', async () => {
  let runs = 0;
  const effects = createLinkEffects({ handlers: { audit_case: async () => { runs += 1; } }, logger: SILENT });
  const items = linkCreatedEffects({
    link: { uuid: UUID_A, discordId: DC, linkId: 'surum-e02', mcName: 'Ahmet' }, requestId: 'rid',
  }).filter((e) => e.kind === 'audit_case');
  await effects.enqueue(items, { client: {} });
  await effects.enqueue(items, { client: {} });
  assert.equal(runs, 1);
});

test('E03 unlink sonrası rol temizliği yalnız tier rollerini söker, ilgisiz rolleri korur', async () => {
  setSetting('elo_role_map', JSON.stringify({ 'altın': 'tier-altin', elmas: 'tier-elmas' }));
  const plugin = createFakePlugin({ instanceId: 'mc-live' });
  const api = createMcApi({ queue: createFakeBridge([plugin]), cfg: { mcApiUrl: '' }, logger: SILENT });
  const member = memberWith(['tier-altin', 'vip']);
  const handlers = createDefaultHandlers({ api });
  const note = await handlers.role_cleanup({ discordId: DC, instance: 'mc-live' }, { client: clientFor(guildWith(member)) });
  assert.equal(note, 'tier rolleri kaldırıldı');
  assert.deepEqual([...member.roles.cache.keys()], ['vip']);
});

test('E04 gecikmiş temizlik, o arada yeniden bağlanan hesabın rollerini sökmez', async () => {
  setSetting('elo_role_map', JSON.stringify({ 'altın': 'tier-altin' }));
  const plugin = createFakePlugin({ instanceId: 'mc-live' });
  plugin.issueCode(UUID_A, 'Ahmet', '9DAAAAAA');
  plugin.handle({ method: 'POST', path: '/api/link/v2/verify', body: { code: '9DAAAAAA', discordId: DC } });
  const api = createMcApi({ queue: createFakeBridge([plugin]), cfg: { mcApiUrl: '' }, logger: SILENT });
  const member = memberWith(['tier-altin']);
  const note = await createDefaultHandlers({ api }).role_cleanup(
    { discordId: DC, linkId: 'eski-surum', instance: 'mc-live' },
    { client: clientFor(guildWith(member)) },
  );
  assert.match(note, /yeniden bağlanmış/);
  assert.ok(member.roles.cache.has('tier-altin'));
});

test('E05 eski bağlantı sürümüne ait rol senkronu yeni bağlantıda çalışmaz', async () => {
  setSetting('elo_role_map', JSON.stringify({ 'altın': 'tier-altin' }));
  const plugin = createFakePlugin({ instanceId: 'mc-live' });
  plugin.issueCode(UUID_A, 'Ahmet', '9DAAAAAA');
  plugin.handle({ method: 'POST', path: '/api/link/v2/verify', body: { code: '9DAAAAAA', discordId: DC } });
  const api = createMcApi({ queue: createFakeBridge([plugin]), cfg: { mcApiUrl: '' }, logger: SILENT });
  const member = memberWith([]);
  const note = await createDefaultHandlers({ api }).role_sync(
    { discordId: DC, linkId: 'kaldirilmis-surum', instance: 'mc-live' },
    { client: clientFor(guildWith(member)) },
  );
  assert.match(note, /bağlantı değişti/);
  assert.equal(member.roles.cache.size, 0);
});

test('E06 bağlantı durumu okunamazsa rol işlemi hata verir (sonra yeniden denenir), sessizce atlanmaz', async () => {
  setSetting('elo_role_map', JSON.stringify({ 'altın': 'tier-altin' }));
  const plugin = createFakePlugin({ instanceId: 'mc-live' });
  const bridge = createFakeBridge([plugin], { faults: { onJob: () => 'timeout' } });
  const api = createMcApi({ queue: bridge, cfg: { mcApiUrl: '' }, logger: SILENT });
  await assert.rejects(
    createDefaultHandlers({ api }).role_cleanup({ discordId: DC, instance: 'mc-live' }, { client: clientFor(guildWith(memberWith([]))) }),
    /okunamadı/,
  );
});

test('E07 audit tablosu hatası kaydedilir ve yeniden denenecek şekilde kalır', async () => {
  const effects = createLinkEffects({ logger: SILENT });
  db.exec('DROP TABLE IF EXISTS cases');
  const items = linkRemovedEffects({
    link: { uuid: UUID_A, discordId: DC, linkId: 'surum-e07', mcName: 'Ahmet' },
    actorId: '900000000000000001',
    reason: 'test',
    requestId: 'rid-e07',
  }).filter((e) => e.kind === 'audit_case');
  await effects.enqueue(items, { client: {} });
  const row = linkSideEffects.get('unlink:surum-e07:audit');
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /no such table/);
});

test('E08 oyun içi link_removed eventi rol temizliğini kuyruğa alır; test eventi almaz', async () => {
  const seen = [];
  const effects = { enqueue: async (items) => { seen.push(...items); } };
  await handleLinkRemovedEvent({}, { type: 'link_removed', test: true, data: { discordId: DC } }, effects);
  await handleLinkRemovedEvent({}, { type: 'link_removed', eventId: 'evt-1', data: { discordId: '12a' } }, effects);
  assert.equal(seen.length, 0);
  await handleLinkRemovedEvent({}, { type: 'link_removed', eventId: 'evt-2', data: { discordId: DC, mc: 'Ahmet' } }, effects);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'role_cleanup');
  assert.equal(seen[0].key, 'event:evt-2:roles');
  assert.equal(seen[0].payload.discordId, DC);
});

test('E09 log kanalı ayarlı değilse log işi tamamlandı sayılır; kanal hatası yeniden denenir', async () => {
  const handlers = createDefaultHandlers();
  setSetting('log_channel', '');
  assert.equal(await handlers.log({ title: 't', fields: [] }, { client: {} }), 'log kanalı ayarlı değil');
  setSetting('log_channel', '123');
  await assert.rejects(handlers.log({ title: 't', fields: [] }, {
    client: { channels: { fetch: async () => { throw new Error('Missing Access'); } } },
  }), /Missing Access/);
  setSetting('log_channel', '');
});
