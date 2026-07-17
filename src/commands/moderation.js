import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { Tier, tierOf, outranks, hasTier } from '../permissions.js';
import { okEmbed, errEmbed, baseEmbed, Colors } from '../embeds.js';
import {
  addWarn, warnsOf, deleteWarn, clearWarns, addCase, scheduleTask, cancelTasks,
  userNotes, getSetting, setSetting,
} from '../db.js';
import { escalationConfig, escalationAction } from '../escalation.js';
import { parseDuration, formatDuration, clean, discordTime } from '../util.js';
import { sendLog } from '../modlog.js';

const MAX_TIMEOUT_MS = 28 * 86_400_000; // Discord limit

/** Best-effort DM before punishing (fails silently for closed DMs). */
async function notify(user, text) {
  try {
    await user.send(text);
  } catch {
    /* DMs closed */
  }
}

function logAction(interaction, { title, color, target, reason, extra = [] }) {
  return sendLog(interaction.client, {
    title,
    color,
    fields: [
      { name: 'Kullanıcı', value: `${target} (\`${target.id ?? target}\`)`, inline: true },
      { name: 'Yetkili', value: `${interaction.user} (\`${interaction.user.id}\`)`, inline: true },
      { name: 'Sebep', value: clean(reason || 'Belirtilmedi'), inline: false },
      ...extra,
    ],
  });
}

/**
 * Guards shared by punish commands: target exists, isn't the actor/bot, actor
 * outranks target, bot can act on target. Returns an error string or null.
 */
function punishGuard(interaction, member, { needBot = true } = {}) {
  if (!member) return null; // user not in guild (e.g. hackban) — allowed for ban
  if (member.id === interaction.user.id) return 'Kendine işlem uygulayamazsın.';
  if (member.id === interaction.client.user.id) return 'Bana işlem uygulayamazsın.';
  if (!outranks(interaction.member, member)) {
    return 'Bu kullanıcıya işlem yapamazsın (seninle aynı veya daha üst yetkide).';
  }
  if (needBot && !member.manageable && !member.moderatable && !member.bannable) {
    return 'Botun bu kullanıcıya yetkisi yetmiyor (rol sıralamasını kontrol et).';
  }
  return null;
}

