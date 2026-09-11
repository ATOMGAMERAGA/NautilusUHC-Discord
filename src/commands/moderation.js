import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { Tier, tierOf, outranks, hasTier } from '../permissions.js';
import {
  okEmbed, errEmbed, baseEmbed, emptyEmbed, brandFooter, Colors, Brand,
} from '../embeds.js';
import {
  addWarn, warnsOf, deleteWarn, clearWarns, addCase, scheduleTask, cancelTasks,
  userNotes, getSetting, setSetting,
} from '../db.js';
import { escalationConfig, escalationAction } from '../escalation.js';
import { parseDuration, formatDuration, clean, codeText, discordTime } from '../util.js';
import { sendLog } from '../modlog.js';

const MAX_TIMEOUT_MS = 28 * 86_400_000; // Discord limit

/**
 * Moderasyon UX'i iki yüzeylidir:
 *  - Kanal yanıtı: kısa, ne olduğunu söyleyen onay kartı (aksiyon • hedef •
 *    süre • sebep • kayıt no).
 *  - Log kanalı: sabit alan düzeninde ayrıntılı kayıt (modlog.js).
 * Cezalandırılan kişiye giden DM ayrı bir yüzeydir: suçlayıcı değil, ne olduğunu
 * ve varsa itiraz yolunu söyler.
 */

/** Best-effort DM before punishing (fails silently for closed DMs). */
async function notify(user, embed) {
  try {
    await user.send({ embeds: [embed] });
  } catch {
    /* DMs closed */
  }
}

/** Cezalandırılan üyeye giden bilgilendirme kartı. */
function punishmentDm(title, description, { reason, duration } = {}) {
  const e = baseEmbed(Colors.danger).setTitle(title).setDescription(description).setTimestamp();
  const fields = [];
  if (duration) fields.push({ name: 'Süre', value: duration, inline: true });
  if (reason) fields.push({ name: 'Sebep', value: clean(reason, 500), inline: false });
  if (fields.length) e.addFields(fields);
  e.addFields({
    name: 'İtiraz',
    value: `Kararın hatalı olduğunu düşünüyorsan ${Brand.community} sunucusunda \`/destek aç\` ile itiraz talebi oluşturabilirsin.`,
  });
  return e;
}

