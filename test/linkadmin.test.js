import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

/**
 * Yetkili hesap bağlantısı yönetimi (linkadmin.js): liste, bilgi, geçmiş,
 * onaylı kaldırma. Plugin modeli ile; gerçek JAR sözleşmesi entegrasyon testinde.
 */

process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret';
const dbFile = join(tmpdir(), `nautilus-linkadmin-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const { config } = await import('../src/config.js');
const {
  createLinkAdmin, createLinkAdminComponents, parseTarget, normalizeUuid,
} = await import('../src/linkadmin.js');
const { createMcApi } = await import('../src/mcapi.js');
const { linkAdminPanels } = await import('../src/db.js');
const { createFakePlugin, createFakeBridge, LINK_WRITE_PATHS } = await import('./support/fakeplugin.js');

after(() => {
  try {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true });
  } catch { /* Windows'ta açık dosya */ }
});

const SILENT = { log() {}, warn() {}, error() {} };
const UUID_A = '00000000-0000-4000-8000-00000000000a';
const UUID_B = '00000000-0000-4000-8000-00000000000b';
const DC_A = '300000000000000001';
const DC_B = '300000000000000002';
const DC_LEFT = '300000000000000009';
const ADMIN_ID = '900000000000000001';
const ADMIN2_ID = '900000000000000002';
const MOD_ID = '900000000000000003';
const MEMBER_ID = '900000000000000004';

function actor(id, tier) {
  const roleId = { admin: config.roles.admin, mod: config.roles.mod }[tier];
  return {
    id,
    tag: `${id}#0`,
    client: {},
    member: { id, guild: { ownerId: 'sunucu-sahibi' }, roles: { cache: new Set(roleId ? [roleId] : []) } },
    resolveUser: async (userId) => ({ tag: `kullanici-${userId.slice(-2)}`, inGuild: userId !== DC_LEFT }),
  };
}

function text(payload) {
  return payload.embeds.map((embed) => [
    embed.data.title, embed.data.description,
    ...(embed.data.fields ?? []).map((f) => `${f.name}: ${f.value}`),
  ].filter(Boolean).join('\n')).join('\n');
}

const buttons = (payload) => payload.components.flatMap((row) => row.components);
const idOf = (payload, prefix) => buttons(payload).find((b) => b.custom_id.startsWith(prefix))?.custom_id.split(':')[2];

function setup({ plugins = null, effects = null, clock = null } = {}) {
  let time = 1_000_000;
  const now = clock ?? (() => time);
  const list = plugins ?? [createFakePlugin({ instanceId: 'mc-live', now: () => { time += 1000; return time; } })];
  const bridge = createFakeBridge(list);
  const api = createMcApi({ queue: bridge, cfg: { mcApiUrl: '', directFallbackDisabled: false }, logger: SILENT });
  const enqueued = [];
  const service = createLinkAdmin({
    api,
    panels: linkAdminPanels,
    effects: effects ?? { enqueue: async (items) => { enqueued.push(...items); } },
    cases: () => [],
    sleep: async () => {},
    retryDelayMs: 0,
    logger: SILENT,
  });
  return {
    service, api, bridge, plugins: list, enqueued,
  };
}

function link(plugin, uuid, name, discordId, code) {
  plugin.issueCode(uuid, name, code);
  const res = plugin.handle({ method: 'POST', path: '/api/link/v2/verify', body: { code, discordId, discordTag: 'x#0' } });
  plugin.calls.pop(); // test kurulumu bot trafiği sayılmaz
  assert.equal(res.status, 200, `ön koşul: ${name} bağlanmalı`);
  return res.data.link;
}

