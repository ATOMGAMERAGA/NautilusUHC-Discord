import { getSetting, setSetting, addCase } from './db.js';
import { mcapi } from './mcapi.js';
import { config } from './config.js';

/**
 * ELO tier ↔ Discord rol senkronu.
 *
 * Saf çekirdek: tierRoleSpecs / roleMap / computeRoleChanges hiçbir discord.js
 * tipi kullanmaz (testler npm install olmadan koşar). Discord I/O yapan
 * ensureTierRoles / syncMemberTierRole yalnız çağrı anında guild nesnesine
 * dokunur — enjekte edilebilir, testte düz nesneyle taklit edilir.
 *
 * Rol eşlemesi settings 'elo_role_map' anahtarında JSON olarak durur:
 *   { "<tier adı lowercase>": "<roleId>" }
 */

/**
 * 6 tier rolünün kanonik tanımı. İsimler plugin EloTier.displayName() ve
 * ranks.js DEFAULT_RANKS ile birebirdir; renkler tier kimliğine uygun seçildi
 * (bakır tonu, demir gümüşü, altın, zümrüt yeşili, elmas camgöbeği,
 * netherite koyu moru).
 */
export const TIER_ROLE_SPECS = [
  { name: 'Netherite', color: 0x5c4e5f },
  { name: 'Elmas', color: 0x4fdcec },
  { name: 'Zümrüt', color: 0x2ecc71 },
  { name: 'Altın', color: 0xe8b64a },
  { name: 'Demir', color: 0xc7ccd1 },
  { name: 'Bakır', color: 0xb87333 },
];

export function tierRoleSpecs() {
  return TIER_ROLE_SPECS;
}

