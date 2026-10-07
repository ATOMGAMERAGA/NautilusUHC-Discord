import { randomUUID } from 'node:crypto';
import { Tier, hasTier, tierName } from './permissions.js';
import { mcapi } from './mcapi.js';
import { linkAdminPanels, casesOf } from './db.js';
import {
  baseEmbed, okEmbed, errEmbed, warnEmbed, neutralEmbed, brandFooter, Colors, bridgeErrorEmbed,
} from './embeds.js';
import { clean, codeText, discordTime } from './util.js';
import { linkEffects, linkRemovedEffects } from './linkeffects.js';
import { resetStatsCache } from './statsproxy.js';
import { LINK_PROTOCOL } from './linkrouting.js';

/**
 * HESAP BAĞLANTISI YÖNETİMİ (yetkililer) — discord.js'e bağımlı olmayan servis.
 *
 * Doğru veri kaynağı plugin'in kalıcı deposudur (protokol 2 uçları); bot
 * loglarından aktif bağlantı tahmin edilmez. Yetki hem slash komut girişinde
 * (index.js) hem de burada, her servis çağrısında yeniden denetlenir.
 *
 * Kaldırma iki adımlıdır: çift açıkça gösterilir, onay butonu tek kullanımlıktır
 * (DB'de tutulur, restart'a dayanıklı). Onay anında kayıt yeniden okunur ve
 * plugin'e beklenen link sürümü (expectedLinkId) gönderilir; panel açıldıktan
 * sonra oyuncu unlink/relink yaptıysa eski panel yeni bağlantıyı silemez.
 */

export const EPHEMERAL = 64;
export const VIEW_TIER = Tier.MOD;
export const UNLINK_TIER = Tier.ADMIN;
export const LIST_PAGE_SIZE = 10;
export const HISTORY_PAGE_SIZE = 10;
const PANEL_TTL_MS = 15 * 60_000;
const VIEW_TTL_MS = 15 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const UNCERTAIN = new Set(['bridge_timeout', 'bridge_unreachable', 'store_unavailable', 'internal_error']);

/* ------------------------------------------------------------------ */
/* Girdi                                                                */
/* ------------------------------------------------------------------ */