export default [
  {
    tier: Tier.BMOD,
    data: new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Bir kullanıcıyı Discord sunucusundan yasaklar (süre verilirse süreli)')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Yasaklanacak kullanıcı').setRequired(true))
      .addStringOption((o) => o.setName('sebep').setDescription('Yasak sebebi'))
      .addStringOption((o) => o.setName('süre').setDescription('Süreli ban: 1g, 12sa, 1hf… (boş = kalıcı)'))
      .addIntegerOption((o) =>
        o.setName('mesaj-sil').setDescription('Son kaç günün mesajları silinsin (0-7)').setMinValue(0).setMaxValue(7)),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const reason = interaction.options.getString('sebep') ?? 'Sebep belirtilmedi';
      const days = interaction.options.getInteger('mesaj-sil') ?? 0;
      const rawDuration = interaction.options.getString('süre');
      let durationMs = null;
      if (rawDuration) {
        durationMs = parseDuration(rawDuration);
        if (!durationMs) {
          return interaction.reply({ embeds: [errEmbed('Süre anlaşılamadı. Örnek: `1g`, `12sa`, `1hf`.')], ephemeral: true });
        }
      }
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);

      const err = punishGuard(interaction, member);
      if (err) return interaction.reply({ embeds: [errEmbed(err)], ephemeral: true });
      if (member && !member.bannable) {
        return interaction.reply({ embeds: [errEmbed('Bu kullanıcıyı yasaklayamıyorum (rol sıralaması).')], ephemeral: true });
      }

      const durText = durationMs ? `**${formatDuration(durationMs)}** süreyle` : 'kalıcı olarak';
      await notify(user, `**Nautilus PvP** sunucusundan ${durText} yasaklandın.\nSebep: ${reason}`);
      await interaction.guild.members.ban(user.id, { reason: `${interaction.user.tag}: ${reason}`, deleteMessageSeconds: days * 86_400 });
      if (durationMs) {
        cancelTasks('unban', user.id); // önceki süreli ban görevini geçersiz kıl
        scheduleTask('unban', Date.now() + durationMs, { userId: user.id });
      }
      addCase('ban', user.id, interaction.user.id, reason, durationMs ? formatDuration(durationMs) : 'kalıcı');
      await logAction(interaction, {
        title: durationMs ? '⏳ Süreli Ban' : '🔨 Ban', color: Colors.danger, target: user, reason,
        extra: durationMs ? [{ name: 'Bitiş', value: discordTime(Date.now() + durationMs, 'f'), inline: true }] : [],
      });
      return interaction.reply({
        embeds: [okEmbed(`🔨 ${user} ${durText} yasaklandı.\n**Sebep:** ${clean(reason)}`
          + (durationMs ? `\n**Bitiş:** ${discordTime(Date.now() + durationMs, 'f')}` : ''))],
      });
    },
  },

  {
    tier: Tier.BMOD,
    data: new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Bir kullanıcının Discord yasağını kaldırır')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addStringOption((o) => o.setName('kullanıcı-id').setDescription('Yasağı kaldırılacak kullanıcının ID\'si').setRequired(true))
      .addStringOption((o) => o.setName('sebep').setDescription('Sebep')),
    async execute(interaction) {
      const id = interaction.options.getString('kullanıcı-id', true).trim();
      const reason = interaction.options.getString('sebep') ?? 'Sebep belirtilmedi';
      const ban = await interaction.guild.bans.fetch(id).catch(() => null);
      if (!ban) {
        return interaction.reply({ embeds: [errEmbed('Bu ID ile yasaklı bir kullanıcı bulunamadı.')], ephemeral: true });
      }
      await interaction.guild.members.unban(id, `${interaction.user.tag}: ${reason}`);
      cancelTasks('unban', id); // bekleyen otomatik unban görevi varsa iptal et
      addCase('unban', id, interaction.user.id, reason);
      await logAction(interaction, { title: '🔓 Unban', color: Colors.success, target: ban.user, reason });
      return interaction.reply({ embeds: [okEmbed(`🔓 **${ban.user.tag}** kullanıcısının yasağı kaldırıldı.`)] });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Bir kullanıcıyı sunucudan atar')
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Atılacak kullanıcı').setRequired(true))
      .addStringOption((o) => o.setName('sebep').setDescription('Sebep')),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const reason = interaction.options.getString('sebep') ?? 'Sebep belirtilmedi';
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.reply({ embeds: [errEmbed('Kullanıcı sunucuda değil.')], ephemeral: true });
      const err = punishGuard(interaction, member);
      if (err) return interaction.reply({ embeds: [errEmbed(err)], ephemeral: true });
      if (!member.kickable) {
        return interaction.reply({ embeds: [errEmbed('Bu kullanıcıyı atamıyorum (rol sıralaması).')], ephemeral: true });
      }
      await notify(user, `**Nautilus PvP** sunucusundan atıldın.\nSebep: ${reason}`);
      await member.kick(`${interaction.user.tag}: ${reason}`);
      addCase('kick', user.id, interaction.user.id, reason);
      await logAction(interaction, { title: '👢 Kick', color: Colors.warn, target: user, reason });
      return interaction.reply({ embeds: [okEmbed(`👢 ${user} sunucudan atıldı.\n**Sebep:** ${clean(reason)}`)] });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('mute')
      .setDescription('Bir kullanıcıyı susturur (timeout)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Susturulacak kullanıcı').setRequired(true))
      .addStringOption((o) => o.setName('süre').setDescription('Örn: 10dk, 2sa, 7g (boş = 1sa)'))
      .addStringOption((o) => o.setName('sebep').setDescription('Sebep')),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const rawDuration = interaction.options.getString('süre');
      const reason = interaction.options.getString('sebep') ?? 'Sebep belirtilmedi';
      let duration = rawDuration ? parseDuration(rawDuration) : 3_600_000;
      if (!duration) {
        return interaction.reply({ embeds: [errEmbed('Süre anlaşılamadı. Örnek: `10dk`, `2sa`, `7g`.')], ephemeral: true });
      }
      duration = Math.min(duration, MAX_TIMEOUT_MS);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.reply({ embeds: [errEmbed('Kullanıcı sunucuda değil.')], ephemeral: true });
      const err = punishGuard(interaction, member);
      if (err) return interaction.reply({ embeds: [errEmbed(err)], ephemeral: true });
      if (!member.moderatable) {
        return interaction.reply({ embeds: [errEmbed('Bu kullanıcıyı susturamıyorum (rol sıralaması).')], ephemeral: true });
      }
      await member.timeout(duration, `${interaction.user.tag}: ${reason}`);
      addCase('mute', user.id, interaction.user.id, reason, formatDuration(duration));
      await logAction(interaction, {
        title: '🔇 Mute', color: Colors.warn, target: user, reason,
        extra: [{ name: 'Süre', value: formatDuration(duration), inline: true },
          { name: 'Bitiş', value: discordTime(Date.now() + duration, 'f'), inline: true }],
      });
      return interaction.reply({ embeds: [okEmbed(`🔇 ${user} **${formatDuration(duration)}** susturuldu.\n**Sebep:** ${clean(reason)}`)] });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('unmute')
      .setDescription('Bir kullanıcının susturmasını kaldırır')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true)),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.reply({ embeds: [errEmbed('Kullanıcı sunucuda değil.')], ephemeral: true });
      if (!member.communicationDisabledUntilTimestamp || member.communicationDisabledUntilTimestamp < Date.now()) {
        return interaction.reply({ embeds: [errEmbed('Bu kullanıcı zaten susturulmuş değil.')], ephemeral: true });
      }
      await member.timeout(null, `${interaction.user.tag}: unmute`);
      addCase('unmute', user.id, interaction.user.id, null);
      await logAction(interaction, { title: '🔊 Unmute', color: Colors.success, target: user, reason: '-' });
      return interaction.reply({ embeds: [okEmbed(`🔊 ${user} kullanıcısının susturması kaldırıldı.`)] });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('uyar')
      .setDescription('Bir kullanıcıya uyarı verir')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Uyarılacak kullanıcı').setRequired(true))
      .addStringOption((o) => o.setName('sebep').setDescription('Uyarı sebebi').setRequired(true)),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const reason = interaction.options.getString('sebep', true);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      const err = punishGuard(interaction, member, { needBot: false });
      if (err) return interaction.reply({ embeds: [errEmbed(err)], ephemeral: true });
      addWarn(user.id, interaction.user.id, reason);
      const total = warnsOf(user.id).length;
      addCase('warn', user.id, interaction.user.id, reason);
      await notify(user, `**Nautilus PvP** sunucusunda uyarı aldın.\nSebep: ${reason}\nToplam uyarın: ${total}`);
      await logAction(interaction, {
        title: '⚠️ Uyarı', color: Colors.warn, target: user, reason,
        extra: [{ name: 'Toplam', value: String(total), inline: true }],
      });

      // Uyarı eskalasyonu (/admin uyarıeşiği): eşik aşıldıysa otomatik yaptırım.
      let escalated = '';
      const action = escalationAction(total, escalationConfig());
      if (action?.type === 'timeout' && member?.moderatable) {
        const ms = Math.min(action.ms, MAX_TIMEOUT_MS);
        await member.timeout(ms, `Otomatik: ${total} uyarı eşiği`);
        addCase('warn_auto_timeout', user.id, interaction.client.user.id,
          `${total} uyarı`, formatDuration(ms));
        escalated = `\n⏱️ **Otomatik yaptırım:** ${total} uyarı eşiği aşıldı — `
          + `**${formatDuration(ms)}** susturuldu.`;
      } else if (action?.type === 'ban' && (!member || member.bannable)) {
        await notify(user, `**Nautilus PvP** — ${total} uyarıya ulaştığın için sunucudan yasaklandın.`);
        await interaction.guild.members.ban(user.id, { reason: `Otomatik: ${total} uyarı eşiği` });
        addCase('warn_auto_ban', user.id, interaction.client.user.id, `${total} uyarı`);
        escalated = `\n🔨 **Otomatik yaptırım:** ${total} uyarı eşiği aşıldı — kullanıcı yasaklandı.`;
      }

      return interaction.reply({
        embeds: [okEmbed(`⚠️ ${user} uyarıldı (toplam **${total}**).\n**Sebep:** ${clean(reason)}${escalated}`)],
      });
    },
  },

  {
    tier: Tier.REHBER,
    data: new SlashCommandBuilder()
      .setName('uyarılar')
      .setDescription('Bir kullanıcının uyarılarını listeler')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true)),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const warns = warnsOf(user.id);
      if (!warns.length) {
        return interaction.reply({ embeds: [okEmbed(`${user} kullanıcısının hiç uyarısı yok.`)], ephemeral: true });
      }
      const embed = baseEmbed(Colors.warn)
        .setTitle(`⚠️ ${user.tag} — ${warns.length} uyarı`)
        .setDescription(warns.slice(0, 15).map((w) =>
          `**#${w.id}** • ${discordTime(w.created_at, 'd')} • <@${w.mod_id}>\n${clean(w.reason, 150)}`).join('\n\n'));
      return interaction.reply({ embeds: [embed], ephemeral: true });
    },
  },

  {
    tier: Tier.BMOD,
    data: new SlashCommandBuilder()
      .setName('uyarısil')
      .setDescription('Bir kullanıcının uyarısını/uyarılarını siler')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true))
      .addIntegerOption((o) => o.setName('uyarı-no').setDescription('Silinecek uyarı numarası (boş = hepsi)')),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const id = interaction.options.getInteger('uyarı-no');
      if (id != null) {
        if (!deleteWarn(id, user.id)) {
          return interaction.reply({ embeds: [errEmbed(`#${id} numaralı uyarı bu kullanıcıda bulunamadı.`)], ephemeral: true });
        }
        addCase('warn_delete', user.id, interaction.user.id, `#${id}`);
        return interaction.reply({ embeds: [okEmbed(`🧹 ${user} kullanıcısının **#${id}** numaralı uyarısı silindi.`)] });
      }
      const removed = clearWarns(user.id);
      addCase('warn_clear', user.id, interaction.user.id, `${removed} uyarı`);
      return interaction.reply({ embeds: [okEmbed(`🧹 ${user} kullanıcısının **${removed}** uyarısı silindi.`)] });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('sil')
      .setDescription('Kanaldan mesaj siler')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addIntegerOption((o) => o.setName('adet').setDescription('Silinecek mesaj sayısı (1-100)').setMinValue(1).setMaxValue(100).setRequired(true))
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Sadece bu kullanıcının mesajları'))
      .addBooleanOption((o) => o.setName('bot').setDescription('Sadece bot mesajları'))
      .addStringOption((o) => o.setName('içerik').setDescription('Sadece bu metni içeren mesajlar')),
    async execute(interaction) {
      const amount = interaction.options.getInteger('adet', true);
      const user = interaction.options.getUser('kullanıcı');
      const onlyBots = interaction.options.getBoolean('bot') ?? false;
      const needle = interaction.options.getString('içerik')?.toLowerCase();
      await interaction.deferReply({ ephemeral: true });
      let messages = await interaction.channel.messages.fetch({ limit: 100 });
      if (user) messages = messages.filter((m) => m.author.id === user.id);
      if (onlyBots) messages = messages.filter((m) => m.author.bot);
      if (needle) messages = messages.filter((m) => m.content?.toLowerCase().includes(needle));
      const targets = [...messages.values()].slice(0, amount);
      const deleted = await interaction.channel.bulkDelete(targets, true);
      addCase('purge', user?.id ?? null, interaction.user.id, null, `${deleted.size} mesaj / #${interaction.channel.name}`);
      await sendLog(interaction.client, {
        title: '🧹 Mesaj Silme', color: Colors.info,
        description: `${interaction.user} — ${interaction.channel} kanalında **${deleted.size}** mesaj sildi`
          + (user ? ` (hedef: ${user})` : '') + '.',
      });
      return interaction.editReply({ embeds: [okEmbed(`🧹 **${deleted.size}** mesaj silindi. (14 günden eski mesajlar silinemez)`)] });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('kilit')
      .setDescription('Kanalı kilitler veya açar')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addSubcommand((s) => s.setName('kapat').setDescription('Kanalı yazıma kapatır')
        .addStringOption((o) => o.setName('sebep').setDescription('Sebep')))
      .addSubcommand((s) => s.setName('aç').setDescription('Kanalı yazıma açar')),
    async execute(interaction) {
      const lock = interaction.options.getSubcommand() === 'kapat';
      const reason = interaction.options.getString('sebep') ?? undefined;
      await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        SendMessages: lock ? false : null,
      });
      addCase(lock ? 'lock' : 'unlock', null, interaction.user.id, reason, `#${interaction.channel.name}`);
      const embed = lock
        ? baseEmbed(Colors.danger).setDescription(`🔒 Kanal kilitlendi.${reason ? `\n**Sebep:** ${clean(reason)}` : ''}`)
        : baseEmbed(Colors.success).setDescription('🔓 Kanal kilidi açıldı.');
      return interaction.reply({ embeds: [embed] });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('yavaşmod')
      .setDescription('Kanal yavaş modunu ayarlar')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addIntegerOption((o) => o.setName('saniye').setDescription('0 = kapalı, en fazla 21600').setMinValue(0).setMaxValue(21_600).setRequired(true)),
    async execute(interaction) {
      const secs = interaction.options.getInteger('saniye', true);
      await interaction.channel.setRateLimitPerUser(secs, `${interaction.user.tag}`);
      return interaction.reply({
        embeds: [okEmbed(secs === 0 ? '🐇 Yavaş mod kapatıldı.' : `🐢 Yavaş mod **${secs} saniye** olarak ayarlandı.`)],
      });
    },
  },

  {
    tier: Tier.ADMIN,
    data: new SlashCommandBuilder()
      .setName('rolver')
      .setDescription('Bir kullanıcıya rol verir')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true))
      .addRoleOption((o) => o.setName('rol').setDescription('Verilecek rol').setRequired(true)),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const role = interaction.options.getRole('rol', true);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.reply({ embeds: [errEmbed('Kullanıcı sunucuda değil.')], ephemeral: true });
      const me = interaction.guild.members.me;
      if (role.position >= me.roles.highest.position || role.managed) {
        return interaction.reply({ embeds: [errEmbed('Bu rolü veremiyorum (rol sıralaması / yönetilen rol).')], ephemeral: true });
      }
      if (role.position >= interaction.member.roles.highest.position && tierOf(interaction.member) < Tier.KURUCU) {
        return interaction.reply({ embeds: [errEmbed('Kendi en yüksek rolünden üstte/eşit bir rolü veremezsin.')], ephemeral: true });
      }
      await member.roles.add(role, `${interaction.user.tag}`);
      addCase('role_add', user.id, interaction.user.id, role.name);
      await logAction(interaction, { title: '➕ Rol Verildi', color: Colors.info, target: user, reason: role.name });
      return interaction.reply({ embeds: [okEmbed(`➕ ${user} kullanıcısına ${role} rolü verildi.`)] });
    },
  },

  {
    tier: Tier.ADMIN,
    data: new SlashCommandBuilder()
      .setName('rolal')
      .setDescription('Bir kullanıcıdan rol alır')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true))
      .addRoleOption((o) => o.setName('rol').setDescription('Alınacak rol').setRequired(true)),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const role = interaction.options.getRole('rol', true);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.reply({ embeds: [errEmbed('Kullanıcı sunucuda değil.')], ephemeral: true });
      const me = interaction.guild.members.me;
      if (role.position >= me.roles.highest.position || role.managed) {
        return interaction.reply({ embeds: [errEmbed('Bu rolü alamıyorum (rol sıralaması / yönetilen rol).')], ephemeral: true });
      }
      if (role.position >= interaction.member.roles.highest.position && tierOf(interaction.member) < Tier.KURUCU) {
        return interaction.reply({ embeds: [errEmbed('Kendi en yüksek rolünden üstte/eşit bir rolü alamazsın.')], ephemeral: true });
      }
      await member.roles.remove(role, `${interaction.user.tag}`);
      addCase('role_remove', user.id, interaction.user.id, role.name);
      await logAction(interaction, { title: '➖ Rol Alındı', color: Colors.info, target: user, reason: role.name });
      return interaction.reply({ embeds: [okEmbed(`➖ ${user} kullanıcısından ${role} rolü alındı.`)] });
    },
  },

  {
    tier: Tier.BMOD,
    data: new SlashCommandBuilder()
      .setName('softban')
      .setDescription('Kullanıcıyı yasaklayıp hemen kaldırır (mesajlarını temizlemek için)')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true))
      .addStringOption((o) => o.setName('sebep').setDescription('Sebep'))
      .addIntegerOption((o) => o.setName('gün')
        .setDescription('Son kaç günün mesajları silinsin (1-7, varsayılan 1)').setMinValue(1).setMaxValue(7)),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const reason = interaction.options.getString('sebep') ?? 'Sebep belirtilmedi';
      const days = interaction.options.getInteger('gün') ?? 1;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      const err = punishGuard(interaction, member);
      if (err) return interaction.reply({ embeds: [errEmbed(err)], ephemeral: true });
      if (member && !member.bannable) {
        return interaction.reply({ embeds: [errEmbed('Bu kullanıcıya softban uygulayamıyorum (rol sıralaması).')], ephemeral: true });
      }
      await notify(user, `**Nautilus PvP** sunucusundan mesaj temizliği için atıldın (softban).\nSebep: ${reason}\nTekrar katılabilirsin.`);
      await interaction.guild.members.ban(user.id, {
        reason: `Softban ${interaction.user.tag}: ${reason}`,
        deleteMessageSeconds: days * 86_400,
      });
      await interaction.guild.members.unban(user.id, `Softban ${interaction.user.tag}`);
      addCase('softban', user.id, interaction.user.id, reason, `${days} gün mesaj temizliği`);
      await logAction(interaction, {
        title: '🧽 Softban', color: Colors.warn, target: user, reason,
        extra: [{ name: 'Mesaj temizliği', value: `${days} gün`, inline: true }],
      });
      return interaction.reply({
        embeds: [okEmbed(`🧽 ${user} softban'landı — son **${days}** günün mesajları silindi, kullanıcı tekrar katılabilir.\n**Sebep:** ${clean(reason)}`)],
      });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('nick')
      .setDescription('Bir kullanıcının takma adını değiştirir veya sıfırlar')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true))
      .addStringOption((o) => o.setName('isim').setDescription('Yeni takma ad (boş bırak = sıfırla)').setMaxLength(32)),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const nick = interaction.options.getString('isim')?.trim() || null;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.reply({ embeds: [errEmbed('Kullanıcı sunucuda değil.')], ephemeral: true });
      const err = punishGuard(interaction, member, { needBot: false });
      if (err) return interaction.reply({ embeds: [errEmbed(err)], ephemeral: true });
      if (!member.manageable) {
        return interaction.reply({ embeds: [errEmbed('Bu kullanıcının takma adını değiştiremiyorum (rol sıralaması).')], ephemeral: true });
      }
      await member.setNickname(nick, `${interaction.user.tag}`);
      addCase('nick', user.id, interaction.user.id, null, nick ?? 'sıfırlandı');
      return interaction.reply({
        embeds: [okEmbed(nick
          ? `✏️ ${user} kullanıcısının takma adı **${clean(nick, 32)}** yapıldı.`
          : `✏️ ${user} kullanıcısının takma adı sıfırlandı.`)],
      });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('not')
      .setDescription('Kullanıcı hakkında yetkili notları (yalnız yetkililer görür)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addSubcommand((s) => s.setName('ekle').setDescription('Kullanıcıya not ekler')
        .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true))
        .addStringOption((o) => o.setName('not').setDescription('Not metni').setRequired(true).setMaxLength(500)))
      .addSubcommand((s) => s.setName('liste').setDescription('Kullanıcının notlarını listeler')
        .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true)))
      .addSubcommand((s) => s.setName('sil').setDescription('Bir notu siler (BMod+)')
        .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true))
        .addIntegerOption((o) => o.setName('not-no').setDescription('Silinecek not numarası').setRequired(true))),
    async execute(interaction) {
      const sub = interaction.options.getSubcommand();
      const user = interaction.options.getUser('kullanıcı', true);
      if (sub === 'ekle') {
        const note = interaction.options.getString('not', true);
        const id = userNotes.add(user.id, interaction.user.id, note);
        addCase('note_add', user.id, interaction.user.id, null, `#${id}`);
        return interaction.reply({
          embeds: [okEmbed(`📝 ${user} için **#${id}** numaralı not eklendi.`)], ephemeral: true,
        });
      }
      if (sub === 'sil') {
        if (!hasTier(interaction.member, Tier.BMOD)) {
          return interaction.reply({ embeds: [errEmbed('Not silmek için en az **BMod** yetkisi gerekir.')], ephemeral: true });
        }
        const id = interaction.options.getInteger('not-no', true);
        if (!userNotes.remove(id, user.id)) {
          return interaction.reply({ embeds: [errEmbed(`#${id} numaralı not bu kullanıcıda bulunamadı.`)], ephemeral: true });
        }
        addCase('note_delete', user.id, interaction.user.id, null, `#${id}`);
        return interaction.reply({ embeds: [okEmbed(`🗑️ **#${id}** numaralı not silindi.`)], ephemeral: true });
      }
      // liste
      const notes = userNotes.of(user.id);
      if (!notes.length) {
        return interaction.reply({ embeds: [okEmbed(`${user} için kayıtlı not yok.`)], ephemeral: true });
      }
      const embed = baseEmbed(Colors.info)
        .setTitle(`📝 Notlar — ${user.tag} (${userNotes.count(user.id)})`)
        .setDescription(notes.map((n) =>
          `**#${n.id}** • ${discordTime(n.created_at, 'd')} • <@${n.author_id}>\n${clean(n.note, 200)}`)
          .join('\n\n').slice(0, 3900));
      return interaction.reply({ embeds: [embed], ephemeral: true });
    },
  },

  {
    tier: Tier.BMOD,
    data: new SlashCommandBuilder()
      .setName('lockdown')
      .setDescription('Tüm metin kanallarını kilitler/açar (acil durum)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addSubcommand((s) => s.setName('başlat').setDescription('Tüm metin kanallarını yazıma kapatır')
        .addStringOption((o) => o.setName('sebep').setDescription('Sebep').setRequired(true)))
      .addSubcommand((s) => s.setName('bitir').setDescription('Lockdown\'ı kaldırır (yalnız kilitlenenleri açar)')),
    async execute(interaction) {
      const sub = interaction.options.getSubcommand();
      await interaction.deferReply({ ephemeral: true });
      const everyone = interaction.guild.roles.everyone;

      if (sub === 'başlat') {
        const reason = interaction.options.getString('sebep', true);
        const already = JSON.parse(getSetting('lockdown_channels', '[]') || '[]');
        if (already.length) {
          return interaction.editReply({ embeds: [errEmbed('Zaten aktif bir lockdown var. Önce `/lockdown bitir` kullan.')] });
        }
        const locked = [];
        for (const channel of interaction.guild.channels.cache.values()) {
          if (channel.type !== ChannelType.GuildText) continue;
          // Zaten @everyone'a kapalı kanallara dokunma — bitir'de yanlışlıkla açılmasınlar.
          const ow = channel.permissionOverwrites.cache.get(everyone.id);
          if (ow?.deny.has(PermissionFlagsBits.SendMessages)) continue;
          try {
            await channel.permissionOverwrites.edit(everyone, { SendMessages: false },
              { reason: `Lockdown: ${reason}` });
            locked.push(channel.id);
          } catch { /* tek kanal hatası tüm lockdown'ı durdurmasın */ }
        }
        setSetting('lockdown_channels', JSON.stringify(locked));
        addCase('lockdown', null, interaction.user.id, reason, `${locked.length} kanal`);
        await sendLog(interaction.client, {
          title: '🔒 LOCKDOWN BAŞLATILDI', color: Colors.danger,
          description: `${interaction.user} — **${locked.length}** kanal kilitlendi.\n**Sebep:** ${clean(reason)}`,
        });
        return interaction.editReply({
          embeds: [okEmbed(`🔒 Lockdown aktif — **${locked.length}** metin kanalı kilitlendi.\n**Sebep:** ${clean(reason)}`)],
        });
      }

      // bitir
      const locked = JSON.parse(getSetting('lockdown_channels', '[]') || '[]');
      if (!locked.length) {
        return interaction.editReply({ embeds: [errEmbed('Aktif bir lockdown yok.')] });
      }
      let opened = 0;
      for (const id of locked) {
        const channel = interaction.guild.channels.cache.get(id);
        if (!channel) continue;
        try {
          await channel.permissionOverwrites.edit(everyone, { SendMessages: null },
            { reason: 'Lockdown bitti' });
          opened++;
        } catch { /* kanal silinmiş olabilir */ }
      }
      setSetting('lockdown_channels', '[]');
      addCase('lockdown_end', null, interaction.user.id, null, `${opened} kanal`);
      await sendLog(interaction.client, {
        title: '🔓 Lockdown Bitti', color: Colors.success,
        description: `${interaction.user} — **${opened}** kanal yeniden açıldı.`,
      });
      return interaction.editReply({ embeds: [okEmbed(`🔓 Lockdown kaldırıldı — **${opened}** kanal yeniden açıldı.`)] });
    },
  },
];
