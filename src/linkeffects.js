import { linkSideEffects, addCase } from './db.js';
import { sendLogStrict } from './modlog.js';
import { Colors } from './embeds.js';
import { mcapi } from './mcapi.js';
import { config } from './config.js';
import { syncMemberTierRole, removeTierRoles, roleMap } from './rolesync.js';
import { codeText } from './util.js';

/**
 * HESAP BAĞLAMA YAN İŞLEMLERİ (outbox).
 *
 * Kalıcı eşleme/kaldırma plugin deposunda gerçekleştikten SONRA çalışan işler:
 * bot audit kaydı (cases), log kanalı kartı, ELO tier rolleri. Bunların hatası
 * kullanıcıya "eşleme başarısız" dedirtemez; kayıt kalıcı kuyruğa yazılır,
 * sınırlı sayıda geri çekilerek yeniden denenir ve kalıcı başarısızlık
 * /sağlık ile loglarda görünür kalır.
 *
 * Her yan işlemin anahtarı bağlantı sürümüne (linkId) bağlıdır: aynı işlem
 * (ör. kaybolan yanıtın tekrarı) ikinci kez kuyruğa girmez. Rol işlemleri
 * çalışmadan önce bağlantının hâlâ aynı sürümde olduğunu yeniden okur; eski bir
 * işlem yeni bağlantının rollerini bozamaz.
 */

export const RETRY_DELAYS_MS = Object.freeze([30_000, 120_000, 600_000, 1_800_000, 3_600_000]);
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const TICK_MS = 20_000;