test('L01 yetkisiz kullanıcı komut servislerine erişemez ve plugin\'e iş gitmez', async () => {
  const { service, plugins } = setup();
  const member = actor(MEMBER_ID, 'member');
  for (const payload of [
    await service.listPayload({ actor: member }),
    await service.infoPayload({ actor: member, selector: 'name', value: 'Ahmet' }),
    await service.historyPayload({ actor: member }),
    await service.prepareUnlink({ actor: member, selector: 'name', value: 'Ahmet' }),
    await service.quickUnlink({ actor: member, selector: 'name', value: 'Ahmet' }),
  ]) {
    assert.match(text(payload), /Yetki Gerekli/);
  }
  const mod = actor(MOD_ID, 'mod');
  assert.match(text(await service.prepareUnlink({ actor: mod, selector: 'name', value: 'Ahmet' })), /Admin/);
  assert.deepEqual(plugins[0].calls, [], 'yetkisiz isteklerde köprüye hiç iş gitmemeli');
  assert.doesNotMatch(text(await service.listPayload({ actor: mod })), /Yetki Gerekli/, 'moderatör listeyi görebilir');
});

test('L02 başka yetkili paneli ve butonları kullanamaz; moderatör kaldırma onayı veremez', async () => {
  const { service, plugins } = setup();
  link(plugins[0], UUID_A, 'Ahmet', DC_A, '9DAAAAAA');
  const owner = actor(ADMIN_ID, 'admin');
  const panel = await service.prepareUnlink({ actor: owner, selector: 'discord', value: DC_A });
  const panelId = idOf(panel, 'linkadm:ok:');
  assert.ok(panelId, 'onay butonu olmalı');

  assert.match(text(await service.confirmUnlink({ actor: actor(ADMIN2_ID, 'admin'), panelId })), /Sana Ait Değil/);
  assert.match(text(await service.confirmUnlink({ actor: { ...actor(ADMIN_ID, 'mod') }, panelId })), /Yetki Gerekli/);
  assert.ok(plugins[0].linkByDiscord(DC_A), 'reddedilen onaylar hiçbir şeyi silmemeli');

  const handler = createLinkAdminComponents(service).linkadm;
  const calls = [];
  const stranger = actor(ADMIN2_ID, 'admin');
  await handler({
    customId: `linkadm:ok:${panelId}`,
    user: { id: stranger.id, tag: stranger.tag },
    member: stranger.member,
    guild: null,
    client: { users: { fetch: async () => null } },
    reply: async (p) => calls.push(['reply', p]),
    deferUpdate: async () => calls.push(['deferUpdate']),
    editReply: async (p) => calls.push(['editReply', p]),
    update: async (p) => calls.push(['update', p]),
  });
  assert.deepEqual(calls.map((c) => c[0]), ['reply'], 'başkasının tıklaması sahibin mesajını değiştirmemeli');
  assert.equal(calls[0][1].flags, 64, 'ret yanıtı ephemeral olmalı');
  assert.ok(plugins[0].linkByDiscord(DC_A));
});

test('L03 çevrimdışı oyuncu adıyla onaylı unlink iki taraftan kaldırır, diğer bağlantı değişmez', async () => {
  const { service, plugins, enqueued } = setup();
  const plugin = plugins[0];
  const linkA = link(plugin, UUID_A, 'OfflineAli', DC_A, '9DAAAAAA');
  link(plugin, UUID_B, 'Burak', DC_B, '9DBBBBBB');
  const admin = actor(ADMIN_ID, 'admin');

  const panel = await service.prepareUnlink({
    actor: admin, selector: 'name', value: 'offlineali', reason: 'hesap satışı',
  });
  const confirmation = text(panel);
  assert.match(confirmation, new RegExp(UUID_A));
  assert.match(confirmation, new RegExp(`<@${DC_A}>`));
  assert.match(confirmation, /OfflineAli/);
  assert.equal(writesOf(plugin).length, 0, 'onaydan önce hiçbir şey silinmemeli');

  const done = await service.confirmUnlink({ actor: admin, panelId: idOf(panel, 'linkadm:ok:') });
  const message = text(done);
  assert.match(message, /Bağlantı Kaldırıldı/);
  assert.match(message, new RegExp(`${UUID_A}.*${DC_A}`, 's'), 'hangi çiftin kaldırıldığı yazmalı');
  assert.equal(plugin.linkByDiscord(DC_A), null);
  assert.equal(plugin.links.has(UUID_A), false);
  assert.equal(plugin.linkByDiscord(DC_B).uuid, UUID_B, 'başka bağlantı etkilenmemeli');
  const event = plugin.events.at(-1);
  assert.equal(event.action, 'unlink');
  assert.equal(event.actorId, ADMIN_ID);
  assert.equal(event.reason, 'hesap satışı');
  assert.equal(event.linkId, linkA.linkId);
  assert.deepEqual(enqueued.map((e) => e.kind).sort(), ['audit_case', 'log', 'role_cleanup']);
  assert.ok(enqueued.every((e) => e.key.includes(linkA.linkId)), 'yan işlemler bağlantı sürümüne bağlı olmalı');
});