/** Mevcut tier→rol eşlemesi (bozuk JSON'da boş nesneye düşer). */
export function roleMap() {
  const raw = getSetting('elo_role_map', '');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveRoleMap(map) {
  setSetting('elo_role_map', JSON.stringify(map));
}

/** Tek tier için rol eşlemesini günceller (tier adı lowercase anahtarlanır). */
export function setTierRole(tierName, roleId) {
  const map = roleMap();
  map[String(tierName).toLowerCase()] = roleId;
  saveRoleMap(map);
  return map;
}

/**
 * Saf karar fonksiyonu: üyenin mevcut rollerinden hangi tier rolleri
 * kaldırılmalı, hangisi eklenmeli?
 *
 * @param {string[]} memberRoleIds üyenin şu anki rol id'leri
 * @param {object} map tier→roleId eşlemesi
 * @param {string} newTierName hedef tier adı (örn. "Zümrüt")
 * @returns {{ add: string|null, remove: string[] }}
 */
export function computeRoleChanges(memberRoleIds, map, newTierName) {
  const want = map[String(newTierName ?? '').toLowerCase()] ?? null;
  const tierRoleIds = new Set(Object.values(map).filter(Boolean));
  const remove = [...new Set(memberRoleIds)].filter((id) => tierRoleIds.has(id) && id !== want);
  const add = want && !memberRoleIds.includes(want) ? want : null;
  return { add, remove };
}

/** Rol bota atanabilir mi? (yönetilen değil + botun en yüksek rolünün altında) */
function assignable(guild, role) {
  const me = guild.members.me;
  if (!role || role.managed) return false;
  return me?.roles?.highest ? role.position < me.roles.highest.position : false;
}

/**
 * 6 tier rolünü garanti eder: eşlemedeki geçerli rolü yeniden kullanır,
 * yoksa aynı isimli mevcut rolü bulur, o da yoksa doğru renkle OLUŞTURUR.
 * Rol id'lerini elo_role_map'e yazar.
 */
export async function ensureTierRoles(guild) {
  const me = guild.members.me;
  if (!me?.permissions?.has?.('ManageRoles')) {
    return { ok: false, error: 'Botun **Rolleri Yönet** izni yok — rol oluşturamam.' };
  }
  const map = roleMap();
  const results = [];
  for (const spec of TIER_ROLE_SPECS) {
    const key = spec.name.toLowerCase();
    let role = map[key] ? guild.roles.cache.get(map[key]) : null;
    let created = false;
    if (!role) {
      role = guild.roles.cache.find?.((r) => r.name === spec.name && !r.managed) ?? null;
    }
    if (!role) {
      try {
        role = await guild.roles.create({
          name: spec.name,
          color: spec.color,
          hoist: false,
          mentionable: false,
          permissions: [],
          reason: 'NautilusUHC ELO tier rolü (/admin elorank rolkur)',
        });
        created = true;
      } catch (err) {
        return { ok: false, error: `**${spec.name}** rolü oluşturulamadı: ${err.message}`, results };
      }
    }
    map[key] = role.id;
    results.push({ name: spec.name, roleId: role.id, created });
  }
  saveRoleMap(map);
  return { ok: true, results };
}

/**
 * Bir üyenin tier rolünü hedef tier'a göre düzeltir. Hiyerarşi dışı veya
 * yönetilen roller sessizce atlanır (loglanır). @returns {{ok, changed?, error?}}
 */
export async function syncMemberTierRole(guild, discordId, tierName, { actorId = null } = {}) {
  const map = roleMap();
  if (!Object.keys(map).length) {
    return { ok: false, error: 'Tier rol eşlemesi yok. Önce `/admin elorank rolkur` çalıştır.' };
  }
  // Hedef tier eşlenmemişse hiçbir şey yapma — aksi halde üyenin mevcut tier
  // rollerini söker ama yerine ekleyecek rol bulamaz (yarım-uygulama). Kısmi
  // eşleme (/admin elorank rol ile tek tier) desteklendiği için bu gerçek bir yol.
  if (!map[String(tierName ?? '').toLowerCase()]) {
    return { ok: true, changed: false };
  }
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) {
    return { ok: false, error: 'Üye sunucuda bulunamadı.' };
  }
  const current = [...member.roles.cache.keys()];
  const { add, remove } = computeRoleChanges(current, map, tierName);
  // Ekleme rolü botun yetkisinin üstündeyse HİÇBİR şey yapma (yarım-uygulama
  // önlenir: önce söküp sonra ekleyememektense hiç dokunma).
  if (add && !assignable(guild, guild.roles.cache.get(add))) {
    return { ok: false, error: 'Tier rolü botun yetkisinin üstünde — rol sıralamasını düzelt.' };
  }
  let changed = false;
  for (const roleId of remove) {
    const role = guild.roles.cache.get(roleId);
    if (!assignable(guild, role)) {
      console.warn(`[rolesync] rol kaldırılamıyor (hiyerarşi/managed): ${roleId}`);
      continue;
    }
    await member.roles.remove(roleId, 'ELO tier senkronu');
    changed = true;
  }
  if (add) {
    await member.roles.add(add, 'ELO tier senkronu');
    changed = true;
  }
  if (changed) {
    addCase('elorank_sync', discordId, actorId ?? 'system', null, String(tierName));
  }
  return { ok: true, changed };
}

/**
 * Köprü tier_change eventi hook'u: bağlı hesabı bulur ve rolü senkronlar.
 * Test eventleri ve bağlantısız oyuncular sessizce atlanır.
 */
export async function handleTierChangeEvent(client, envelope) {
  if (envelope?.type !== 'tier_change' || envelope.test) return;
  const player = envelope.data?.player;
  const newTier = envelope.data?.newTier;
  if (!player || !newTier) return;
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return;
  const link = await mcapi.linkStatus(`mc=${encodeURIComponent(player)}`);
  if (!link.ok || !link.linked || !link.discordId) return;
  const res = await syncMemberTierRole(guild, link.discordId, newTier);
  if (!res.ok) {
    console.warn(`[rolesync] ${player} → ${newTier} senkronlanamadı: ${res.error}`);
  }
}