function logAction(interaction, { title, color, target, reason, caseId, extra = [] }) {
  return sendLog(interaction.client, {
    title,
    color,
    fields: [
      { name: 'Kullanıcı', value: `${target} (\`${target.id ?? target}\`)`, inline: true },
      { name: 'Yetkili', value: `${interaction.user} (\`${interaction.user.id}\`)`, inline: true },
      ...extra,
      { name: 'Sebep', value: clean(reason || 'Belirtilmedi'), inline: false },
      ...(caseId ? [{ name: 'Kayıt', value: `#${caseId}`, inline: true }] : []),
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
    return 'Bu kullanıcı seninle aynı veya daha üst yetkide, işlem uygulayamazsın.';
  }
  if (needBot && !member.manageable && !member.moderatable && !member.bannable) {
    return 'Botun bu kullanıcıya yetkisi yetmiyor. Botun rolünü hedefin rolünün üstüne al.';
  }
  return null;
}

/** Tek biçimli engel yanıtı — her zaman ephemeral. */
function blocked(interaction, message, title = 'İşlem Yapılamadı') {
  return interaction.reply({ embeds: [errEmbed(message, title)], flags: MessageFlags.Ephemeral });
}

export default [
  {
    tier: Tier.BMOD,
    data: new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Bir kullanıcıyı sunucudan yasaklar (süre verilirse süreli)')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Yasaklanacak kullanıcı').setRequired(true))
      .addStringOption((o) => o.setName('sebep').setDescription('Yasak sebebi'))
      .addStringOption((o) => o.setName('süre').setDescription('Süreli ban: 1g, 12sa, 1hf (boş = kalıcı)'))
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
          return blocked(interaction, 'Süreyi anlayamadım. Örnek: `1g`, `12sa`, `1hf`.', 'Geçersiz Süre');
        }
      }
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);

      const err = punishGuard(interaction, member);
      if (err) return blocked(interaction, err);
      if (member && !member.bannable) {
        return blocked(interaction, 'Bu kullanıcıyı yasaklayamıyorum. Botun rolü hedefin rolünün altında.');
      }

      const durText = durationMs ? formatDuration(durationMs) : 'Kalıcı';
      await notify(user, punishmentDm(
        'Sunucudan Yasaklandın',
        `${Brand.community} sunucusundan ${durationMs ? `**${durText}** süreyle` : '**kalıcı olarak**'} yasaklandın.`,
        { reason, duration: durText },
      ));
      await interaction.guild.members.ban(user.id, { reason: `${interaction.user.tag}: ${reason}`, deleteMessageSeconds: days * 86_400 });
      if (durationMs) {
        cancelTasks('unban', user.id); // önceki süreli ban görevini geçersiz kıl
        scheduleTask('unban', Date.now() + durationMs, { userId: user.id });
      }
      const caseId = addCase('ban', user.id, interaction.user.id, reason, durationMs ? formatDuration(durationMs) : 'kalıcı');
      await logAction(interaction, {
        title: durationMs ? 'Süreli Ban' : 'Ban', color: Colors.danger, target: user, reason, caseId,
        extra: [
          { name: 'Süre', value: durText, inline: true },
          ...(durationMs ? [{ name: 'Bitiş', value: discordTime(Date.now() + durationMs, 'f'), inline: true }] : []),
        ],
      });
      return interaction.reply({
        embeds: [okEmbed(
          `${user} sunucudan ${durationMs ? `**${durText}** süreyle` : '**kalıcı olarak**'} yasaklandı.\n`
          + `Sebep: ${clean(reason, 300)}`
          + (durationMs ? `\nBitiş: ${discordTime(Date.now() + durationMs, 'f')}` : ''),
          '🔨 Kullanıcı Yasaklandı',
        ).setFooter(brandFooter(`Kayıt #${caseId}`))],
      });
    },
  },

  {
    tier: Tier.BMOD,
    data: new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Bir kullanıcının sunucu yasağını kaldırır')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addStringOption((o) => o.setName('kullanıcı-id').setDescription('Yasağı kaldırılacak kullanıcının ID\'si').setRequired(true))
      .addStringOption((o) => o.setName('sebep').setDescription('Yasağın kaldırılma sebebi')),
    async execute(interaction) {
      const id = interaction.options.getString('kullanıcı-id', true).trim();
      const reason = interaction.options.getString('sebep') ?? 'Sebep belirtilmedi';
      const ban = await interaction.guild.bans.fetch(id).catch(() => null);
      if (!ban) {
        return blocked(interaction, 'Bu ID ile yasaklı bir kullanıcı yok. ID\'yi yasak listesinden kontrol edebilirsin.',
          'Yasak Kaydı Bulunamadı');
      }
      await interaction.guild.members.unban(id, `${interaction.user.tag}: ${reason}`);
      cancelTasks('unban', id); // bekleyen otomatik unban görevi varsa iptal et
      const caseId = addCase('unban', id, interaction.user.id, reason);
      await logAction(interaction, { title: 'Ban Kaldırıldı', color: Colors.success, target: ban.user, reason, caseId });
      return interaction.reply({
        embeds: [okEmbed(`**${codeText(ban.user.tag, 40)}** artık sunucuya tekrar katılabilir.`, '🔓 Yasak Kaldırıldı')
          .setFooter(brandFooter(`Kayıt #${caseId}`))],
      });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Bir kullanıcıyı sunucudan atar')
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Atılacak kullanıcı').setRequired(true))
      .addStringOption((o) => o.setName('sebep').setDescription('İşlem sebebi')),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const reason = interaction.options.getString('sebep') ?? 'Sebep belirtilmedi';
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return blocked(interaction, 'Bu kullanıcı sunucuda değil.', 'Kullanıcı Bulunamadı');
      const err = punishGuard(interaction, member);
      if (err) return blocked(interaction, err);
      if (!member.kickable) {
        return blocked(interaction, 'Bu kullanıcıyı atamıyorum. Botun rolü hedefin rolünün altında.');
      }
      await notify(user, punishmentDm(
        'Sunucudan Atıldın',
        `${Brand.community} sunucusundan atıldın. Davet linkiyle tekrar katılabilirsin.`,
        { reason },
      ));
      await member.kick(`${interaction.user.tag}: ${reason}`);
      const caseId = addCase('kick', user.id, interaction.user.id, reason);
      await logAction(interaction, { title: 'Kick', color: Colors.warn, target: user, reason, caseId });
      return interaction.reply({
        embeds: [okEmbed(`${user} sunucudan atıldı.\nSebep: ${clean(reason, 300)}`, '👢 Kullanıcı Atıldı')
          .setFooter(brandFooter(`Kayıt #${caseId}`))],
      });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('mute')
      .setDescription('Bir kullanıcıyı geçici olarak susturur')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Susturulacak kullanıcı').setRequired(true))
      .addStringOption((o) => o.setName('süre').setDescription('Örn: 10dk, 2sa, 7g (boş = 1 saat)'))
      .addStringOption((o) => o.setName('sebep').setDescription('İşlem sebebi')),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const rawDuration = interaction.options.getString('süre');
      const reason = interaction.options.getString('sebep') ?? 'Sebep belirtilmedi';
      let duration = rawDuration ? parseDuration(rawDuration) : 3_600_000;
      if (!duration) {
        return blocked(interaction, 'Süreyi anlayamadım. Örnek: `10dk`, `2sa`, `7g`.', 'Geçersiz Süre');
      }
      duration = Math.min(duration, MAX_TIMEOUT_MS);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return blocked(interaction, 'Bu kullanıcı sunucuda değil.', 'Kullanıcı Bulunamadı');
      const err = punishGuard(interaction, member);
      if (err) return blocked(interaction, err);
      if (!member.moderatable) {
        return blocked(interaction, 'Bu kullanıcıyı susturamıyorum. Botun rolü hedefin rolünün altında.');
      }
      await member.timeout(duration, `${interaction.user.tag}: ${reason}`);
      await notify(user, punishmentDm(
        'Susturuldun',
        `${Brand.community} sunucusunda **${formatDuration(duration)}** süreyle susturuldun.\n`
        + `Susturma ${discordTime(Date.now() + duration, 'R')} sona erecek.`,
        { reason, duration: formatDuration(duration) },
      ));
      const caseId = addCase('mute', user.id, interaction.user.id, reason, formatDuration(duration));
      await logAction(interaction, {
        title: 'Susturma', color: Colors.warn, target: user, reason, caseId,
        extra: [
          { name: 'Süre', value: formatDuration(duration), inline: true },
          { name: 'Bitiş', value: discordTime(Date.now() + duration, 'f'), inline: true },
        ],
      });
      return interaction.reply({
        embeds: [okEmbed(
          `${user} **${formatDuration(duration)}** susturuldu — ${discordTime(Date.now() + duration, 'R')} açılacak.\n`
          + `Sebep: ${clean(reason, 300)}`,
          '🔇 Kullanıcı Susturuldu',
        ).setFooter(brandFooter(`Kayıt #${caseId}`))],
      });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('unmute')
      .setDescription('Bir kullanıcının susturmasını kaldırır')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Susturması kaldırılacak kullanıcı').setRequired(true)),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return blocked(interaction, 'Bu kullanıcı sunucuda değil.', 'Kullanıcı Bulunamadı');
      if (!member.communicationDisabledUntilTimestamp || member.communicationDisabledUntilTimestamp < Date.now()) {
        return blocked(interaction, `${user} şu anda susturulmuş değil.`, 'Susturma Yok');
      }
      await member.timeout(null, `${interaction.user.tag}: unmute`);
      const caseId = addCase('unmute', user.id, interaction.user.id, null);
      await logAction(interaction, { title: 'Susturma Kaldırıldı', color: Colors.success, target: user, reason: '—', caseId });
      return interaction.reply({
        embeds: [okEmbed(`${user} tekrar yazabilir.`, '🔊 Susturma Kaldırıldı')
          .setFooter(brandFooter(`Kayıt #${caseId}`))],
      });
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
      if (err) return blocked(interaction, err);
      addWarn(user.id, interaction.user.id, reason);
      const total = warnsOf(user.id).length;
      const caseId = addCase('warn', user.id, interaction.user.id, reason);
      await notify(user, punishmentDm(
        'Uyarı Aldın',
        `${Brand.community} sunucusunda bir uyarı aldın. Toplam uyarı sayın: **${total}**.`,
        { reason },
      ));
      await logAction(interaction, {
        title: 'Uyarı', color: Colors.warn, target: user, reason, caseId,
        extra: [{ name: 'Toplam uyarı', value: String(total), inline: true }],
      });

      // Uyarı eskalasyonu (/admin uyarıeşiği): eşik aşıldıysa otomatik yaptırım.
      let escalated = '';
      const action = escalationAction(total, escalationConfig());
      if (action?.type === 'timeout' && member?.moderatable) {
        const ms = Math.min(action.ms, MAX_TIMEOUT_MS);
        await member.timeout(ms, `Otomatik: ${total} uyarı eşiği`);
        addCase('warn_auto_timeout', user.id, interaction.client.user.id,
          `${total} uyarı`, formatDuration(ms));
        escalated = `\n\n**Otomatik yaptırım:** ${total} uyarı eşiği aşıldı, kullanıcı **${formatDuration(ms)}** susturuldu.`;
      } else if (action?.type === 'ban' && (!member || member.bannable)) {
        await notify(user, punishmentDm(
          'Sunucudan Yasaklandın',
          `${total} uyarıya ulaştığın için ${Brand.community} sunucusundan yasaklandın.`,
          { reason: `${total} uyarı eşiği` },
        ));
        await interaction.guild.members.ban(user.id, { reason: `Otomatik: ${total} uyarı eşiği` });
        addCase('warn_auto_ban', user.id, interaction.client.user.id, `${total} uyarı`);
        escalated = `\n\n**Otomatik yaptırım:** ${total} uyarı eşiği aşıldı, kullanıcı yasaklandı.`;
      }

      return interaction.reply({
        embeds: [okEmbed(
          `${user} uyarıldı. Toplam uyarı: **${total}**.\nSebep: ${clean(reason, 300)}${escalated}`,
          '⚠️ Uyarı Verildi',
        ).setFooter(brandFooter(`Kayıt #${caseId}`))],
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
        return interaction.reply({
          embeds: [emptyEmbed('Uyarı Yok', `${user} için kayıtlı bir uyarı bulunmuyor.`)],
          flags: MessageFlags.Ephemeral,
        });
      }
      const embed = baseEmbed(Colors.warn)
        .setTitle(`⚠️ Uyarılar — ${codeText(user.tag, 40)}`)
        .setDescription(warns.slice(0, 15).map((w) =>
          `**#${w.id}** • ${discordTime(w.created_at, 'd')} • <@${w.mod_id}>\n${clean(w.reason, 150)}`).join('\n\n'))
        .setFooter(brandFooter(`${warns.length} uyarı`));
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  },

  {
    tier: Tier.BMOD,
    data: new SlashCommandBuilder()
      .setName('uyarısil')
      .setDescription('Bir kullanıcının uyarısını veya tüm uyarılarını siler')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true))
      .addIntegerOption((o) => o.setName('uyarı-no').setDescription('Silinecek uyarı numarası (boş = hepsi)')),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const id = interaction.options.getInteger('uyarı-no');
      if (id != null) {
        if (!deleteWarn(id, user.id)) {
          return blocked(interaction, `**#${id}** numaralı uyarı bu kullanıcıda yok. Listeyi \`/uyarılar\` ile görebilirsin.`,
            'Uyarı Bulunamadı');
        }
        addCase('warn_delete', user.id, interaction.user.id, `#${id}`);
        return interaction.reply({
          embeds: [okEmbed(`${user} kullanıcısının **#${id}** numaralı uyarısı silindi.`, '🧹 Uyarı Silindi')],
        });
      }
      const removed = clearWarns(user.id);
      addCase('warn_clear', user.id, interaction.user.id, `${removed} uyarı`);
      return interaction.reply({
        embeds: [okEmbed(`${user} kullanıcısının **${removed}** uyarısı silindi — sicili temizlendi.`, '🧹 Uyarılar Silindi')],
      });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('sil')
      .setDescription('Kanaldaki mesajları toplu siler')
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
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let messages = await interaction.channel.messages.fetch({ limit: 100 });
      if (user) messages = messages.filter((m) => m.author.id === user.id);
      if (onlyBots) messages = messages.filter((m) => m.author.bot);
      if (needle) messages = messages.filter((m) => m.content?.toLowerCase().includes(needle));
      const targets = [...messages.values()].slice(0, amount);
      const deleted = await interaction.channel.bulkDelete(targets, true);
      addCase('purge', user?.id ?? null, interaction.user.id, null, `${deleted.size} mesaj / #${interaction.channel.name}`);
      await sendLog(interaction.client, {
        title: 'Mesaj Silme', color: Colors.info,
        fields: [
          { name: 'Yetkili', value: `${interaction.user}`, inline: true },
          { name: 'Kanal', value: `${interaction.channel}`, inline: true },
          { name: 'Silinen', value: `${deleted.size} mesaj`, inline: true },
          ...(user ? [{ name: 'Hedef kullanıcı', value: `${user}`, inline: true }] : []),
        ],
      });
      if (!deleted.size) {
        return interaction.editReply({
          embeds: [emptyEmbed('Silinecek Mesaj Bulunamadı',
            'Filtrelerine uyan bir mesaj yok.',
            'Discord 14 günden eski mesajları toplu silmeye izin vermez.')],
        });
      }
      return interaction.editReply({
        embeds: [okEmbed(`**${deleted.size}** mesaj silindi.\n14 günden eski mesajlar toplu silinemez.`,
          '🧹 Mesajlar Silindi')],
      });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('kilit')
      .setDescription('Kanalı yazıma kapatır veya açar')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addSubcommand((s) => s.setName('kapat').setDescription('Kanalı yazıma kapatır')
        .addStringOption((o) => o.setName('sebep').setDescription('Kilitleme sebebi')))
      .addSubcommand((s) => s.setName('aç').setDescription('Kanalı yazıma açar')),
    async execute(interaction) {
      const lock = interaction.options.getSubcommand() === 'kapat';
      const reason = interaction.options.getString('sebep') ?? undefined;
      await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        SendMessages: lock ? false : null,
      });
      addCase(lock ? 'lock' : 'unlock', null, interaction.user.id, reason, `#${interaction.channel.name}`);
      const embed = lock
        ? baseEmbed(Colors.danger).setTitle('🔒 Kanal Kilitlendi')
          .setDescription(`Bu kanala şimdilik yalnız yetkililer yazabilir.${reason ? `\nSebep: ${clean(reason, 300)}` : ''}`)
        : baseEmbed(Colors.success).setTitle('🔓 Kanal Açıldı')
          .setDescription('Kanal yeniden herkesin yazımına açık.');
      return interaction.reply({ embeds: [embed] });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('yavaşmod')
      .setDescription('Kanalın yavaş mod süresini ayarlar')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addIntegerOption((o) => o.setName('saniye').setDescription('0 = kapalı, en fazla 21600').setMinValue(0).setMaxValue(21_600).setRequired(true)),
    async execute(interaction) {
      const secs = interaction.options.getInteger('saniye', true);
      await interaction.channel.setRateLimitPerUser(secs, `${interaction.user.tag}`);
      return interaction.reply({
        embeds: [secs === 0
          ? okEmbed('Bu kanalda mesaj arası bekleme kalktı.', '🐇 Yavaş Mod Kapalı')
          : okEmbed(`Üyeler bu kanalda **${secs} saniyede** bir mesaj gönderebilir.`, '🐢 Yavaş Mod Açık')],
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
      if (!member) return blocked(interaction, 'Bu kullanıcı sunucuda değil.', 'Kullanıcı Bulunamadı');
      const me = interaction.guild.members.me;
      if (role.position >= me.roles.highest.position || role.managed) {
        return blocked(interaction, `${role} rolünü veremiyorum: yönetilen bir rol ya da botun rolünün üstünde.`, 'Rol Verilemedi');
      }
      if (role.position >= interaction.member.roles.highest.position && tierOf(interaction.member) < Tier.KURUCU) {
        return blocked(interaction, 'Kendi en yüksek rolünün üstündeki veya eşitindeki bir rolü veremezsin.', 'Rol Verilemedi');
      }
      await member.roles.add(role, `${interaction.user.tag}`);
      const caseId = addCase('role_add', user.id, interaction.user.id, role.name);
      await logAction(interaction, { title: 'Rol Verildi', color: Colors.info, target: user, reason: role.name, caseId });
      return interaction.reply({
        embeds: [okEmbed(`${user} kullanıcısına ${role} rolü verildi.`, '➕ Rol Verildi')],
      });
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
      if (!member) return blocked(interaction, 'Bu kullanıcı sunucuda değil.', 'Kullanıcı Bulunamadı');
      const me = interaction.guild.members.me;
      if (role.position >= me.roles.highest.position || role.managed) {
        return blocked(interaction, `${role} rolünü alamıyorum: yönetilen bir rol ya da botun rolünün üstünde.`, 'Rol Alınamadı');
      }
      if (role.position >= interaction.member.roles.highest.position && tierOf(interaction.member) < Tier.KURUCU) {
        return blocked(interaction, 'Kendi en yüksek rolünün üstündeki veya eşitindeki bir rolü alamazsın.', 'Rol Alınamadı');
      }
      await member.roles.remove(role, `${interaction.user.tag}`);
      const caseId = addCase('role_remove', user.id, interaction.user.id, role.name);
      await logAction(interaction, { title: 'Rol Alındı', color: Colors.info, target: user, reason: role.name, caseId });
      return interaction.reply({
        embeds: [okEmbed(`${user} kullanıcısından ${role} rolü alındı.`, '➖ Rol Alındı')],
      });
    },
  },

  {
    tier: Tier.BMOD,
    data: new SlashCommandBuilder()
      .setName('softban')
      .setDescription('Kullanıcıyı yasaklayıp hemen çıkarır (mesajlarını temizlemek için)')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true))
      .addStringOption((o) => o.setName('sebep').setDescription('İşlem sebebi'))
      .addIntegerOption((o) => o.setName('gün')
        .setDescription('Son kaç günün mesajları silinsin (1-7, varsayılan 1)').setMinValue(1).setMaxValue(7)),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const reason = interaction.options.getString('sebep') ?? 'Sebep belirtilmedi';
      const days = interaction.options.getInteger('gün') ?? 1;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      const err = punishGuard(interaction, member);
      if (err) return blocked(interaction, err);
      if (member && !member.bannable) {
        return blocked(interaction, 'Bu kullanıcıya softban uygulayamıyorum. Botun rolü hedefin rolünün altında.');
      }
      await notify(user, punishmentDm(
        'Sunucudan Çıkarıldın',
        `Mesaj temizliği için ${Brand.community} sunucusundan çıkarıldın (softban). Davet linkiyle tekrar katılabilirsin.`,
        { reason },
      ));
      await interaction.guild.members.ban(user.id, {
        reason: `Softban ${interaction.user.tag}: ${reason}`,
        deleteMessageSeconds: days * 86_400,
      });
      await interaction.guild.members.unban(user.id, `Softban ${interaction.user.tag}`);
      const caseId = addCase('softban', user.id, interaction.user.id, reason, `${days} gün mesaj temizliği`);
      await logAction(interaction, {
        title: 'Softban', color: Colors.warn, target: user, reason, caseId,
        extra: [{ name: 'Mesaj temizliği', value: `${days} gün`, inline: true }],
      });
      return interaction.reply({
        embeds: [okEmbed(
          `${user} sunucudan çıkarıldı ve son **${days}** günün mesajları silindi. Kullanıcı tekrar katılabilir.\n`
          + `Sebep: ${clean(reason, 300)}`,
          '🧽 Softban Uygulandı',
        ).setFooter(brandFooter(`Kayıt #${caseId}`))],
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
      .addStringOption((o) => o.setName('isim').setDescription('Yeni takma ad (boş = sıfırla)').setMaxLength(32)),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const nick = interaction.options.getString('isim')?.trim() || null;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return blocked(interaction, 'Bu kullanıcı sunucuda değil.', 'Kullanıcı Bulunamadı');
      const err = punishGuard(interaction, member, { needBot: false });
      if (err) return blocked(interaction, err);
      if (!member.manageable) {
        return blocked(interaction, 'Bu kullanıcının takma adını değiştiremiyorum. Botun rolü hedefin rolünün altında.');
      }
      await member.setNickname(nick, `${interaction.user.tag}`);
      addCase('nick', user.id, interaction.user.id, null, nick ?? 'sıfırlandı');
      return interaction.reply({
        embeds: [okEmbed(nick
          ? `${user} artık **${clean(nick, 32)}** olarak görünüyor.`
          : `${user} kullanıcısının takma adı kaldırıldı, kullanıcı adı görünüyor.`,
        '✏️ Takma Ad Güncellendi')],
      });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('not')
      .setDescription('Kullanıcı hakkında yetkili notlarını yönetir')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addSubcommand((s) => s.setName('ekle').setDescription('Kullanıcıya yetkili notu ekler')
        .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true))
        .addStringOption((o) => o.setName('not').setDescription('Not metni').setRequired(true).setMaxLength(500)))
      .addSubcommand((s) => s.setName('liste').setDescription('Kullanıcının notlarını listeler')
        .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true)))
      .addSubcommand((s) => s.setName('sil').setDescription('Bir notu siler (Baş Mod+)')
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
          embeds: [okEmbed(`${user} için **#${id}** numaralı not kaydedildi. Notları yalnız yetkililer görür.`,
            '📝 Not Eklendi')],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (sub === 'sil') {
        if (!hasTier(interaction.member, Tier.BMOD)) {
          return blocked(interaction, 'Not silmek **Baş Mod** ve üzeri yetkililere açıktır.', 'Yetki Gerekli');
        }
        const id = interaction.options.getInteger('not-no', true);
        if (!userNotes.remove(id, user.id)) {
          return blocked(interaction, `**#${id}** numaralı not bu kullanıcıda yok.`, 'Not Bulunamadı');
        }
        addCase('note_delete', user.id, interaction.user.id, null, `#${id}`);
        return interaction.reply({
          embeds: [okEmbed(`**#${id}** numaralı not silindi.`, '🗑️ Not Silindi')], flags: MessageFlags.Ephemeral,
        });
      }
      // liste
      const notes = userNotes.of(user.id);
      if (!notes.length) {
        return interaction.reply({
          embeds: [emptyEmbed('Not Yok', `${user} için kayıtlı bir yetkili notu bulunmuyor.`)],
          flags: MessageFlags.Ephemeral,
        });
      }
      const embed = baseEmbed(Colors.info)
        .setTitle(`📝 Yetkili Notları — ${codeText(user.tag, 40)}`)
        .setDescription(notes.map((n) =>
          `**#${n.id}** • ${discordTime(n.created_at, 'd')} • <@${n.author_id}>\n${clean(n.note, 200)}`)
          .join('\n\n'))
        .setFooter(brandFooter(`${userNotes.count(user.id)} not`));
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  },

  {
    tier: Tier.BMOD,
    data: new SlashCommandBuilder()
      .setName('lockdown')
      .setDescription('Acil durumda tüm metin kanallarını kilitler veya açar')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addSubcommand((s) => s.setName('başlat').setDescription('Tüm metin kanallarını yazıma kapatır')
        .addStringOption((o) => o.setName('sebep').setDescription('Lockdown sebebi').setRequired(true)))
      .addSubcommand((s) => s.setName('bitir').setDescription('Lockdown\'ı kaldırır (yalnız kilitlenen kanalları açar)')),
    async execute(interaction) {
      const sub = interaction.options.getSubcommand();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const everyone = interaction.guild.roles.everyone;

      if (sub === 'başlat') {
        const reason = interaction.options.getString('sebep', true);
        const already = JSON.parse(getSetting('lockdown_channels', '[]') || '[]');
        if (already.length) {
          return interaction.editReply({
            embeds: [errEmbed('Şu anda zaten aktif bir lockdown var. Önce `/lockdown bitir` ile kaldır.',
              'Lockdown Zaten Aktif')],
          });
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
          title: 'Lockdown Başlatıldı', color: Colors.danger,
          fields: [
            { name: 'Yetkili', value: `${interaction.user}`, inline: true },
            { name: 'Kilitlenen kanal', value: String(locked.length), inline: true },
            { name: 'Sebep', value: clean(reason), inline: false },
          ],
        });
        return interaction.editReply({
          embeds: [okEmbed(`**${locked.length}** metin kanalı yazıma kapatıldı.\n`
            + 'Kaldırmak için `/lockdown bitir` kullan — yalnız bu işlemde kilitlenen kanallar açılır.',
          '🔒 Lockdown Aktif')],
        });
      }

      // bitir
      const locked = JSON.parse(getSetting('lockdown_channels', '[]') || '[]');
      if (!locked.length) {
        return interaction.editReply({
          embeds: [errEmbed('Kaldırılacak aktif bir lockdown yok.', 'Lockdown Yok')],
        });
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
        title: 'Lockdown Bitti', color: Colors.success,
        fields: [
          { name: 'Yetkili', value: `${interaction.user}`, inline: true },
          { name: 'Açılan kanal', value: String(opened), inline: true },
        ],
      });
      return interaction.editReply({
        embeds: [okEmbed(`**${opened}** kanal yeniden yazıma açıldı.`, '🔓 Lockdown Kaldırıldı')],
      });
    },
  },
];