const writesOf = (plugin) => plugin.calls.filter((call) => LINK_WRITE_PATHS.has(call.path));

test('L04 aynı unlink tekrarlanınca güvenli: bağlantı yok mesajı ve kullanılmış panel', async () => {
  const { service, plugins } = setup();
  link(plugins[0], UUID_A, 'Ahmet', DC_A, '9DAAAAAA');
  const admin = actor(ADMIN_ID, 'admin');
  const panel = await service.prepareUnlink({ actor: admin, selector: 'uuid', value: UUID_A });
  const panelId = idOf(panel, 'linkadm:ok:');
  assert.match(text(await service.confirmUnlink({ actor: admin, panelId })), /Kaldırıldı/);
  assert.match(text(await service.confirmUnlink({ actor: admin, panelId })), /Panel Kullanıldı/);
  assert.match(text(await service.prepareUnlink({ actor: admin, selector: 'uuid', value: UUID_A })), /Aktif Bağlantı Yok/);
  assert.match(text(await service.quickUnlink({ actor: admin, selector: 'discord', value: DC_A })), /bağlı değil/);
});

test('L05 panel açıldıktan sonra oyuncu unlink/relink yaptıysa eski panel yeni bağlantıyı silemez', async () => {
  const { service, plugins } = setup();
  const plugin = plugins[0];
  const first = link(plugin, UUID_A, 'Ahmet', DC_A, '9DAAAAAA');
  const admin = actor(ADMIN_ID, 'admin');
  const stalePanel = await service.prepareUnlink({ actor: admin, selector: 'discord', value: DC_A });

  plugin.handle({ method: 'POST', path: '/api/link/v2/unlink', body: { selector: 'uuid', value: UUID_A, actor: { type: 'discord_staff', id: ADMIN2_ID } } });
  const second = link(plugin, UUID_A, 'Ahmet', DC_A, '9DCCCCCC');
  assert.notEqual(second.linkId, first.linkId);

  const result = await service.confirmUnlink({ actor: admin, panelId: idOf(stalePanel, 'linkadm:ok:') });
  assert.match(text(result), /Kayıt Değişti/);
  assert.match(text(result), new RegExp(second.linkId), 'güncel kayıt gösterilmeli');
  assert.equal(plugin.linkByDiscord(DC_A).linkId, second.linkId, 'yeni bağlantı silinmemeli');
  assert.ok(idOf(result, 'linkadm:ask:'), 'güncel kayıt için yeni panel sunulmalı');
});

test('L06 onay ile plugin çağrısı arasına giren relink (zorlanmış yarış) plugin CAS ile reddedilir', async () => {
  const { service, plugins } = setup();
  const plugin = plugins[0];
  link(plugin, UUID_A, 'Ahmet', DC_A, '9DAAAAAA');
  const admin = actor(ADMIN_ID, 'admin');
  const panel = await service.prepareUnlink({ actor: admin, selector: 'uuid', value: UUID_A });
  const original = plugin.handle;
  let raced = false;
  plugin.handle = (job) => {
    if (!raced && job.path === '/api/link/v2/unlink') {
      raced = true;
      original({ method: 'POST', path: '/api/link/v2/unlink', body: { selector: 'uuid', value: UUID_A, actor: { type: 'discord_staff', id: ADMIN2_ID } } });
      link({ ...plugin, handle: original, issueCode: plugin.issueCode }, UUID_A, 'Ahmet', DC_A, '9DDDDDDD');
    }
    return original(job);
  };
  const result = await service.confirmUnlink({ actor: admin, panelId: idOf(panel, 'linkadm:ok:') });
  assert.match(text(result), /Kayıt Değişti/);
  assert.ok(plugin.linkByDiscord(DC_A), 'yarışta kurulan yeni bağlantı silinmemeli');
});

