import { AuditLogEvent, Events } from 'discord.js';
import { config } from '../config.js';
import { Tier, tierOf } from '../permissions.js';
import { getSetting, addGuardHit } from '../db.js';
import { sendLog } from '../modlog.js';
import { Colors } from '../embeds.js';

/**
 * Patlama koruması (anti-nuke). Watches destructive actions through the audit
 * log; when one user exceeds a threshold inside the time window, every role is
 * stripped from them and the incident is logged. Kurucu and the bot itself are
 * exempt. Bots added by non-Kurucu members are kicked immediately.
 */

const WINDOW_MS = 20_000;

const LIMITS = {
  channelDelete: { max: 3, label: 'kanal silme' },
  roleDelete: { max: 3, label: 'rol silme' },
  ban: { max: 4, label: 'toplu ban' },
  kick: { max: 4, label: 'toplu kick' },
  webhookCreate: { max: 3, label: 'webhook oluşturma' },
  channelCreate: { max: 6, label: 'toplu kanal oluşturma' },
  roleCreate: { max: 6, label: 'toplu rol oluşturma' },
};

/** userId -> kind -> timestamps */
const hits = new Map();

function enabled() {
  return getSetting('guard_enabled', '1') === '1';
}

function record(userId, kind) {
  let byKind = hits.get(userId);
  if (!byKind) hits.set(userId, (byKind = new Map()));
  const now = Date.now();
  const list = (byKind.get(kind) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  byKind.set(kind, list);
  return list.length;
}

/** Pulls the executor of the newest matching audit-log entry (max ~5s old). */
async function executorOf(guild, type, targetId = null) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    const entry = logs.entries.find((e) =>
      Date.now() - e.createdTimestamp < 5000 && (!targetId || e.targetId === targetId));
    return entry?.executor ?? null;
  } catch {
    return null;
  }
}

async function punish(guild, client, user, kind, count) {
  const label = LIMITS[kind]?.label ?? kind;
  addGuardHit(user.id, kind, `${count} işlem / ${WINDOW_MS / 1000}sn`);

  const member = await guild.members.fetch(user.id).catch(() => null);
  let action = 'Otomatik müdahale yapılamadı (üye bulunamadı veya yetki yetersiz)';
  if (member && member.manageable) {
    try {
      await member.roles.set([], `Patlama koruması: ${label} (${count} işlem)`);
      action = 'Tüm rolleri alındı';
    } catch (err) {
      console.error('[guard] roller alınamadı:', err.message);
      action = 'Roller alınamadı — botun rol sıralamasını kontrol edin';
    }
  }

  // Bu gerçekten insan müdahalesi gerektiren tek olay: Kurucu rolü bilinçli
  // olarak etiketlenir (mesaj içeriğinde, allowedMentions ile sınırlandırılmış).
  await sendLog(client, {
    title: 'Patlama Koruması Tetiklendi',
    color: Colors.danger,
    content: config.roles.kurucu ? `<@&${config.roles.kurucu}>` : undefined,
    pingRoles: config.roles.kurucu ? [config.roles.kurucu] : [],
    description: 'Kısa sürede çok sayıda yıkıcı işlem algılandı ve fail durduruldu.',
    fields: [
      { name: 'Kullanıcı', value: `${user} (\`${user.id}\`)`, inline: true },
      { name: 'Eylem', value: `${label} — ${WINDOW_MS / 1000} sn içinde ${count} işlem`, inline: true },
      { name: 'Müdahale', value: action, inline: false },
    ],
  });
}

async function handle(client, guild, kind, { auditType, targetId = null } = {}) {
  if (!enabled() || !guild || guild.id !== config.guildId) return;
  const user = await executorOf(guild, auditType, targetId);
  if (!user || user.id === client.user.id) return;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (member && tierOf(member) >= Tier.KURUCU) return; // Kurucu exempt

  const count = record(user.id, kind);
  const limit = LIMITS[kind];
  if (limit && count >= limit.max) {
    hits.get(user.id)?.delete(kind); // avoid double-punishing the same burst
    await punish(guild, client, user, kind, count);
  }
}

export function registerGuard(client) {
  client.on(Events.ChannelDelete, (channel) =>
    handle(client, channel.guild, 'channelDelete', { auditType: AuditLogEvent.ChannelDelete, targetId: channel.id }));

  client.on(Events.ChannelCreate, (channel) =>
    handle(client, channel.guild, 'channelCreate', { auditType: AuditLogEvent.ChannelCreate, targetId: channel.id }));

  client.on(Events.GuildRoleDelete, (role) =>
    handle(client, role.guild, 'roleDelete', { auditType: AuditLogEvent.RoleDelete, targetId: role.id }));

  client.on(Events.GuildRoleCreate, (role) =>
    handle(client, role.guild, 'roleCreate', { auditType: AuditLogEvent.RoleCreate, targetId: role.id }));

  client.on(Events.GuildBanAdd, (ban) =>
    handle(client, ban.guild, 'ban', { auditType: AuditLogEvent.MemberBanAdd, targetId: ban.user.id }));

  client.on(Events.WebhooksUpdate, (channel) =>
    handle(client, channel.guild, 'webhookCreate', { auditType: AuditLogEvent.WebhookCreate }));

  client.on(Events.GuildMemberRemove, async (member) => {
    // Distinguish kicks from voluntary leaves via the audit log.
    if (!enabled() || member.guild.id !== config.guildId) return;
    const user = await executorOf(member.guild, AuditLogEvent.MemberKick, member.id);
    if (user) await handle(client, member.guild, 'kick', { auditType: AuditLogEvent.MemberKick, targetId: member.id });
  });

  // Bot eklenmesi: Kurucu dışında biri bot eklerse bot anında atılır.
  client.on(Events.GuildMemberAdd, async (member) => {
    if (!enabled() || !member.user.bot || member.guild.id !== config.guildId) return;
    if (member.id === client.user.id) return;
    const adder = await executorOf(member.guild, AuditLogEvent.BotAdd, member.id);
    const adderMember = adder ? await member.guild.members.fetch(adder.id).catch(() => null) : null;
    if (adderMember && tierOf(adderMember) >= Tier.KURUCU) return;
    addGuardHit(adder?.id ?? 'unknown', 'botAdd', member.id);
    await member.kick('Patlama koruması: izinsiz bot ekleme').catch(() => null);
    await sendLog(client, {
      title: 'İzinsiz Bot Eklendi',
      color: Colors.danger,
      description: 'Kurucu dışında biri sunucuya bot ekledi; bot anında çıkarıldı.',
      fields: [
        { name: 'Bot', value: `${member.user.tag} (\`${member.id}\`)`, inline: true },
        { name: 'Ekleyen', value: adder ? `${adder} (\`${adder.id}\`)` : 'Bilinmiyor', inline: true },
      ],
    });
  });
}
