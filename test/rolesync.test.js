import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// config.js DISCORD_TOKEN ister; db.js dosya açar — dinamik importtan ÖNCE ayarla.
process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret';
const dbFile = join(tmpdir(), `nautilus-rolesync-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const {
  TIER_ROLE_SPECS, tierRoleSpecs, roleMap, setTierRole, computeRoleChanges, ensureTierRoles,
  syncMemberTierRole,
} = await import('../src/rolesync.js');
const { DEFAULT_RANKS } = await import('../src/ranks.js');
const { setSetting } = await import('../src/db.js');

after(() => {
  try { rmSync(dbFile); rmSync(`${dbFile}-wal`, { force: true }); rmSync(`${dbFile}-shm`, { force: true }); } catch {}
});

/* ---------------- saf çekirdek ---------------- */

test('tierRoleSpecs: 6 tier, isimler ranks.js DEFAULT_RANKS ile birebir', () => {
  const specs = tierRoleSpecs();
  assert.equal(specs.length, 6);
  const specNames = specs.map((s) => s.name).sort();
  const rankNames = DEFAULT_RANKS.map((r) => r.name).sort();
  assert.deepEqual(specNames, rankNames, 'tier rol adları plugin/site/bot merdiveniyle aynı olmalı');
  for (const s of specs) {
    assert.ok(Number.isInteger(s.color) && s.color >= 0 && s.color <= 0xffffff,
      `${s.name} rengi geçerli olmalı`);
  }
});

test('computeRoleChanges: terfi eski tier rolünü söker, yenisini ekler', () => {
  const map = { 'altın': 'R_GOLD', 'zümrüt': 'R_EMERALD' };
  const { add, remove } = computeRoleChanges(['R_GOLD', 'R_OTHER'], map, 'Zümrüt');
  assert.equal(add, 'R_EMERALD');
  assert.deepEqual(remove, ['R_GOLD']);
});

test('computeRoleChanges: rol zaten doğruysa değişiklik yok', () => {
  const map = { 'elmas': 'R_DIA' };
  const { add, remove } = computeRoleChanges(['R_DIA'], map, 'Elmas');
  assert.equal(add, null);
  assert.deepEqual(remove, []);
});

test('computeRoleChanges: eşlenmemiş tier yalnız mevcut tier rollerini söker', () => {
  const map = { 'bakır': 'R_COP' };
  const { add, remove } = computeRoleChanges(['R_COP', 'R_UNRELATED'], map, 'Netherite');
  assert.equal(add, null);
  assert.deepEqual(remove, ['R_COP'], 'tier dışı roller asla sökülmez');
});

test('roleMap: bozuk JSON boş nesneye düşer, setTierRole lowercase anahtarlar', () => {
  setSetting('elo_role_map', 'bozuk{json');
  assert.deepEqual(roleMap(), {});
  setTierRole('Zümrüt', '123');
  assert.equal(roleMap()['zümrüt'], '123');
  setSetting('elo_role_map', '');
});

/* ---------------- Discord I/O (düz nesne mock'larıyla) ---------------- */

function mockGuild({ manageRoles = true } = {}) {
  const roles = new Map();
  const members = new Map();
  let nextId = 1;
  const guild = {
    _roles: roles,
    _members: members,
    roles: {
      cache: {
        get: (id) => roles.get(id),
        find: (fn) => [...roles.values()].find(fn),
      },
      create: async ({ name, color }) => {
        const role = { id: `r${nextId++}`, name, color, managed: false, position: 1 };
        roles.set(role.id, role);
        return role;
      },
    },
    members: {
      me: {
        permissions: { has: () => manageRoles },
        roles: { highest: { position: 99 } },
      },
      fetch: async (id) => members.get(id) ?? Promise.reject(new Error('yok')),
    },
  };
  return guild;
}

function mockMember(guild, id, roleIds = []) {
  const cache = new Map(roleIds.map((r) => [r, true]));
  const member = {
    id,
    roles: {
      cache,
      add: async (roleId) => { cache.set(roleId, true); },
      remove: async (roleId) => { cache.delete(roleId); },
    },
  };
  guild._members.set(id, member);
  return member;
}

test('ensureTierRoles: 6 rolü doğru renkle oluşturur, ikinci çağrı yeniden kullanır', async () => {
  setSetting('elo_role_map', '');
  const guild = mockGuild();
  const first = await ensureTierRoles(guild);
  assert.equal(first.ok, true);
  assert.equal(first.results.length, 6);
  assert.ok(first.results.every((r) => r.created), 'ilk kuruluşta hepsi yeni olmalı');
  const bakir = [...guild._roles.values()].find((r) => r.name === 'Bakır');
  assert.equal(bakir.color, 0xb87333, 'Bakır rengi bakır tonu olmalı');

  const second = await ensureTierRoles(guild);
  assert.equal(second.ok, true);
  assert.ok(second.results.every((r) => !r.created), 'ikinci çağrı mevcut rolleri kullanmalı');
  assert.equal(guild._roles.size, 6, 'ikinci çağrı yeni rol üretmemeli');
  assert.equal(Object.keys(roleMap()).length, 6, 'eşleme settings\'e yazılmalı');
});

test('ensureTierRoles: aynı isimli mevcut rol varsa onu benimser', async () => {
  setSetting('elo_role_map', '');
  const guild = mockGuild();
  guild._roles.set('existing', { id: 'existing', name: 'Elmas', managed: false, position: 1 });
  const res = await ensureTierRoles(guild);
  assert.equal(res.ok, true);
  const elmas = res.results.find((r) => r.name === 'Elmas');
  assert.equal(elmas.roleId, 'existing');
  assert.equal(elmas.created, false);
});

test('ensureTierRoles: Rolleri Yönet izni yoksa Türkçe hata döner', async () => {
  const guild = mockGuild({ manageRoles: false });
  const res = await ensureTierRoles(guild);
  assert.equal(res.ok, false);
  assert.match(res.error, /Rolleri Yönet/);
});

test('syncMemberTierRole: rolü değiştirir ve changed bildirir', async () => {
  setSetting('elo_role_map', '');
  const guild = mockGuild();
  await ensureTierRoles(guild);
  const map = roleMap();
  const member = mockMember(guild, 'u1', [map['bakır']]);

  const res = await syncMemberTierRole(guild, 'u1', 'Altın');
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.ok(member.roles.cache.has(map['altın']), 'yeni tier rolü eklenmeli');
  assert.ok(!member.roles.cache.has(map['bakır']), 'eski tier rolü sökülmeli');

  const again = await syncMemberTierRole(guild, 'u1', 'Altın');
  assert.equal(again.changed, false, 'rol doğruysa tekrar dokunulmaz');
  setSetting('elo_role_map', '');
});

test('syncMemberTierRole: eşleme yokken kurulum hatası döner', async () => {
  setSetting('elo_role_map', '');
  const res = await syncMemberTierRole(mockGuild(), 'u1', 'Altın');
  assert.equal(res.ok, false);
  assert.match(res.error, /rolkur/);
});

/* ---------------- toplu senkron veri kaynağı ---------------- */

test('collectTierLinks: plugin 1.2.2 tek sunucuda tier UUID üzerinden, sayfa sayfa okunur', async () => {
  const { collectTierLinks } = await import('../src/rolesync.js');
  const pages = [];
  const api = {
    bridgeStatus: () => ({ ok: true, transport: 'reverse', instanceMeta: [{ id: 'mc-live', linkProtocol: 2 }] }),
    linkList: async ({ offset }, { targetInstance }) => {
      pages.push([offset, targetInstance]);
      const all = Array.from({ length: 30 }, (_, i) => ({
        uuid: `u${i}`, discordId: `4000000000000000${String(i).padStart(2, '0')}`, tier: i % 2 ? 'Altın' : null,
      }));
      return { ok: true, total: all.length, links: all.slice(offset, offset + 25) };
    },
    links: async () => assert.fail('ada göre eşleyen eski uç kullanılmamalı'),
  };
  const res = await collectTierLinks(api);
  assert.equal(res.ok, true);
  assert.equal(res.source, 'uuid');
  assert.deepEqual(pages, [[0, 'mc-live'], [25, 'mc-live']]);
  assert.equal(res.links.length, 15, 'tier bilgisi olmayanlar atlanır');
  assert.equal(typeof res.links[0].discordId, 'string');
});

test('collectTierLinks: eski plugin ya da çoklu sunucuda eski uca düşer', async () => {
  const { collectTierLinks } = await import('../src/rolesync.js');
  const api = {
    bridgeStatus: () => ({ ok: true, transport: 'reverse', instanceMeta: [{ id: 'mc-eski', linkProtocol: 0 }] }),
    links: async () => ({ ok: true, links: [{ discordId: '1', tier: 'Demir' }, { discordId: '2' }] }),
  };
  const res = await collectTierLinks(api);
  assert.equal(res.source, 'legacy');
  assert.deepEqual(res.links, [{ discordId: '1', tier: 'Demir' }]);
});