test('L07 aktif liste en son eşleşen önce, toplam sayı ve sayfalama', async () => {
  const { service, plugins } = setup();
  const plugin = plugins[0];
  for (let i = 0; i < 12; i++) {
    const uuid = `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`;
    link(plugin, uuid, `Oyuncu${i}`, `4000000000000000${String(i).padStart(2, '0')}`, `9DL${'23456789ABCD'[i]}AAAA`);
  }
  const mod = actor(MOD_ID, 'mod');
  const page1 = await service.listPayload({ actor: mod });
  const body = text(page1);
  assert.match(body, /Toplam aktif bağlantı: 12/);
  assert.ok(body.indexOf('Oyuncu11') < body.indexOf('Oyuncu10'), 'en son eşleşen önce gelmeli');
  assert.doesNotMatch(body, /Oyuncu1\b/, 'ilk sayfada 10 kayıt olmalı');
  const [prev, next] = buttons(page1);
  assert.equal(prev.disabled, true);
  assert.equal(next.disabled, false);

  const viewId = next.custom_id.split(':')[2];
  const page2 = await service.navigate({ actor: mod, view: service.view(viewId), arg: next.custom_id.split(':')[3] });
  assert.match(text(page2), /Oyuncu1\b/);
  assert.match(text(page2), /Oyuncu0\b/);
  assert.equal(buttons(page2)[1].disabled, true, 'son sayfada sonraki kapalı');
  const listCall = plugin.calls.filter((c) => c.path === '/api/link/v2/list').at(-1);
  assert.ok(listCall, 'liste plugin deposundan okunmalı');
});

test('L08 geçmiş Discord filtresiyle yalnız ilgili olayları ve ayrı aktif durumu gösterir', async () => {
  const { service, plugins } = setup();
  const plugin = plugins[0];
  link(plugin, UUID_A, 'Ahmet', DC_A, '9DAAAAAA');
  link(plugin, UUID_B, 'Burak', DC_B, '9DBBBBBB');
  plugin.handle({ method: 'POST', path: '/api/link/v2/unlink', body: { selector: 'uuid', value: UUID_A, reason: 'test', actor: { type: 'discord_staff', id: ADMIN_ID } } });
  const mod = actor(MOD_ID, 'mod');

  const forA = text(await service.historyPayload({ actor: mod, selector: 'discord', value: DC_A }));
  assert.match(forA, /Şu anki durum: ⚫ Şu anda aktif bağlantı yok/);
  assert.match(forA, /Kaldırıldı/);
  assert.match(forA, /Bağlandı/);
  assert.doesNotMatch(forA, /Burak/, 'filtre dışı olay görünmemeli');

  const forB = text(await service.historyPayload({ actor: mod, selector: 'discord', value: DC_B }));
  assert.match(forB, /Şu anki durum: 🟢 Aktif/);
  const all = text(await service.historyPayload({ actor: mod }));
  assert.match(all, /tüm hesaplar/);
});

test('L09 isim değişmiş ve sunucudan ayrılmış kullanıcı ID ile incelenebilir', async () => {
  const { service, plugins } = setup();
  const plugin = plugins[0];
  link(plugin, UUID_A, 'EskiAd', DC_LEFT, '9DAAAAAA');
  plugin.names.set(UUID_A, 'YeniAd');
  const body = text(await service.infoPayload({ actor: actor(MOD_ID, 'mod'), selector: 'discord', value: DC_LEFT }));
  assert.match(body, /YeniAd/);
  assert.match(body, /bağlanırken: EskiAd/);
  assert.match(body, /sunucuda değil/);
  assert.match(body, new RegExp(DC_LEFT));
  const byNewName = text(await service.infoPayload({ actor: actor(MOD_ID, 'mod'), selector: 'name', value: 'yenIAD' }));
  assert.match(byNewName, new RegExp(UUID_A));
});