/** Yeni bağlantı sonrası yan işlemler. */
export function linkCreatedEffects({
  link, discordId, discordTag = null, mc = null, instance = null, requestId,
}) {
  const id = String(link?.discordId ?? discordId);
  const name = link?.currentName ?? link?.mcName ?? mc ?? '?';
  const version = link?.linkId ?? `legacy:${link?.uuid ?? id}:${requestId}`;
  return [
    {
      key: `link:${version}:audit`,
      kind: 'audit_case',
      payload: {
        action: 'link_create', userId: id, modId: id, reason: null,
        detail: link?.uuid ? `${name} (${link.uuid})` : name,
      },
    },
    {
      key: `link:${version}:log`,
      kind: 'log',
      payload: {
        title: 'Hesap Bağlandı',
        color: 'success',
        fields: [
          { name: 'Kullanıcı', value: `<@${id}> (\`${id}\`)${discordTag ? ` · ${codeText(discordTag, 40)}` : ''}`, inline: true },
          { name: 'Minecraft', value: `\`${codeText(name, 30)}\``, inline: true },
          ...(link?.uuid ? [{ name: 'UUID', value: `\`${link.uuid}\``, inline: false }] : []),
          { name: 'İşlem', value: `\`${requestId}\`${instance ? ` · sunucu \`${codeText(instance, 40)}\`` : ''}`, inline: false },
        ],
      },
    },
    {
      key: `link:${version}:roles`,
      kind: 'role_sync',
      payload: {
        discordId: id, uuid: link?.uuid ?? null, linkId: link?.linkId ?? null, instance,
      },
    },
  ];
}

/** Bağlantı kaldırıldıktan sonra yan işlemler. */
export function linkRemovedEffects({
  link, instance = null, actorId = null, reason = null, requestId, source = 'discord_admin',
}) {
  const id = String(link.discordId);
  const name = link.currentName ?? link.mcName ?? '?';
  const version = link.linkId ?? `legacy:${link.uuid ?? id}:${requestId}`;
  return [
    {
      key: `unlink:${version}:audit`,
      kind: 'audit_case',
      payload: {
        action: 'link_delete', userId: id, modId: actorId, reason,
        detail: link.uuid ? `${name} (${link.uuid})` : name,
      },
    },
    {
      key: `unlink:${version}:log`,
      kind: 'log',
      payload: {
        title: 'Hesap Bağlantısı Kaldırıldı',
        color: 'warn',
        fields: [
          { name: 'Minecraft', value: `\`${codeText(name, 30)}\`${link.uuid ? `\n\`${link.uuid}\`` : ''}`, inline: true },
          { name: 'Discord', value: `<@${id}> (\`${id}\`)`, inline: true },
          { name: 'Yetkili', value: actorId ? `<@${actorId}>` : codeText(source, 30), inline: true },
          ...(reason ? [{ name: 'Sebep', value: codeText(reason, 500), inline: false }] : []),
          { name: 'İşlem', value: `\`${requestId}\`${instance ? ` · sunucu \`${codeText(instance, 40)}\`` : ''}`, inline: false },
        ],
      },
    },
    {
      key: `unlink:${version}:roles`,
      kind: 'role_cleanup',
      payload: {
        discordId: id, uuid: link.uuid ?? null, linkId: link.linkId ?? null, instance,
      },
    },
  ];
}

/**
 * Discord hesabının şu anki bağlantısı (hata fırlatmaz). instance verilmezse
 * bağlı TÜM açık kimlikli instance'lar sorulur; çoklu bağımsız depoda yanlış
 * depodan "bağlı değil" okunmaz. Herhangi bir depo okunamazsa sonuç belirsizdir.
 *
 * @returns {Promise<{ok:true, linked:boolean, link:object|null} | {ok:false, res:object}>}
 */
export async function readDiscordLink(api, discordId, instance = null) {
  let targets = [instance];
  if (!instance) {
    const bridge = api.bridgeStatus?.({ requireSingleInstance: false });
    if (bridge && !bridge.ok) return { ok: false, res: bridge };
    const ids = (bridge?.instanceMeta ?? []).map((m) => m.id).filter((id) => id && !id.startsWith('ip:'));
    if (ids.length > 1) targets = ids;
  }
  let found = null;
  for (const target of targets) {
    const info = await api.linkInfo('discord', discordId, { targetInstance: target });
    if (info.ok) {
      if (info.linked && !found) found = { ...info.link, instance: target };
      continue;
    }
    if (info.errorCode === 'not_found' || info.status === 404) {
      // 1.2.1 plugin: protokol 2 yok, eski durum ucuna düş.
      const legacy = await api.linkStatus(`discord=${encodeURIComponent(discordId)}`, { targetInstance: target });
      if (!legacy.ok) return { ok: false, res: legacy };
      if (legacy.linked && !found) {
        found = {
          discordId,
          uuid: legacy.uuid ?? null,
          mcName: legacy.mc,
          currentName: legacy.mc,
          linkId: legacy.linkId ?? null,
          linkedAt: legacy.linkedAt ?? null,
          instance: target,
        };
      }
      continue;
    }
    return { ok: false, res: info };
  }
  return { ok: true, linked: Boolean(found), link: found };
}

/** readDiscordLink'in yan işlemler için hata fırlatan hâli. */
export async function currentDiscordLink(api, discordId, instance = null) {
  const res = await readDiscordLink(api, discordId, instance);
  if (!res.ok) throw new Error(`bağlantı durumu okunamadı (${res.res?.errorCode ?? 'bilinmiyor'})`);
  return { linked: res.linked, link: res.link };
}

function guildOf(client) {
  const guild = client?.guilds?.cache?.get(config.guildId);
  if (!guild) throw new Error('Discord sunucusu önbellekte değil');
  return guild;
}

export function createDefaultHandlers({ api = mcapi } = {}) {
  return {
    async audit_case(payload) {
      addCase(payload.action, payload.userId, payload.modId, payload.reason, payload.detail);
      return null;
    },
    async log(payload, { client }) {
      const sent = await sendLogStrict(client, {
        title: payload.title,
        color: Colors[payload.color] ?? Colors.info,
        fields: payload.fields ?? [],
      });
      return sent ? null : 'log kanalı ayarlı değil';
    },
    async role_sync(payload, { client }) {
      if (!Object.keys(roleMap()).length) return 'tier rol eşlemesi yok';
      const guild = guildOf(client);
      const current = await currentDiscordLink(api, payload.discordId, payload.instance);
      if (!current.linked || (payload.linkId && current.link?.linkId !== payload.linkId)) {
        return 'bağlantı değişti; eski rol işlemi atlandı';
      }
      let tier = current.link?.tier ?? null;
      if (!tier) {
        const profile = await api.statsPlayer(`discord=${encodeURIComponent(payload.discordId)}`);
        if (!profile.ok) throw new Error(`oyuncu profili okunamadı (${profile.errorCode})`);
        tier = profile.found ? profile.tier : null;
      }
      if (!tier) return 'tier bilgisi yok';
      const res = await syncMemberTierRole(guild, payload.discordId, tier);
      if (!res.ok && res.missingMember) return 'üye sunucuda değil';
      if (!res.ok) throw new Error(res.error);
      return res.changed ? 'tier rolü güncellendi' : 'değişiklik gerekmedi';
    },
    async role_cleanup(payload, { client }) {
      if (!Object.keys(roleMap()).length) return 'tier rol eşlemesi yok';
      const guild = guildOf(client);
      const current = await currentDiscordLink(api, payload.discordId, payload.instance);
      if (current.linked) return 'Discord hesabı yeniden bağlanmış; roller korunuyor';
      const res = await removeTierRoles(guild, payload.discordId);
      if (!res.ok && res.missingMember) return 'üye sunucuda değil';
      if (!res.ok) throw new Error(res.error);
      return res.changed ? 'tier rolleri kaldırıldı' : 'kaldırılacak tier rolü yok';
    },
  };
}

export function createLinkEffects({
  store = linkSideEffects, handlers = createDefaultHandlers(), now = Date.now, logger = console,
} = {}) {
  let running = false;

  async function processDue({ client, limit = 20 } = {}) {
    if (running) return { skipped: true, processed: 0 };
    running = true;
    let processed = 0;
    try {
      for (const row of store.due(now(), limit)) {
        processed += 1;
        try {
          const handler = handlers[row.kind];
          if (!handler) throw new Error(`bilinmeyen yan işlem türü: ${row.kind}`);
          const note = await handler(JSON.parse(row.payload), { client, logger });
          store.markDone(row.id, now(), note ?? null);
        } catch (err) {
          const attempts = row.attempts + 1;
          const message = String(err?.message ?? err).slice(0, 300);
          if (attempts >= MAX_ATTEMPTS) {
            store.markFailed(row.id, attempts, message, now());
            logger.error(`[linkeffects] ${row.kind} ${row.effect_key} ${attempts} denemeden sonra kalıcı başarısız: ${message}`);
          } else {
            store.markRetry(row.id, attempts, message, now() + RETRY_DELAYS_MS[attempts - 1], now());
            logger.warn(`[linkeffects] ${row.kind} ${row.effect_key} başarısız (deneme ${attempts}/${MAX_ATTEMPTS}), yeniden denenecek: ${message}`);
          }
        }
      }
    } finally {
      running = false;
    }
    return { skipped: false, processed };
  }

  /** Yan işlemleri kalıcı kuyruğa yazar ve hemen bir işleme turu dener. */
  async function enqueue(effects, { client } = {}) {
    let added = 0;
    for (const effect of effects) {
      if (store.enqueue({ key: effect.key, kind: effect.kind, payload: effect.payload, at: now() })) added += 1;
    }
    await processDue({ client });
    return added;
  }

  return { enqueue, processDue };
}

export const linkEffects = createLinkEffects();

/** Zamanlayıcı: bekleyen yan işlemleri 20 sn'de bir dener. */
export function startLinkEffects(client, effects = linkEffects) {
  setInterval(() => {
    effects.processDue({ client }).catch((err) => console.error('[linkeffects] işleme turu hatası:', err.message));
  }, TICK_MS).unref();
}

/**
 * Oyun içi /unlink'ten gelen link_removed eventi: yalnız tier rollerini temizle.
 * Gecikmiş/tekrarlanan event, o anda yeniden bağlanmış hesabın rollerini sökemez
 * (role_cleanup çalışmadan önce güncel bağlantıyı okur).
 */
export async function handleLinkRemovedEvent(client, envelope, effects = linkEffects) {
  if (envelope?.type !== 'link_removed' || envelope.test) return;
  const discordId = envelope.data?.discordId;
  if (!discordId || !/^\d{1,20}$/.test(String(discordId))) return;
  await effects.enqueue([{
    key: `event:${envelope.eventId ?? `${discordId}:${envelope.occurredAt ?? Date.now()}`}:roles`,
    kind: 'role_cleanup',
    payload: {
      discordId: String(discordId), uuid: null, linkId: null, instance: null,
    },
  }], { client });
}