export function normalizeUuid(raw) {
  const value = String(raw ?? '').trim();
  if (!UUID_RE.test(value)) return null;
  const hex = value.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Komut seçeneklerinden tek ve kesin hedef. Discord ID'si string kalır.
 * @returns {{ok:true, selector:'name'|'discord'|'uuid'|null, value:string|null} | {ok:false, message:string}}
 */
export function parseTarget({
  name = null, discordUserId = null, discordId = null, uuid = null,
} = {}, { required = true } = {}) {
  const given = [
    name ? ['name', String(name).trim()] : null,
    discordUserId ? ['discord', String(discordUserId)] : null,
    discordId ? ['discord', String(discordId).trim()] : null,
    uuid ? ['uuid', String(uuid).trim()] : null,
  ].filter(Boolean);
  if (given.length > 1) {
    return { ok: false, message: 'Yalnız bir hedef seç: `oyuncu`, `kullanıcı`, `discord-id` veya `uuid`.' };
  }
  if (given.length === 0) {
    return required
      ? { ok: false, message: 'Bir hedef seç: `oyuncu`, `kullanıcı`, `discord-id` veya `uuid`.' }
      : { ok: true, selector: null, value: null };
  }
  const [selector, value] = given[0];
  if (selector === 'discord' && !/^\d{1,20}$/.test(value)) {
    return { ok: false, message: 'Discord ID yalnız rakamlardan oluşmalı (en fazla 20 hane).' };
  }
  if (selector === 'uuid') {
    const normalized = normalizeUuid(value);
    if (!normalized) return { ok: false, message: 'Geçerli bir Minecraft UUID gir.' };
    return { ok: true, selector, value: normalized };
  }
  if (selector === 'name' && (!value || value.length > 32 || /\s/.test(value))) {
    return { ok: false, message: 'Minecraft oyuncu adı boşluk içermemeli ve en fazla 32 karakter olmalı.' };
  }
  return { ok: true, selector, value };
}

/** Etkileşimden yetkili bilgisi; kullanıcı adı çözümleyici ayrılmış üyeleri de işler. */
export function actorFromInteraction(interaction) {
  const guild = interaction.guild ?? null;
  return {
    id: interaction.user.id,
    tag: interaction.user.tag,
    member: interaction.member,
    client: interaction.client,
    resolveUser: async (userId) => {
      const user = await interaction.client.users.fetch(userId).catch(() => null);
      if (!user) return null;
      const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
      return { tag: user.tag ?? user.username, inGuild: guild ? Boolean(member) : null };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Görünüm yardımcıları                                                  */
/* ------------------------------------------------------------------ */

function deniedEmbed(minTier) {
  return errEmbed(`Bu işlem **${tierName(minTier)}** ve üzeri yetkililer içindir.`, 'Yetki Gerekli');
}

function notYoursEmbed() {
  return errEmbed('Bu panel başka bir yetkili tarafından açıldı. Komutu kendin çalıştırabilirsin.',
    'Bu Panel Sana Ait Değil');
}

function expiredEmbed() {
  return warnEmbed('Bu panelin süresi doldu ya da bot yeniden başlatıldı; hiçbir işlem yapılmadı.\n'
    + 'Komutu yeniden çalıştır.', 'Panel Süresi Doldu');
}

const payload = (embeds, components = []) => ({ embeds, components });

function button(customId, label, style, disabled = false) {
  return {
    type: 2, custom_id: customId, label, style, disabled,
  };
}

const row = (...buttons) => ({ type: 1, components: buttons });

function displayName(link) {
  return link?.currentName ?? link?.mcName ?? '?';
}

function mcText(link) {
  const current = displayName(link);
  const renamed = link?.mcName && link?.currentName && link.mcName.toLowerCase() !== link.currentName.toLowerCase()
    ? ` (bağlanırken: ${clean(link.mcName, 30)})`
    : '';
  return `**${clean(current, 30)}**${renamed}`;
}

function userText(user) {
  if (!user) return 'kullanıcı bulunamadı';
  const left = user.inGuild === false ? ' · sunucuda değil' : '';
  return `${clean(user.tag, 40)}${left}`;
}

const timeText = (ms) => (Number(ms) > 0 ? discordTime(Number(ms), 'f') : 'bilinmiyor');

export function linkLine(link, user, index = null) {
  const prefix = index === null ? '' : `\`${index}.\` `;
  return `${prefix}${mcText(link)} · \`${link.uuid}\`\n`
    + `↔ <@${link.discordId}> \`${link.discordId}\` · ${userText(user)} · ${timeText(link.linkedAt)}`;
}

const EVENT_LABELS = {
  'link:ok': '🔗 Bağlandı',
  'unlink:ok': '✂️ Kaldırıldı',
  'unlink:not_linked': '↩️ Kaldırma denendi (bağlantı yoktu)',
  'unlink:stale_version': '⚠️ Kaldırma reddedildi (kayıt değişmişti)',
  'unlink:ambiguous': '⚠️ Kaldırma reddedildi (ad belirsiz)',
};

function actorText(event) {
  switch (event.actorType) {
    case 'discord_staff': return event.actorId ? `yetkili <@${event.actorId}>` : 'yetkili';
    case 'minecraft_staff': return `MC yetkilisi ${clean(event.actorName ?? '?', 30)}`;
    case 'console': return 'konsol';
    case 'player_discord': return 'oyuncu (kod ile)';
    case 'bridge_legacy': return 'eski köprü ucu';
    default: return clean(event.actorType ?? 'sistem', 20);
  }
}

export function eventLine(event) {
  const label = EVENT_LABELS[`${event.action}:${event.result}`] ?? `${event.action}/${event.result}`;
  const mc = event.mcName ? clean(event.mcName, 30) : '—';
  const discord = event.discordId ? `<@${event.discordId}> \`${event.discordId}\`` : '—';
  return `${timeText(event.occurredAt)} · **${label}** · ${mc} \`${event.uuid ?? '—'}\` ↔ ${discord}`
    + ` · ${actorText(event)}${event.reason ? ` · sebep: ${clean(event.reason, 80)}` : ''}`;
}

function truncateLines(lines, max = 3900) {
  const out = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 2 > max) {
      out.push('…');
      break;
    }
    out.push(line);
    size += line.length + 2;
  }
  return out.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* Servis                                                               */
/* ------------------------------------------------------------------ */

export function createLinkAdmin({
  api = mcapi,
  panels = linkAdminPanels,
  effects = linkEffects,
  cases = casesOf,
  now = Date.now,
  newId = () => randomUUID().replace(/-/g, '').slice(0, 16),
  newRequestId = () => randomUUID(),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  retryDelayMs = 1500,
  logger = console,
} = {}) {
  const views = new Map();

  function createView(view) {
    for (const [id, existing] of views) {
      if (now() - existing.createdAt > VIEW_TTL_MS) views.delete(id);
    }
    const id = newId();
    views.set(id, { ...view, createdAt: now() });
    return id;
  }

  function getView(id) {
    const view = views.get(id);
    if (!view) return null;
    if (now() - view.createdAt > VIEW_TTL_MS) {
      views.delete(id);
      return null;
    }
    return view;
  }

  function guard(actor, minTier) {
    return hasTier(actor?.member, minTier) ? null : payload([deniedEmbed(minTier)]);
  }

  /** Hedef instance: tek sunucuda otomatik, çoklu sunucuda açık seçim zorunlu. */
  function target(requested, { allowLegacy = false } = {}) {
    const bridge = api.bridgeStatus({ requireSingleInstance: false });
    if (!bridge.ok) return { ok: false, payload: payload([bridgeErrorEmbed(bridge, { context: 'bağlantı yönetimi' })]) };
    if (bridge.transport !== 'reverse') {
      return allowLegacy
        ? { ok: true, instance: null, protocol: 0 }
        : { ok: false, payload: payload([outdatedEmbed()]) };
    }
    const reason = bridge.routing?.reason;
    if (reason === 'concurrent_pollers' || reason === 'duplicate_instance') {
      return {
        ok: false,
        payload: payload([bridgeErrorEmbed({ ok: false, errorCode: 'multiple_plugin_instances' }, { context: 'bağlantı yönetimi' })]),
      };
    }
    const meta = bridge.instanceMeta ?? (bridge.instances ?? []).map((id) => ({ id, linkProtocol: 0 }));
    const ids = meta.map((m) => `\`${codeText(m.id, 40)}\``).join(', ') || '—';
    let chosen;
    if (requested) {
      chosen = meta.find((m) => m.id === requested);
      if (!chosen) {
        return {
          ok: false,
          payload: payload([errEmbed(`\`${codeText(requested, 40)}\` adlı bağlı bir sunucu yok.\nBağlı sunucular: ${ids}`,
            'Sunucu Bulunamadı')]),
        };
      }
    } else if (meta.length === 1) {
      [chosen] = meta;
    } else {
      return {
        ok: false,
        payload: payload([errEmbed('Birden fazla Minecraft sunucusu bağlı; yanlış depoda işlem yapmamak için '
          + `\`sunucu\` seçeneğiyle hedefi seç.\nBağlı sunucular: ${ids}`, 'Sunucu Seçimi Gerekli')]),
      };
    }
    const anonymous = !chosen.id || chosen.id.startsWith('ip:');
    if (anonymous && meta.length > 1) {
      return {
        ok: false,
        payload: payload([bridgeErrorEmbed({ ok: false, errorCode: 'multiple_plugin_instances' }, { context: 'bağlantı yönetimi' })]),
      };
    }
    const protocol = Number(chosen.linkProtocol) || 0;
    if (protocol < LINK_PROTOCOL && !allowLegacy) return { ok: false, payload: payload([outdatedEmbed()]) };
    return {
      ok: true, instance: anonymous ? null : chosen.id, protocol, multi: meta.length > 1,
    };
  }

  function outdatedEmbed() {
    return errEmbed('Hedef Minecraft sunucusundaki NautilusUHC sürümü hesap bağlantısı yönetimini desteklemiyor.\n'
      + 'Bu özellik ters köprü ve plugin **1.2.2** gerektirir.', 'Plugin Güncel Değil');
  }

  function fromInstance(res, instance) {
    if (!instance) return true;
    if (res.claimedBy && res.claimedBy !== instance) return false;
    return res.instance === undefined || res.instance === instance;
  }

  function mismatchPayload(context) {
    logger.error(`[linkadmin] ${context}: yanıt hedeflenen instance'tan gelmedi; sonuç kullanılmadı`);
    return payload([errEmbed('Minecraft sunucusundan gelen yanıt hedeflenen sunucuyla eşleşmedi; işlem sonucu '
      + 'güvenilir değil. Bir yöneticiye bildir.', 'Yanıt Tutarsız')]);
  }

  function errorPayload(res, context) {
    if (res.errorCode === 'store_unavailable') {
      return payload([errEmbed('Minecraft sunucusu bağlantı kayıtlarına şu anda erişemiyor; hiçbir değişiklik '
        + 'yapılmadı. Birkaç dakika sonra tekrar dene.', 'Bağlantı Deposuna Ulaşılamadı')]);
    }
    return payload([bridgeErrorEmbed(res, { context })]);
  }

  function ambiguousPayload(value, candidates = []) {
    const lines = candidates.slice(0, 10).map((c) => {
      const names = (c.knownNames ?? []).map((n) => clean(n, 30)).join(', ') || '—';
      const state = c.linked && c.link ? `bağlı: <@${c.link.discordId}> \`${c.link.discordId}\`` : 'bağlantısız';
      return `\`${c.uuid}\` · ${names} · ${state}`;
    });
    return payload([warnEmbed(`\`${codeText(value, 32)}\` adı birden fazla Minecraft hesabıyla eşleşiyor; yanlış `
      + 'kaydı seçmemek için hiçbir işlem yapılmadı.\nUUID ya da Discord ID ile tekrar dene:\n\n'
      + lines.join('\n'), 'Oyuncu Adı Belirsiz')]);
  }

  function ambiguousDiscordPayload(value, links) {
    return payload([warnEmbed(`<@${value}> hesabına iki Minecraft hesabı bağlı. Kaldırılacak hesabın UUID'siyle tekrar dene:\n\n`
      + links.map((link) => `${mcText(link)} · \`${link.uuid}\``).join('\n'), 'Minecraft Hesabını Seç')]);
  }

  function notLinkedPayload(selector, value, info) {
    let text;
    if (selector === 'discord') text = `<@${value}> (\`${value}\`) şu anda hiçbir Minecraft hesabına bağlı değil.`;
    else if (selector === 'uuid') text = `\`${value}\` UUID'li hesap şu anda bağlı değil.`;
    else if (info?.resolved === false) text = `\`${codeText(value, 32)}\` adıyla kayıtlı bir oyuncu bulunamadı.`;
    else text = `\`${codeText(value, 32)}\` oyuncusunun şu anda aktif bir Discord bağlantısı yok.`;
    return payload([neutralEmbed(`${text}\nDeğişiklik yapılmadı.`, 'Aktif Bağlantı Yok')]);
  }

  /* ---------------- Liste ---------------- */

  async function listPayload({ actor, page = 1, instance: requested = null }) {
    const denied = guard(actor, VIEW_TIER);
    if (denied) return denied;
    const t = target(requested);
    if (!t.ok) return t.payload;
    return renderList(actor, t, Math.max(0, (Math.max(1, Number(page) || 1) - 1) * LIST_PAGE_SIZE));
  }

  async function renderList(actor, t, requestedOffset) {
    let offset = requestedOffset;
    let res = await api.linkList({ offset, limit: LIST_PAGE_SIZE }, { targetInstance: t.instance });
    if (!res.ok) return errorPayload(res, 'bağlantı listesi');
    if (!fromInstance(res, t.instance)) return mismatchPayload('linkler');
    const total = Number(res.total) || 0;
    if (total > 0 && offset >= total) {
      offset = Math.floor((total - 1) / LIST_PAGE_SIZE) * LIST_PAGE_SIZE;
      res = await api.linkList({ offset, limit: LIST_PAGE_SIZE }, { targetInstance: t.instance });
      if (!res.ok) return errorPayload(res, 'bağlantı listesi');
      if (!fromInstance(res, t.instance)) return mismatchPayload('linkler');
    }
    const rows = Array.isArray(res.links) ? res.links : [];
    const users = await Promise.all(rows.map((r) => actor.resolveUser?.(r.discordId) ?? null));
    const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
    const page = Math.floor(offset / LIST_PAGE_SIZE) + 1;
    const embed = baseEmbed(Colors.info)
      .setTitle('🔗 Aktif Hesap Bağlantıları')
      .setDescription(rows.length
        ? truncateLines(rows.map((r, i) => linkLine(r, users[i], offset + i + 1)))
        : 'Aktif hesap bağlantısı yok.')
      .addFields(
        { name: 'Toplam aktif bağlantı', value: String(total), inline: true },
        { name: 'Sıralama', value: 'En son eşleşen önce', inline: true },
        ...(t.instance ? [{ name: 'Sunucu', value: `\`${codeText(t.instance, 40)}\``, inline: true }] : []),
      )
      .setFooter(brandFooter(`Sayfa ${page}/${pages}`, 'Yalnız yetkililer görür'));
    const viewId = createView({ kind: 'list', ownerId: actor.id, instance: t.instance });
    return payload([embed], [row(
      button(`linkadm:nav:${viewId}:p${Math.max(0, offset - LIST_PAGE_SIZE)}`, '◀ Önceki', 2, offset === 0),
      button(`linkadm:nav:${viewId}:n${offset + LIST_PAGE_SIZE}`, 'Sonraki ▶', 2, offset + LIST_PAGE_SIZE >= total),
      button(`linkadm:nav:${viewId}:r${offset}`, '🔄 Yenile', 2),
    )]);
  }

  /* ---------------- Bilgi ---------------- */

  async function infoPayload({
    actor, selector, value, instance: requested = null,
  }) {
    const denied = guard(actor, VIEW_TIER);
    if (denied) return denied;
    const t = target(requested);
    if (!t.ok) return t.payload;
    const res = await api.linkInfo(selector, value, { targetInstance: t.instance });
    if (!res.ok) {
      if (res.errorCode === 'ambiguous_name') return ambiguousPayload(value, res.candidates);
      return errorPayload(res, 'bağlantı bilgisi');
    }
    if (!fromInstance(res, t.instance)) return mismatchPayload('linkbilgi');
    return renderInfo(actor, t.instance, res, { selector, value });
  }

  function linkFields(link, user, instance) {
    return [
      { name: 'Durum', value: '🟢 Aktif bağlantı', inline: true },
      { name: 'Bağlandığı zaman', value: timeText(link.linkedAt), inline: true },
      ...(instance ? [{ name: 'Sunucu', value: `\`${codeText(instance, 40)}\``, inline: true }] : []),
      { name: 'Minecraft', value: `${mcText(link)}\n\`${link.uuid}\``, inline: false },
      { name: 'Discord', value: `<@${link.discordId}> \`${link.discordId}\`\n${userText(user)}`, inline: false },
      { name: 'Bağlantı sürümü', value: `\`${codeText(link.linkId ?? '—', 64)}\``, inline: false },
    ];
  }

  function removeButtonFor(actor, instance, link, reason = null) {
    if (!hasTier(actor.member, UNLINK_TIER) || !link?.linkId) return [];
    const panelId = newId();
    panels.create({
      id: panelId,
      ownerId: actor.id,
      instanceId: instance,
      uuid: link.uuid,
      discordId: link.discordId,
      linkId: link.linkId,
      mcName: displayName(link),
      reason,
      at: now(),
      ttlMs: PANEL_TTL_MS,
    });
    return [row(button(`linkadm:ask:${panelId}`, 'Bağlantıyı kaldır', 4))];
  }

  async function renderInfo(actor, instance, res, { selector, value }) {
    if (selector === 'discord' && Array.isArray(res.links) && res.links.length > 1) {
      const rendered = await Promise.all(res.links.map((link) => renderInfo(actor, instance,
        { ...res, link, links: [link] }, { selector: 'uuid', value: link.uuid })));
      return payload(rendered.flatMap((result) => result.embeds), rendered.flatMap((result) => result.components));
    }
    const link = res.linked ? res.link : null;
    const discordId = link?.discordId ?? (selector === 'discord' ? value : null);
    const user = discordId ? await actor.resolveUser?.(discordId) : null;
    const embed = baseEmbed(link ? Colors.brand : Colors.neutral)
      .setTitle(link ? '🔗 Hesap Bağlantısı' : '⚫ Aktif Bağlantı Yok');
    if (link) {
      embed.addFields(...linkFields(link, user, instance));
    } else {
      embed.setDescription(notLinkedPayload(selector, value, res).embeds[0].data.description);
      if (res.uuid) embed.addFields({ name: 'Minecraft UUID', value: `\`${res.uuid}\``, inline: false });
      if (discordId) embed.addFields({ name: 'Discord', value: `<@${discordId}> \`${discordId}\`\n${userText(user)}`, inline: false });
    }
    const events = Array.isArray(res.recentEvents) ? res.recentEvents : [];
    embed.addFields({
      name: 'Son işlemler (geçmiş — aktif durumu göstermez)',
      value: events.length
        ? truncateLines(events.slice(0, 5).map(eventLine), 1000)
        : 'Kayıt yok. Geçmiş plugin 1.2.2 kurulumundan itibaren tutulur; öncesi için olay uydurulmaz.',
      inline: false,
    });
    if (discordId) {
      const evidence = cases(discordId, 25)
        .filter((c) => c.action === 'link_create' || c.action === 'link_delete')
        .slice(0, 3)
        .map((c) => `#${c.id} ${c.action === 'link_create' ? 'bağlama' : 'silme'} · ${timeText(c.created_at)}`
          + `${c.detail ? ` · ${clean(c.detail, 60)}` : ''}`);
      if (evidence.length) {
        embed.addFields({ name: 'Bot audit kayıtları (kanıt)', value: evidence.join('\n'), inline: false });
      }
    }
    embed.setFooter(brandFooter('Yalnız yetkililer görür'));
    return payload([embed], link ? removeButtonFor(actor, instance, link) : []);
  }

  /* ---------------- Geçmiş ---------------- */

  async function historyPayload({
    actor, selector = null, value = null, beforeId = null, instance: requested = null,
  }) {
    const denied = guard(actor, VIEW_TIER);
    if (denied) return denied;
    const t = target(requested);
    if (!t.ok) return t.payload;
    let uuid = null;
    let discordId = null;
    let current = null;
    if (selector) {
      const info = await api.linkInfo(selector, value, { targetInstance: t.instance });
      if (!info.ok) {
        if (info.errorCode === 'ambiguous_name') return ambiguousPayload(value, info.candidates);
        return errorPayload(info, 'bağlantı geçmişi');
      }
      if (!fromInstance(info, t.instance)) return mismatchPayload('linkgecmisi');
      current = info;
      uuid = info.link?.uuid ?? info.uuid ?? null;
      discordId = info.link?.discordId ?? (selector === 'discord' ? value : null);
      if (!uuid && !discordId) return notLinkedPayload(selector, value, info);
    }
    return renderHistory(actor, t.instance, {
      uuid, discordId, current, beforeId, filtered: Boolean(selector),
    });
  }

  async function renderHistory(actor, instance, {
    uuid, discordId, current, beforeId, filtered,
  }) {
    const res = await api.linkHistory({
      uuid, discordId, limit: HISTORY_PAGE_SIZE, beforeId,
    }, { targetInstance: instance });
    if (!res.ok) return errorPayload(res, 'bağlantı geçmişi');
    if (!fromInstance(res, instance)) return mismatchPayload('linkgecmisi');
    const events = Array.isArray(res.events) ? res.events : [];
    const embed = baseEmbed(Colors.info).setTitle('📜 Bağlantı Geçmişi');
    if (filtered) {
      const state = current?.linked && current.link
        ? `🟢 Aktif: ${mcText(current.link)} \`${current.link.uuid}\` ↔ <@${current.link.discordId}> \`${current.link.discordId}\``
        : '⚫ Şu anda aktif bağlantı yok';
      embed.addFields({ name: 'Şu anki durum', value: state, inline: false });
    }
    embed.addFields({
      name: filtered ? 'Geçmiş olaylar (bu hesaplara dokunan)' : 'Geçmiş olaylar (tüm hesaplar)',
      value: events.length
        ? truncateLines(events.map(eventLine), 1020)
        : 'Kayıtlı işlem yok. Geçmiş plugin 1.2.2 kurulumundan itibaren tutulur; öncesi için olay uydurulmaz.',
      inline: false,
    });
    if (instance) embed.addFields({ name: 'Sunucu', value: `\`${codeText(instance, 40)}\``, inline: true });
    embed.setFooter(brandFooter('Geçmiş olaylar aktif durumu göstermez', 'Yalnız yetkililer görür'));
    const viewId = createView({
      kind: 'history', ownerId: actor.id, instance, uuid, discordId, filtered,
    });
    return payload([embed], [row(
      button(`linkadm:nav:${viewId}:f0`, '⏮ En yeni', 2, beforeId === null),
      button(`linkadm:nav:${viewId}:b${res.nextBeforeId ?? 0}`, 'Daha eski ▶', 2, !res.nextBeforeId),
    )]);
  }

  /* ---------------- Gezinme ---------------- */

  async function navigate({ actor, view, arg }) {
    const denied = guard(actor, VIEW_TIER);
    if (denied) return denied;
    const kind = String(arg ?? '').charAt(0);
    const number = Math.max(0, Number.parseInt(String(arg ?? '').slice(1), 10) || 0);
    if (view.kind === 'list') {
      return renderList(actor, { instance: view.instance }, number);
    }
    let current = null;
    if (view.filtered) {
      const info = view.uuid
        ? await api.linkInfo('uuid', view.uuid, { targetInstance: view.instance })
        : await api.linkInfo('discord', view.discordId, { targetInstance: view.instance });
      if (info.ok && fromInstance(info, view.instance)) current = info;
    }
    return renderHistory(actor, view.instance, {
      uuid: view.uuid,
      discordId: view.discordId,
      current,
      beforeId: kind === 'b' && number > 0 ? number : null,
      filtered: view.filtered,
    });
  }

  /* ---------------- Kaldırma ---------------- */

  function confirmationPayload(panelId, link, user, reason, instance) {
    const embed = warnEmbed('Aşağıdaki Minecraft–Discord bağlantısı **iki taraftan** kaldırılacak.\n'
      + 'Minecraft/Discord hesapları, istatistikler, cezalar ve maç geçmişi silinmez.', '⚠️ Bağlantı Kaldırılsın mı?')
      .addFields(
        { name: 'Minecraft', value: `${mcText(link)}\n\`${link.uuid}\``, inline: true },
        { name: 'Discord', value: `<@${link.discordId}> \`${link.discordId}\`\n${userText(user)}`, inline: true },
        { name: 'Bağlandığı zaman', value: timeText(link.linkedAt), inline: false },
        { name: 'Sebep', value: reason ? clean(reason, 500) : '—', inline: false },
        ...(instance ? [{ name: 'Sunucu', value: `\`${codeText(instance, 40)}\``, inline: true }] : []),
      )
      .setFooter(brandFooter('Onay 15 dakika geçerli', 'kayıt değişirse işlem yapılmaz'));
    return payload([embed], [row(
      button(`linkadm:ok:${panelId}`, 'Onayla ve kaldır', 4),
      button(`linkadm:why:${panelId}`, 'Sebep ekleyerek onayla', 2),
      button(`linkadm:no:${panelId}`, 'Vazgeç', 2),
    )]);
  }

  async function changedPayload(actor, instance, current) {
    if (!current) {
      return payload([neutralEmbed('Panel açıldıktan sonra bu bağlantı kaldırılmış; eski panelle işlem yapılmadı.\n'
        + 'Oyuncu şu anda bağlantısız.', 'Kayıt Değişti')]);
    }
    const user = await actor.resolveUser?.(current.discordId);
    const embed = warnEmbed('Panel açıldıktan sonra bu oyuncunun bağlantısı değişti; eski panelle **hiçbir işlem '
      + 'yapılmadı**. Güncel kayıt aşağıda.', 'Kayıt Değişti')
      .addFields(...linkFields(current, user, instance));
    return payload([embed], removeButtonFor(actor, instance, current));
  }

  /** Buton/modal öncesi senkron kapı: panel var mı, sahibi mi, yetkili mi, süresi/kullanımı. */
  function panelGate(actor, panelId) {
    const panel = panels.get(panelId);
    if (!panel || now() > panel.expires_at) return { ok: false, embeds: [expiredEmbed()] };
    if (panel.owner_id !== actor.id) return { ok: false, embeds: [notYoursEmbed()] };
    if (!hasTier(actor.member, UNLINK_TIER)) return { ok: false, embeds: [deniedEmbed(UNLINK_TIER)] };
    if (panel.used_at) {
      return {
        ok: false,
        embeds: [warnEmbed('Bu onay zaten kullanıldı; aynı panelle ikinci işlem yapılamaz.\n'
          + 'Güncel durum için `/linkbilgi` kullan.', 'Panel Kullanıldı')],
      };
    }
    return { ok: true, panel };
  }

  async function prepareUnlink({
    actor, selector, value, reason = null, instance: requested = null,
  }) {
    const denied = guard(actor, UNLINK_TIER);
    if (denied) return denied;
    const t = target(requested);
    if (!t.ok) return t.payload;
    const info = await api.linkInfo(selector, value, { targetInstance: t.instance });
    if (!info.ok) {
      if (info.errorCode === 'ambiguous_name') return ambiguousPayload(value, info.candidates);
      return errorPayload(info, 'bağlantı bilgisi');
    }
    if (!fromInstance(info, t.instance)) return mismatchPayload('unlink');
    if (selector === 'discord' && info.links?.length > 1) return ambiguousDiscordPayload(value, info.links);
    if (!info.linked || !info.link) return notLinkedPayload(selector, value, info);
    const panelId = newId();
    panels.create({
      id: panelId,
      ownerId: actor.id,
      instanceId: t.instance,
      uuid: info.link.uuid,
      discordId: info.link.discordId,
      linkId: info.link.linkId,
      mcName: displayName(info.link),
      reason: reason ? String(reason).slice(0, 500) : null,
      at: now(),
      ttlMs: PANEL_TTL_MS,
    });
    const user = await actor.resolveUser?.(info.link.discordId);
    return confirmationPayload(panelId, info.link, user, reason, t.instance);
  }

  async function currentFor(panel) {
    const info = await api.linkInfo('uuid', panel.uuid, { targetInstance: panel.instance_id });
    if (!info.ok) return { error: errorPayload(info, 'bağlantı durumu') };
    if (!fromInstance(info, panel.instance_id)) return { error: mismatchPayload('unlink onayı') };
    return { info };
  }

  async function askUnlink({ actor, panelId }) {
    const gate = panelGate(actor, panelId);
    if (!gate.ok) return payload(gate.embeds);
    const { panel } = gate;
    const { info, error } = await currentFor(panel);
    if (error) return error;
    if (!info.linked || info.link.linkId !== panel.link_id || info.link.discordId !== panel.discord_id) {
      panels.markUsed(panelId, now());
      return changedPayload(actor, panel.instance_id, info.linked ? info.link : null);
    }
    const user = await actor.resolveUser?.(info.link.discordId);
    return confirmationPayload(panelId, info.link, user, panel.reason, panel.instance_id);
  }

  async function reconcileUnlink(requestId, instance) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(retryDelayMs);
      const op = await api.linkOperation(requestId, { targetInstance: instance });
      if (!op.ok || !fromInstance(op, instance) || !op.found) continue;
      if (op.result === 'removed') return { ok: true, result: 'removed', link: op.link, instance };
      if (op.result === 'not_linked') return { ok: true, result: 'not_linked', instance };
      return { ok: false, errorCode: op.result, status: 409, instance };
    }
    return null;
  }

  async function finishRemoval({
    actor, instance, link, reason, requestId, expected,
  }) {
    if (!link || (expected && (link.uuid !== expected.uuid || link.discordId !== expected.discordId))) {
      logger.error(`[linkadmin] rid=${requestId} kaldırma yanıtı beklenen kayıtla eşleşmedi`);
      return payload([errEmbed('Kaldırma yanıtı beklenen bağlantıyla eşleşmedi. `/linkbilgi` ile güncel durumu '
        + 'doğrula ve bir yöneticiye bildir.', 'Yanıt Tutarsız')]);
    }
    try {
      resetStatsCache();
    } catch { /* önbellek temizliği sonucu etkilemez */ }
    try {
      await effects.enqueue(linkRemovedEffects({
        link, instance, actorId: actor.id, reason, requestId,
      }), { client: actor.client });
    } catch (err) {
      logger.error(`[linkadmin] rid=${requestId} bağlantı kaldırıldı fakat yan işlemler kuyruğa yazılamadı: ${err.message}`);
    }
    const embed = okEmbed(`Kaldırılan bağlantı: ${mcText(link)} (\`${link.uuid}\`) ↔ <@${link.discordId}> `
      + `(\`${link.discordId}\`).\nOyuncu yeniden bağlanmak için oyunda \`/link\` yazıp yeni kod almalı.`,
    '✂️ Bağlantı Kaldırıldı');
    if (reason) embed.addFields({ name: 'Sebep', value: clean(reason, 500), inline: false });
    embed.addFields({ name: 'İşlem', value: `\`${requestId}\``, inline: false });
    return payload([embed]);
  }

  async function confirmUnlink({ actor, panelId, reason = null }) {
    const gate = panelGate(actor, panelId);
    if (!gate.ok) return payload(gate.embeds);
    const { panel } = gate;
    // Yetki ve kaydın aynı sürümde olduğu onay anında yeniden doğrulanır.
    const { info, error } = await currentFor(panel);
    if (error) return error;
    if (!info.linked) {
      panels.markUsed(panelId, now());
      return payload([neutralEmbed(`\`${codeText(panel.mc_name ?? '?', 30)}\` (\`${panel.uuid}\`) şu anda zaten `
        + 'bağlantısız; değişiklik yapılmadı.', 'Bağlantı Zaten Yok')]);
    }
    if (info.link.linkId !== panel.link_id || info.link.discordId !== panel.discord_id) {
      panels.markUsed(panelId, now());
      return changedPayload(actor, panel.instance_id, info.link);
    }
    if (!panels.markUsed(panelId, now())) {
      return payload([warnEmbed('Bu onay zaten kullanıldı; ikinci işlem yapılmadı.', 'Panel Kullanıldı')]);
    }
    const finalReason = reason ?? panel.reason ?? null;
    const requestId = newRequestId();
    let res = await api.linkUnlinkV2({
      selector: 'uuid',
      value: panel.uuid,
      expectedLinkId: panel.link_id,
      reason: finalReason,
      actor: { type: 'discord_staff', id: actor.id, name: actor.tag },
      requestId,
    }, { targetInstance: panel.instance_id });
    if (!res.ok && (UNCERTAIN.has(res.errorCode) || Number(res.status) >= 500)) {
      const settled = await reconcileUnlink(requestId, panel.instance_id);
      if (settled) res = settled;
      else {
        return payload([warnEmbed('Kaldırma isteği Minecraft sunucusuna gönderildi ancak sonucu doğrulanamadı.\n'
          + `\`/linkbilgi uuid:${panel.uuid}\` ile güncel durumu kontrol et. İşlem: \`${requestId}\``,
        'Sonuç Doğrulanamadı')]);
      }
    }
    if (!res.ok || !fromInstance(res, panel.instance_id)) {
      if (res.errorCode === 'stale_version') return changedPayload(actor, panel.instance_id, res.current ?? null);
      if (res.ok) return mismatchPayload('unlink onayı');
      return errorPayload(res, 'bağlantı kaldırma');
    }
    if (res.result === 'not_linked') {
      return payload([neutralEmbed('Bağlantı zaten kaldırılmış; değişiklik yapılmadı.', 'Bağlantı Zaten Yok')]);
    }
    return finishRemoval({
      actor,
      instance: panel.instance_id,
      link: res.link,
      reason: finalReason,
      requestId,
      expected: { uuid: panel.uuid, discordId: panel.discord_id },
    });
  }

  function cancelPanel(panelId) {
    panels.markUsed(panelId, now());
  }

  /** /kayıtsil (geriye uyumlu): onaysız, kesin hedefle kaldırma. */
  async function quickUnlink({
    actor, selector, value, reason = null, instance: requested = null,
  }) {
    const denied = guard(actor, UNLINK_TIER);
    if (denied) return denied;
    const t = target(requested, { allowLegacy: true });
    if (!t.ok) return t.payload;
    const requestId = newRequestId();
    if (t.protocol >= LINK_PROTOCOL) {
      let res = await api.linkUnlinkV2({
        selector, value, reason, actor: { type: 'discord_staff', id: actor.id, name: actor.tag }, requestId,
      }, { targetInstance: t.instance });
      if (!res.ok && (UNCERTAIN.has(res.errorCode) || Number(res.status) >= 500)) {
        res = (await reconcileUnlink(requestId, t.instance)) ?? res;
      }
      if (!res.ok) {
        if (res.errorCode === 'ambiguous_name') return ambiguousPayload(value, res.candidates);
        return errorPayload(res, 'bağlantı silme');
      }
      if (!fromInstance(res, t.instance)) return mismatchPayload('kayıtsil');
      if (res.result !== 'removed') return notLinkedPayload(selector, value, res);
      return finishRemoval({
        actor, instance: t.instance, link: res.link, reason, requestId,
      });
    }
    // 1.2.1 plugin: eski uç; isim belirsizliği plugin 1.2.2'de 409 olarak gelir.
    const res = await api.linkDelete(selector === 'discord' ? 'dc' : 'mc', value);
    if (!res.ok) {
      if (res.status === 409) return ambiguousPayload(value, res.candidates);
      return errorPayload(res, 'bağlantı silme');
    }
    if (!res.removed) return notLinkedPayload(selector, value, null);
    return finishRemoval({
      actor,
      instance: t.instance,
      link: {
        uuid: res.uuid ?? null, discordId: res.discordId, currentName: res.mc, mcName: res.mc, linkId: null,
      },
      reason,
      requestId,
    });
  }

  return {
    listPayload,
    infoPayload,
    historyPayload,
    prepareUnlink,
    askUnlink,
    confirmUnlink,
    quickUnlink,
    cancelPanel,
    panelGate,
    navigate,
    view: getView,
    target,
  };
}

/** Birden fazla sunucu için `sunucu` seçeneği otomatik tamamlama değerleri. */
export function instanceChoices(api = mcapi) {
  const bridge = api.bridgeStatus({ requireSingleInstance: false });
  const meta = bridge.ok ? (bridge.instanceMeta ?? []) : [];
  return meta
    .filter((m) => m.id && !m.id.startsWith('ip:'))
    .map((m) => ({
      name: `${m.id} (${m.linkProtocol >= LINK_PROTOCOL ? `protokol ${m.linkProtocol}` : 'eski plugin'})`.slice(0, 100),
      value: m.id.slice(0, 100),
    }));
}

/** Sebep modalı (Discord API JSON'u). */
export function reasonModal(panelId) {
  return {
    custom_id: `linkadm:reason:${panelId}`,
    title: 'Bağlantıyı Kaldır',
    components: [{
      type: 1,
      components: [{
        type: 4, custom_id: 'reason', label: 'Sebep (denetim geçmişine yazılır)', style: 2, required: false, max_length: 500,
      }],
    }],
  };
}

/** Buton ve modal işleyicisi: sahip + yetki kontrolü değişiklikten ÖNCE yapılır. */
export function createLinkAdminComponents(service) {
  return {
    linkadm: async (interaction) => {
      const [, action, id, arg] = interaction.customId.split(':');
      const actor = actorFromInteraction(interaction);

      if (action === 'nav') {
        const view = service.view(id);
        if (!view) return interaction.reply({ embeds: [expiredEmbed()], flags: EPHEMERAL });
        if (view.ownerId !== actor.id) return interaction.reply({ embeds: [notYoursEmbed()], flags: EPHEMERAL });
        if (!hasTier(actor.member, VIEW_TIER)) {
          return interaction.reply({ embeds: [deniedEmbed(VIEW_TIER)], flags: EPHEMERAL });
        }
        await interaction.deferUpdate();
        return interaction.editReply(await service.navigate({ actor, view, arg }));
      }

      if (['ask', 'ok', 'why', 'no', 'reason'].includes(action)) {
        const gate = service.panelGate(actor, id);
        if (!gate.ok) return interaction.reply({ embeds: gate.embeds, flags: EPHEMERAL });
        if (action === 'why') return interaction.showModal(reasonModal(id));
        if (action === 'no') {
          service.cancelPanel(id);
          return interaction.update({
            embeds: [neutralEmbed('İşlem iptal edildi; hiçbir bağlantı değişmedi.', 'Vazgeçildi')],
            components: [],
          });
        }
        await interaction.deferUpdate();
        if (action === 'ask') return interaction.editReply(await service.askUnlink({ actor, panelId: id }));
        const reason = action === 'reason'
          ? (interaction.fields.getTextInputValue('reason') ?? '').trim() || null
          : null;
        return interaction.editReply(await service.confirmUnlink({ actor, panelId: id, reason }));
      }
      return interaction.reply({ embeds: [expiredEmbed()], flags: EPHEMERAL });
    },
  };
}

export const linkAdmin = createLinkAdmin();
export const linkAdminComponents = createLinkAdminComponents(linkAdmin);