test('L10 çoklu sunucuda hedef seçilmeden işlem yok; seçilen sunucudaki kayıt kaldırılır', async () => {
  const live = createFakePlugin({ instanceId: 'mc-live' });
  const testServer = createFakePlugin({ instanceId: 'mc-test' });
  link(live, UUID_A, 'Ahmet', DC_A, '9DAAAAAA');
  link(testServer, UUID_A, 'Ahmet', DC_A, '4SAAAAAA');
  const { service } = setup({ plugins: [live, testServer] });
  const admin = actor(ADMIN_ID, 'admin');

  assert.match(text(await service.listPayload({ actor: admin })), /Sunucu Seçimi Gerekli/);
  assert.match(text(await service.prepareUnlink({ actor: admin, selector: 'uuid', value: UUID_A })), /Sunucu Seçimi Gerekli/);
  assert.deepEqual([...live.calls, ...testServer.calls], []);

  const panel = await service.prepareUnlink({ actor: admin, selector: 'uuid', value: UUID_A, instance: 'mc-test' });
  await service.confirmUnlink({ actor: admin, panelId: idOf(panel, 'linkadm:ok:') });
  assert.equal(testServer.linkByDiscord(DC_A), null, 'seçilen sunucudaki kayıt kaldırılmalı');
  assert.ok(live.linkByDiscord(DC_A), 'diğer bağımsız depo değişmemeli');
  assert.deepEqual(live.calls, []);
});

test('L11 yan işlem kuyruğu hata verse de kalıcı unlink başarısı gösterilir', async () => {
  const { service, plugins } = setup({ effects: { enqueue: async () => { throw new Error('bot DB kilitli'); } } });
  link(plugins[0], UUID_A, 'Ahmet', DC_A, '9DAAAAAA');
  const admin = actor(ADMIN_ID, 'admin');
  const panel = await service.prepareUnlink({ actor: admin, selector: 'uuid', value: UUID_A });
  assert.match(text(await service.confirmUnlink({ actor: admin, panelId: idOf(panel, 'linkadm:ok:') })), /Bağlantı Kaldırıldı/);
});

test('L12 kaldırma yanıtı zaman aşımına uğrarsa aynı işlem uzlaştırılır', async () => {
  const live = createFakePlugin({ instanceId: 'mc-live' });
  link(live, UUID_A, 'Ahmet', DC_A, '9DAAAAAA');
  const bridge = createFakeBridge([live], {
    faults: { onJob: (job) => (job.path === '/api/link/v2/unlink' ? 'apply_then_timeout' : null) },
  });
  const api = createMcApi({ queue: bridge, cfg: { mcApiUrl: '' }, logger: SILENT });
  const service = createLinkAdmin({
    api, panels: linkAdminPanels, effects: { enqueue: async () => {} }, cases: () => [], sleep: async () => {}, logger: SILENT,
  });
  const admin = actor(ADMIN_ID, 'admin');
  const panel = await service.prepareUnlink({ actor: admin, selector: 'uuid', value: UUID_A });
  const result = await service.confirmUnlink({ actor: admin, panelId: idOf(panel, 'linkadm:ok:') });
  assert.match(text(result), /Bağlantı Kaldırıldı/);
  assert.equal(live.calls.filter((c) => c.path === '/api/link/v2/unlink').length, 1, 'kaldırma körlemesine tekrarlanmamalı');
});

test('L13 belirsiz isimde aday listesi gösterilir; panel ve silme yok', async () => {
  const { service, plugins } = setup();
  const plugin = plugins[0];
  link(plugin, UUID_A, 'Ikiz', DC_A, '9DAAAAAA');
  plugin.names.set(UUID_B, 'IKIZ');
  const payload = await service.prepareUnlink({ actor: actor(ADMIN_ID, 'admin'), selector: 'name', value: 'ikiz' });
  assert.match(text(payload), /Oyuncu Adı Belirsiz/);
  assert.match(text(payload), new RegExp(UUID_A));
  assert.match(text(payload), new RegExp(UUID_B));
  assert.deepEqual(payload.components, []);
  assert.ok(plugin.linkByDiscord(DC_A));
});

test('L14 buton akışı: sebep modalı, sebepli onay ve vazgeç', async () => {
  const { service, plugins } = setup();
  const plugin = plugins[0];
  link(plugin, UUID_A, 'Ahmet', DC_A, '9DAAAAAA');
  link(plugin, UUID_B, 'Burak', DC_B, '9DBBBBBB');
  const admin = actor(ADMIN_ID, 'admin');
  const handler = createLinkAdminComponents(service).linkadm;
  const interaction = (customId, fields = {}) => {
    const calls = [];
    return {
      calls,
      customId,
      user: { id: admin.id, tag: admin.tag },
      member: admin.member,
      guild: null,
      client: { users: { fetch: async () => null } },
      fields: { getTextInputValue: (key) => fields[key] ?? '' },
      reply: async (p) => calls.push(['reply', p]),
      deferUpdate: async () => calls.push(['deferUpdate']),
      editReply: async (p) => calls.push(['editReply', p]),
      update: async (p) => calls.push(['update', p]),
      showModal: async (p) => calls.push(['showModal', p]),
    };
  };

  const panelA = await service.prepareUnlink({ actor: admin, selector: 'uuid', value: UUID_A });
  const idA = idOf(panelA, 'linkadm:ok:');
  const why = interaction(`linkadm:why:${idA}`);
  await handler(why);
  assert.equal(why.calls[0][0], 'showModal');
  assert.equal(why.calls[0][1].custom_id, `linkadm:reason:${idA}`);
  const submit = interaction(`linkadm:reason:${idA}`, { reason: ' kural ihlali ' });
  await handler(submit);
  assert.deepEqual(submit.calls.map((c) => c[0]), ['deferUpdate', 'editReply']);
  assert.match(text(submit.calls[1][1]), /Sebep: kural ihlali/);
  assert.equal(plugin.events.at(-1).reason, 'kural ihlali');

  const panelB = await service.prepareUnlink({ actor: admin, selector: 'uuid', value: UUID_B });
  const cancel = interaction(`linkadm:no:${idOf(panelB, 'linkadm:ok:')}`);
  await handler(cancel);
  assert.match(text(cancel.calls[0][1]), /Vazgeçildi/);
  assert.ok(plugin.linkByDiscord(DC_B), 'vazgeçince bağlantı kalmalı');
  const reuse = interaction(`linkadm:ok:${idOf(panelB, 'linkadm:ok:')}`);
  await handler(reuse);
  assert.match(text({ embeds: reuse.calls[0][1].embeds }), /Panel Kullanıldı/);
});

test('L15 hedef ayrıştırma: tek hedef, string Discord ID, UUID normalizasyonu', () => {
  assert.equal(parseTarget({}).ok, false);
  assert.equal(parseTarget({ name: 'A', discordId: '1' }).ok, false);
  assert.deepEqual(parseTarget({ discordId: ' 18446744073709551615 ' }), { ok: true, selector: 'discord', value: '18446744073709551615' });
  assert.equal(parseTarget({ discordId: '12a' }).ok, false);
  assert.equal(parseTarget({ name: 'iki kelime' }).ok, false);
  assert.equal(normalizeUuid('0000000000004000800000000000000A'), '00000000-0000-4000-8000-00000000000a');
  assert.equal(normalizeUuid('olmayan'), null);
  assert.deepEqual(parseTarget({}, { required: false }), { ok: true, selector: null, value: null });
});

test('L16 eski plugin: yönetim listesi güncelleme ister, /kayıtsil eski uçla çalışır', async () => {
  const legacy = createFakePlugin({ instanceId: 'mc-eski', linkProtocol: 0 });
  legacy.issueCode(UUID_A, 'Ahmet', 'K7QX4M');
  legacy.handle({ method: 'POST', path: '/api/link/verify', body: { code: 'K7QX4M', discordId: DC_A } });
  const { service } = setup({ plugins: [legacy] });
  const admin = actor(ADMIN_ID, 'admin');
  assert.match(text(await service.listPayload({ actor: admin })), /Plugin Güncel Değil/);
  const res = await service.quickUnlink({ actor: admin, selector: 'discord', value: DC_A });
  assert.match(text(res), /Bağlantı Kaldırıldı/);
  assert.equal(legacy.linkByDiscord(DC_A), null);
});
