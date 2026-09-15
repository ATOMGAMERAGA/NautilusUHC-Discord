import {
  SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, MessageFlags,
} from 'discord.js';
import { Tier } from '../permissions.js';
import {
  okEmbed, errEmbed, baseEmbed, brandFooter, Colors, Assets, Brand, bridgeErrorEmbed,
} from '../embeds.js';
import { getSetting, setSetting, addCase } from '../db.js';
import { config } from '../config.js';
import { clean, codeText } from '../util.js';
import { ranks, upsertRank, removeRank, resetRanks } from '../ranks.js';
import {
  TIER_ROLE_SPECS, ensureTierRoles, setTierRole, roleMap, syncMemberTierRole,
} from '../rolesync.js';
import {
  escalationConfig, setTimeoutThreshold, setBanThreshold, clearEscalation,
} from '../escalation.js';
import { raidSettings } from '../security/raid.js';
import { parseDuration, formatDuration } from '../util.js';
import { mcapi } from '../mcapi.js';
import { ticketPanelComponents } from '../tickets.js';
import { TICKET_TYPES } from '../ticketcore.js';

function parseColor(input) {
  if (!input) return Colors.brand;
  const hex = input.replace(/^#/, '');
  const value = Number.parseInt(hex, 16);
  return Number.isFinite(value) && hex.length === 6 ? value : Colors.main;
}

/** /admin elorank liste|ekle|sil|sıfırla|rolkur|rol|senkron */
async function handleEloRank(interaction, sub) {
  if (sub === 'liste') {
    const list = ranks();
    const map = roleMap();
    const lines = list.map((r, i) => {
      const upper = i === 0 ? '∞' : list[i - 1].min - 1;
      const roleId = map[r.name.toLowerCase()];
      return `${r.emoji ?? '🏅'} **${r.name}** — ${r.min} → ${upper} ELO`
        + (roleId ? ` • <@&${roleId}>` : '');
    });
    return interaction.reply({
      embeds: [baseEmbed(Colors.brand)
        .setTitle('🏆 ELO Rank Kademeleri')
        .setDescription(lines.join('\n'))
        .setFooter(brandFooter(`${list.length} kademe`))],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (sub === 'rolkur') {
    // Rolleri oluşturmak birkaç API çağrısı sürer — önce defer.
    await interaction.deferReply();
    const res = await ensureTierRoles(interaction.guild);
    if (!res.ok) {
      return interaction.editReply({ embeds: [errEmbed(res.error, 'Roller Hazırlanamadı')] });
    }
    addCase('elorank_roles', null, interaction.user.id, null,
      res.results.filter((r) => r.created).length + ' yeni rol');
    const lines = res.results.map((r) => `${r.created ? '🆕' : '♻️'} **${r.name}** → <@&${r.roleId}>`);
    return interaction.editReply({
      embeds: [baseEmbed(Colors.success)
        .setTitle('🎨 ELO Tier Rolleri Hazır')
        .setDescription(lines.join('\n'))
        .addFields({
          name: 'Sıradaki adım',
          value: 'Botun rolünü bu rollerin **üstüne** taşı, ardından '
            + '`/admin elorank senkron` ile bağlı hesaplara dağıt.',
        })
        .setFooter(brandFooter('🆕 yeni oluşturuldu • ♻️ mevcut rol kullanıldı'))],
    });
  }
  if (sub === 'rol') {
    const tierName = interaction.options.getString('isim', true);
    const role = interaction.options.getRole('rol', true);
    const me = interaction.guild.members.me;
    if (role.managed || role.position >= me.roles.highest.position) {
      return interaction.reply({
        embeds: [errEmbed(`${role} eşlenemiyor: yönetilen bir rol ya da botun rolünün üstünde.`,
          'Rol Eşlenemedi')],
        flags: MessageFlags.Ephemeral,
      });
    }
    setTierRole(tierName, role.id);
    addCase('elorank_role_map', null, interaction.user.id, null, `${tierName} → ${role.id}`);
    return interaction.reply({
      embeds: [okEmbed(`**${clean(tierName, 20)}** kademesindeki oyuncular artık ${role} rolünü alacak.`,
        '🎨 Tier Rolü Eşlendi')],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (sub === 'senkron') {
    if (!Object.keys(roleMap()).length) {
      return interaction.reply({
        embeds: [errEmbed('Tier rolleri henüz kurulmamış.\nÖnce `/admin elorank rolkur` komutunu çalıştır.',
          'Rol Eşlemesi Yok')],
        flags: MessageFlags.Ephemeral,
      });
    }
    await interaction.deferReply();
    // Plugin 1.2.2'de tier UUID üzerinden okunur (ad değişikliğinde yanlış rol verilmez).
    const { collectTierLinks } = await import('../rolesync.js');
    const collected = await collectTierLinks(mcapi);
    if (!collected.ok) {
      return interaction.editReply({ embeds: [bridgeErrorEmbed(collected.res, { context: 'bağlantı listesi' })] });
    }
    const { links } = collected;
    let synced = 0;
    let skipped = 0;
    let failed = 0;
    for (const link of links) {
      try {
        const r = await syncMemberTierRole(interaction.guild, link.discordId, link.tier,
          { actorId: interaction.user.id });
        if (!r.ok) skipped++;
        else if (r.changed) synced++;
        else skipped++;
      } catch {
        failed++;
      }
    }
    addCase('elorank_bulk_sync', null, interaction.user.id, null,
      `${synced} güncellendi / ${links.length} bağlantı`);
    return interaction.editReply({
      embeds: [okEmbed('Bağlı tüm hesapların tier rolleri güncel.', '🔄 Tier Senkronu Tamamlandı')
        .addFields(
          { name: 'Güncellenen', value: String(synced), inline: true },
          { name: 'Değişiklik gerekmeyen', value: String(skipped), inline: true },
          { name: 'Hata', value: String(failed), inline: true },
          { name: 'Toplam bağlantı', value: String(links.length), inline: true },
        )],
    });
  }
  if (sub === 'ekle') {
    const name = interaction.options.getString('isim', true).trim();
    const min = interaction.options.getInteger('min-elo', true);
    const emoji = interaction.options.getString('emoji')?.trim();
    const list = upsertRank(name, min, emoji);
    addCase('elorank_set', null, interaction.user.id, `${name} >= ${min}`);
    return interaction.reply({
      embeds: [okEmbed(`**${clean(name, 30)}** kademesi **${min} ELO** ve üzeri için geçerli. `
        + `Toplam ${list.length} kademe var.`, '🏅 Kademe Kaydedildi')],
      flags: MessageFlags.Ephemeral,
    });
  }
  if (sub === 'sil') {
    const name = interaction.options.getString('isim', true).trim();
    if (!removeRank(name)) {
      return interaction.reply({
        embeds: [errEmbed(`**${clean(name, 30)}** adında bir kademe bulunamadı. `
          + 'Son kalan kademe silinemez.', 'Kademe Silinemedi')],
        flags: MessageFlags.Ephemeral,
      });
    }
    addCase('elorank_del', null, interaction.user.id, name);
    return interaction.reply({
      embeds: [okEmbed(`**${clean(name, 30)}** kademesi listeden kaldırıldı.`, '🗑️ Kademe Silindi')],
      flags: MessageFlags.Ephemeral,
    });
  }
  // sıfırla
  resetRanks();
  addCase('elorank_reset', null, interaction.user.id, null);
  return interaction.reply({
    embeds: [okEmbed('Rank kademeleri fabrika ayarlarına döndü.', '🔄 Kademeler Sıfırlandı')],
    flags: MessageFlags.Ephemeral,
  });
}

/** /admin rolpanel — buttons that toggle safe roles. */
async function handleRolePanel(interaction) {
  const channel = interaction.options.getChannel('kanal', true);
  const roles = ['rol1', 'rol2', 'rol3', 'rol4', 'rol5']
    .map((k) => interaction.options.getRole(k))
    .filter(Boolean);
  const me = interaction.guild.members.me;

  for (const role of roles) {
    const dangerous = role.permissions.any([
      PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ModerateMembers,
    ]);
    if (role.managed || dangerous || role.position >= me.roles.highest.position) {
      return interaction.reply({
        embeds: [errEmbed(`${role} panele eklenemez: yetki taşıyan, yönetilen ya da botun rolünün `
          + 'üstünde bir rol.', 'Rol Panele Uygun Değil')],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  const title = interaction.options.getString('başlık') ?? '🎭 Rol Seçimi';
  const embed = baseEmbed(Colors.brand)
    .setTitle(clean(title, 200))
    .setDescription('İstediğin rolü almak için butona tıkla. Tekrar tıklayınca rol geri alınır.')
    .addFields({ name: 'Roller', value: roles.map((r) => `• ${r}`).join('\n') });
  const row = new ActionRowBuilder().addComponents(
    roles.map((r) => new ButtonBuilder()
      .setCustomId(`role:${r.id}`)
      .setLabel(r.name.slice(0, 80))
      .setStyle(ButtonStyle.Secondary)),
  );
  await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
  addCase('role_panel', null, interaction.user.id, null, `#${channel.name} (${roles.length} rol)`);
  return interaction.reply({
    embeds: [okEmbed(`${roles.length} rollük panel ${channel} kanalına gönderildi.`, '🎭 Rol Paneli Gönderildi')],
    flags: MessageFlags.Ephemeral,
  });
}

export default [
  {
    tier: Tier.ADMIN,
    data: new SlashCommandBuilder()
      .setName('admin')
      .setDescription('Bot ayarlarını ve panellerini yönetir')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((s) => s.setName('dclinkgönder')
        .setDescription('Hesap bağlama panelini link kanalına gönderir'))
      .addSubcommand((s) => s.setName('logkanal')
        .setDescription('Moderasyon/güvenlik log kanalını ayarlar')
        .addChannelOption((o) => o.setName('kanal').setDescription('Log kanalı')
          .addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand((s) => s.setName('mackanal')
        .setDescription('Maç duyurularının gönderileceği kanalı ayarlar')
        .addChannelOption((o) => o.setName('kanal').setDescription('Maç duyuru kanalı')
          .addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand((s) => s.setName('koruma')
        .setDescription('Sunucuyu yıkıcı işlemlere karşı koruyan sistemi yönetir')
        .addStringOption((o) => o.setName('durum').setDescription('Yapılacak işlem')
          .addChoices(
            { name: 'aç', value: 'on' },
            { name: 'kapat', value: 'off' },
            { name: 'durum', value: 'status' },
          ).setRequired(true)))
      .addSubcommand((s) => s.setName('automod')
        .setDescription('Sohbet filtresini (spam, davet linki, toplu etiket) açar veya kapatır')
        .addStringOption((o) => o.setName('durum').setDescription('Yapılacak işlem')
          .addChoices({ name: 'aç', value: 'on' }, { name: 'kapat', value: 'off' }).setRequired(true)))
      .addSubcommand((s) => s.setName('hoşgeldin')
        .setDescription('Hoş geldin mesajı kanalını ayarlar veya kapatır')
        .addChannelOption((o) => o.setName('kanal')
          .setDescription('Hoş geldin kanalı (boş bırak = kapat)').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('maçrol')
        .setDescription('Maç duyurularında etiketlenecek rolü ayarlar')
        .addRoleOption((o) => o.setName('rol').setDescription('Bildirim rolü (boş bırak = kapat)')))
      .addSubcommand((s) => s.setName('otorol')
        .setDescription('Sunucuya katılan herkese otomatik verilecek rolü ayarlar')
        .addRoleOption((o) => o.setName('rol').setDescription('Otorol (boş bırak = kapat)')))
      .addSubcommand((s) => s.setName('ticketpanel')
        .setDescription('Destek talebi panelini bir kanala gönderir')
        .addChannelOption((o) => o.setName('kanal').setDescription('Panel kanalı')
          .addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand((s) => s.setName('ticketkategori')
        .setDescription('Destek talebi kanallarının açılacağı kategoriyi ayarlar')
        .addChannelOption((o) => o.setName('kategori').setDescription('Kategori')
          .addChannelTypes(ChannelType.GuildCategory).setRequired(true))
        .addStringOption((o) => o.setName('tür').setDescription('Yalnız bu talep türü için (boş = genel varsayılan)')
          .addChoices(...Object.entries(TICKET_TYPES).map(([value, t]) => ({ name: t.label, value })))))
      .addSubcommand((s) => s.setName('destekmodu')
        .setDescription('Destek sistemini açar veya kapatır')
        .addStringOption((o) => o.setName('durum').setDescription('aç / kapat / durum')
          .addChoices(
            { name: 'aç', value: 'on' },
            { name: 'kapat', value: 'off' },
            { name: 'durum', value: 'status' },
          ).setRequired(true)))
      .addSubcommand((s) => s.setName('rolpanel')
        .setDescription('Butonla alınıp bırakılan rol paneli gönderir (en fazla 5 rol)')
        .addChannelOption((o) => o.setName('kanal').setDescription('Panel kanalı')
          .addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addRoleOption((o) => o.setName('rol1').setDescription('1. rol').setRequired(true))
        .addRoleOption((o) => o.setName('rol2').setDescription('2. rol'))
        .addRoleOption((o) => o.setName('rol3').setDescription('3. rol'))
        .addRoleOption((o) => o.setName('rol4').setDescription('4. rol'))
        .addRoleOption((o) => o.setName('rol5').setDescription('5. rol'))
        .addStringOption((o) => o.setName('başlık').setDescription('Panel başlığı')))
      .addSubcommand((s) => s.setName('staffkanal')
        .setDescription('Oyun içi rapor ve ceza bildirimlerinin kanalını ayarlar')
        .addChannelOption((o) => o.setName('kanal').setDescription('Staff kanalı (boş bırak = kapat)')
          .addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('rankkanal')
        .setDescription('ELO küme değişimi duyurularının kanalını ayarlar')
        .addChannelOption((o) => o.setName('kanal')
          .setDescription('Rank kanalı (boş bırak = maç kanalına düşer)')
          .addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('durumkanal')
        .setDescription('Canlı sunucu durum panosunun kanalını ayarlar')
        .addChannelOption((o) => o.setName('kanal')
          .setDescription('Durum kanalı (boş bırak = kapat)')
          .addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('uyarıeşiği')
        .setDescription('Uyarı sayısına bağlı otomatik yaptırım eşiklerini ayarlar')
        .addStringOption((o) => o.setName('tür').setDescription('Eşik türü').setRequired(true)
          .addChoices(
            { name: 'timeout (susturma)', value: 'timeout' },
            { name: 'ban', value: 'ban' },
            { name: 'kapat (tümü)', value: 'kapat' },
            { name: 'durum', value: 'durum' },
          ))
        .addIntegerOption((o) => o.setName('adet')
          .setDescription('Kaç uyarıda tetiklensin').setMinValue(1).setMaxValue(50))
        .addStringOption((o) => o.setName('süre')
          .setDescription('Susturma süresi, örn: 1sa, 1g')))
      .addSubcommand((s) => s.setName('raidkoruma')
        .setDescription('Toplu katılım korumasını yönetir')
        .addStringOption((o) => o.setName('durum').setDescription('aç / kapat / durum')
          .addChoices(
            { name: 'aç', value: 'on' },
            { name: 'kapat', value: 'off' },
            { name: 'durum', value: 'status' },
          ).setRequired(true))
        .addIntegerOption((o) => o.setName('katılım-limiti')
          .setDescription('Pencere içindeki katılım limiti (varsayılan 8)').setMinValue(2).setMaxValue(100))
        .addIntegerOption((o) => o.setName('pencere-sn')
          .setDescription('Katılım penceresi (saniye, varsayılan 30)').setMinValue(5).setMaxValue(600))
        .addIntegerOption((o) => o.setName('min-hesap-yaşı-gün')
          .setDescription('Minimum hesap yaşı (gün, 0 = kapalı)').setMinValue(0).setMaxValue(365))
        .addStringOption((o) => o.setName('aksiyon').setDescription('Raid modunda ne yapılsın')
          .addChoices({ name: 'kick (at)', value: 'kick' }, { name: 'log (yalnız kaydet)', value: 'log' })))
      .addSubcommandGroup((g) => g.setName('elorank')
        .setDescription('ELO rank kademelerini yönetir')
        .addSubcommand((s) => s.setName('liste').setDescription('Mevcut rank kademelerini listeler'))
        .addSubcommand((s) => s.setName('ekle').setDescription('Rank kademesi ekler veya günceller')
          .addStringOption((o) => o.setName('isim').setDescription('Rank adı (örn: Elmas)').setRequired(true))
          .addIntegerOption((o) => o.setName('min-elo').setDescription('Bu rank için alt ELO sınırı').setRequired(true))
          .addStringOption((o) => o.setName('emoji').setDescription('Rank emojisi (örn: 💎)')))
        .addSubcommand((s) => s.setName('sil').setDescription('Rank kademesini siler')
          .addStringOption((o) => o.setName('isim').setDescription('Silinecek rank adı').setRequired(true)))
        .addSubcommand((s) => s.setName('sıfırla').setDescription('Rank kademelerini varsayılana döndürür'))
        .addSubcommand((s) => s.setName('rolkur')
          .setDescription('Tier rollerini uygun renklerle oluşturur ve eşler'))
        .addSubcommand((s) => s.setName('rol')
          .setDescription('Bir tier kademesini mevcut bir role eşler')
          .addStringOption((o) => o.setName('isim').setDescription('Tier adı').setRequired(true)
            .addChoices(...TIER_ROLE_SPECS.map((t) => ({ name: t.name, value: t.name }))))
          .addRoleOption((o) => o.setName('rol').setDescription('Eşlenecek rol').setRequired(true)))
        .addSubcommand((s) => s.setName('senkron')
          .setDescription('Bağlı tüm hesapların tier rollerini toplu senkronlar'))),
    async execute(interaction) {
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();

      if (group === 'elorank') {
        return handleEloRank(interaction, sub);
      }

      if (sub === 'automod') {
        const enable = interaction.options.getString('durum', true) === 'on';
        setSetting('automod_enabled', enable ? '1' : '0');
        addCase('automod_toggle', null, interaction.user.id, enable ? 'açıldı' : 'kapatıldı');
        return interaction.reply({
          embeds: [enable
            ? okEmbed('Spam, davet linki ve toplu etiket filtresi tekrar çalışıyor.', '🤖 Automod Açıldı')
            : baseEmbed(Colors.warn).setTitle('⚠️ Automod Kapatıldı')
              .setDescription('Sohbet filtreleri devre dışı. `/admin automod aç` ile geri açabilirsin.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'hoşgeldin') {
        const channel = interaction.options.getChannel('kanal');
        setSetting('welcome_channel', channel ? channel.id : '');
        addCase('welcome_channel', null, interaction.user.id, null, channel?.id ?? 'kapalı');
        return interaction.reply({
          embeds: [okEmbed(channel
            ? `Yeni üyeler ${channel} kanalında karşılanacak.`
            : 'Yeni üyeler artık karşılama mesajı almayacak.',
          channel ? '👋 Karşılama Açıldı' : '👋 Karşılama Kapatıldı')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'maçrol') {
        const role = interaction.options.getRole('rol');
        setSetting('match_ping_role', role ? role.id : '');
        addCase('match_ping_role', null, interaction.user.id, null, role?.id ?? 'kapalı');
        return interaction.reply({
          embeds: [okEmbed(role
            ? `Maç planlandı ve maç başladı duyurularında ${role} etiketlenecek.\n`
              + 'Üyeler bu rolü `/admin rolpanel` ile kurduğun panelden alabilir.'
            : 'Maç duyurularında artık rol etiketlenmeyecek.',
          role ? '📣 Duyuru Rolü Ayarlandı' : '📣 Duyuru Rolü Kapatıldı')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'otorol') {
        const role = interaction.options.getRole('rol');
        setSetting('autorole_id', role ? role.id : 'off');
        addCase('autorole_id', null, interaction.user.id, null, role?.id ?? 'kapalı');
        return interaction.reply({
          embeds: [okEmbed(role
            ? `Sunucuya katılan her üyeye ${role} rolü otomatik verilecek.`
            : 'Yeni üyelere artık otomatik rol verilmeyecek.',
          role ? '🎟️ Otorol Açıldı' : '🎟️ Otorol Kapatıldı')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'staffkanal') {
        const channel = interaction.options.getChannel('kanal');
        setSetting('staff_channel', channel ? channel.id : '');
        addCase('staff_channel', null, interaction.user.id, null, channel?.id ?? 'kapalı');
        return interaction.reply({
          embeds: [okEmbed(channel
            ? `Oyun içi raporlar ve MC ceza aynaları ${channel} kanalına düşecek.`
            : 'Rapor ve ceza aynaları artık hiçbir kanala düşmeyecek.',
          channel ? '🛡️ Staff Kanalı Ayarlandı' : '🛡️ Staff Kanalı Kapatıldı')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'rankkanal') {
        const channel = interaction.options.getChannel('kanal');
        setSetting('rank_channel', channel ? channel.id : '');
        addCase('rank_channel', null, interaction.user.id, null, channel?.id ?? 'varsayılan');
        return interaction.reply({
          embeds: [okEmbed(channel
            ? `Küme atlama ve düşme duyuruları ${channel} kanalında yayınlanacak.`
            : 'Küme duyuruları yeniden maç kanalına düşecek.',
          '📈 Rank Kanalı Güncellendi')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'durumkanal') {
        const channel = interaction.options.getChannel('kanal');
        setSetting('status_channel', channel ? channel.id : '');
        setSetting('status_message_id', ''); // yeni kanal → pano mesajı yeniden kurulur
        addCase('status_channel', null, interaction.user.id, null, channel?.id ?? 'kapalı');
        return interaction.reply({
          embeds: [okEmbed(channel
            ? `Canlı durum panosu ${channel} kanalına kurulacak ve yaklaşık dakikada bir kendini güncelleyecek.`
            : 'Durum panosu kapatıldı; mevcut pano mesajı artık güncellenmeyecek.',
          channel ? '📊 Durum Panosu Açıldı' : '📊 Durum Panosu Kapatıldı')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'ticketkategori') {
        const category = interaction.options.getChannel('kategori', true);
        const tur = interaction.options.getString('tür');
        if (tur) {
          setSetting(`ticket_category_${tur}`, category.id);
          return interaction.reply({
            embeds: [okEmbed(`**${TICKET_TYPES[tur]?.label ?? tur}** talepleri artık `
              + `**${codeText(category.name, 60)}** kategorisinde açılacak.`, '🎫 Kategori Ayarlandı')],
            flags: MessageFlags.Ephemeral,
          });
        }
        setSetting('ticket_category', category.id);
        return interaction.reply({
          embeds: [okEmbed(`Tür bazlı ayarı olmayan tüm talepler **${codeText(category.name, 60)}** `
            + 'kategorisinde açılacak.', '🎫 Kategori Ayarlandı')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'destekmodu') {
        const durum = interaction.options.getString('durum', true);
        if (durum === 'status') {
          const on = getSetting('tickets_enabled', '1') === '1';
          return interaction.reply({
            embeds: [baseEmbed(on ? Colors.success : Colors.neutral)
              .setTitle(on ? '🎫 Destek Sistemi Açık' : '🎫 Destek Sistemi Kapalı')
              .setDescription(on
                ? 'Üyeler panel ve `/destek aç` üzerinden talep oluşturabiliyor.'
                : 'Panel ve komut üzerinden yeni talep açılamıyor. Açık talepler çalışmaya devam eder.')],
            flags: MessageFlags.Ephemeral,
          });
        }
        const enable = durum === 'on';
        setSetting('tickets_enabled', enable ? '1' : '0');
        addCase('tickets_toggle', null, interaction.user.id, null, enable ? 'açık' : 'kapalı');
        return interaction.reply({
          embeds: [okEmbed(enable
            ? 'Üyeler yeniden destek talebi açabilir.'
            : 'Yeni talep açılamayacak; açık talepler kapanana kadar çalışmaya devam eder.',
          enable ? '🎫 Destek Sistemi Açıldı' : '🎫 Destek Sistemi Kapatıldı')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'ticketpanel') {
        const channel = interaction.options.getChannel('kanal', true);
        const embed = baseEmbed(Colors.brand)
          .setTitle('🎫 Destek Talebi Aç')
          .setThumbnail(Assets.mark)
          .setDescription('Bir sorun mu yaşıyorsun? Aşağıdaki menüden konunu seç, açılan forma kısa bir '
            + 'açıklama yaz — sana özel bir destek kanalı açılır.')
          .addFields({
            name: 'Bilmen gerekenler',
            value: '• Talebini yalnızca sen ve yetkililer görebilir.\n'
              + '• Aynı anda bir açık talebin olabilir.\n'
              + '• Kapanışta konuşmanın kaydı sana DM olarak gönderilir.',
          });
        await channel.send({
          embeds: [embed], components: ticketPanelComponents(), allowedMentions: { parse: [] },
        });
        addCase('ticket_panel', null, interaction.user.id, null, `#${channel.name}`);
        return interaction.reply({
          embeds: [okEmbed(`Destek paneli ${channel} kanalına gönderildi.`, '🎫 Panel Gönderildi')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'rolpanel') {
        return handleRolePanel(interaction);
      }

      if (sub === 'dclinkgönder') {
        const channel = await interaction.client.channels.fetch(config.linkChannelId).catch(() => null);
        if (!channel?.isTextBased()) {
          return interaction.reply({
            embeds: [errEmbed(`<#${config.linkChannelId}> kanalına ulaşamıyorum. `
              + 'Kanal silinmiş olabilir ya da botun görme izni yok.', 'Kanala Ulaşılamadı')],
            flags: MessageFlags.Ephemeral,
          });
        }
        const embed = baseEmbed(Colors.brand)
          .setTitle('🔗 Minecraft Hesabını Bağla')
          .setThumbnail(Assets.item.enderPearl)
          .setImage(Assets.wordmarkScene)
          .setDescription(`Maçlara katılmak ve istatistik biriktirmek için hesabını bağlaman gerekiyor. `
            + 'İki dakikadan kısa sürer.')
          .addFields(
            {
              name: 'Üç adımda bağla',
              value: `**1.** \`${Brand.domain}\` sunucusuna gir ve sohbete \`/link\` yaz.\n`
                + '**2.** Sana verilen tek kullanımlık kodu kopyala.\n'
                + '**3.** Aşağıdaki **Hesap Bağla** butonuna tıklayıp kodu gir.',
            },
            {
              name: 'Zaten bağladıysan',
              value: '`/link` komutu hangi hesapla eşleştiğini gösterir. '
                + 'Bir yanlışlık varsa `/destek aç` ile talep oluşturabilirsin.',
            },
          );
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('link:open').setLabel('Hesap Bağla').setEmoji('🔗').setStyle(ButtonStyle.Primary),
        );
        await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
        addCase('link_panel', null, interaction.user.id, null, `#${channel.name}`);
        return interaction.reply({
          embeds: [okEmbed(`Hesap bağlama paneli ${channel} kanalına gönderildi.`, '🔗 Panel Gönderildi')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'logkanal') {
        const channel = interaction.options.getChannel('kanal', true);
        setSetting('log_channel', channel.id);
        addCase('log_channel', null, interaction.user.id, null, channel.id);
        return interaction.reply({
          embeds: [okEmbed(`Moderasyon ve güvenlik kayıtları ${channel} kanalına düşecek.`, '📋 Log Kanalı Ayarlandı')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'mackanal') {
        const channel = interaction.options.getChannel('kanal', true);
        setSetting('match_channel', channel.id);
        addCase('match_channel', null, interaction.user.id, null, channel.id);
        return interaction.reply({
          embeds: [okEmbed(`Maç planlama, başlangıç ve sonuç duyuruları ${channel} kanalında yayınlanacak.`,
            '⚔️ Maç Kanalı Ayarlandı')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'uyarıeşiği') {
        const tur = interaction.options.getString('tür', true);
        if (tur === 'durum') {
          const cfg = escalationConfig();
          const t = cfg.timeout?.count
            ? `${cfg.timeout.count} uyarı → ${formatDuration(cfg.timeout.durationMs || 3_600_000)} susturma`
            : 'Kapalı';
          const b = cfg.ban?.count ? `${cfg.ban.count} uyarı → ban` : 'Kapalı';
          return interaction.reply({
            embeds: [baseEmbed(Colors.brand).setTitle('⚙️ Otomatik Uyarı Yaptırımları')
              .setDescription('Bir kullanıcının toplam uyarısı eşiğe ulaştığında yaptırım kendiliğinden uygulanır.')
              .addFields(
                { name: 'Susturma eşiği', value: t, inline: true },
                { name: 'Ban eşiği', value: b, inline: true },
              )],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (tur === 'kapat') {
          clearEscalation();
          addCase('warn_threshold', null, interaction.user.id, null, 'kapatıldı');
          return interaction.reply({
            embeds: [okEmbed('Uyarı sayısına bağlı otomatik susturma ve ban devre dışı.',
              '⚙️ Otomatik Yaptırım Kapatıldı')],
            flags: MessageFlags.Ephemeral,
          });
        }
        const adet = interaction.options.getInteger('adet');
        if (!adet) {
          return interaction.reply({
            embeds: [errEmbed('Eşiği kurmak için `adet` seçeneğini de doldurman gerekiyor.', 'Eksik Bilgi')],
            flags: MessageFlags.Ephemeral,
          });
        }
        if (tur === 'timeout') {
          const rawSure = interaction.options.getString('süre');
          const durationMs = rawSure ? parseDuration(rawSure) : 3_600_000;
          if (!durationMs) {
            return interaction.reply({
              embeds: [errEmbed('Süreyi anlayamadım. Örnek: `1sa`, `1g`.', 'Geçersiz Süre')],
              flags: MessageFlags.Ephemeral,
            });
          }
          setTimeoutThreshold(adet, durationMs);
          addCase('warn_threshold', null, interaction.user.id, null, `timeout ${adet} → ${formatDuration(durationMs)}`);
          return interaction.reply({
            embeds: [okEmbed(`**${adet}** uyarıya ulaşan kullanıcı otomatik olarak `
              + `**${formatDuration(durationMs)}** susturulacak.`, '⏱️ Susturma Eşiği Ayarlandı')],
            flags: MessageFlags.Ephemeral,
          });
        }
        // ban
        setBanThreshold(adet);
        addCase('warn_threshold', null, interaction.user.id, null, `ban ${adet}`);
        return interaction.reply({
          embeds: [okEmbed(`**${adet}** uyarıya ulaşan kullanıcı otomatik olarak yasaklanacak.`,
            '🔨 Ban Eşiği Ayarlandı')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'raidkoruma') {
        const durum = interaction.options.getString('durum', true);
        if (durum === 'status') {
          const s = raidSettings();
          return interaction.reply({
            embeds: [baseEmbed(s.enabled ? Colors.success : Colors.neutral)
              .setTitle(s.enabled ? '🛡️ Raid Koruması Açık' : '🛡️ Raid Koruması Kapalı')
              .setDescription(s.enabled
                ? 'Toplu katılım algılandığında raid modu devreye girer.'
                : 'Katılım hızı ve hesap yaşı kontrolleri şu anda uygulanmıyor.')
              .addFields(
                { name: 'Katılım limiti', value: `${s.joinLimit} / ${s.windowSecs} sn`, inline: true },
                {
                  name: 'Min. hesap yaşı',
                  value: s.minAccountAgeDays === 0 ? 'Kapalı' : `${s.minAccountAgeDays} gün`,
                  inline: true,
                },
                {
                  name: 'Raid modunda',
                  value: s.action === 'kick' ? 'Yeni katılımlar atılır' : 'Yalnız kaydedilir',
                  inline: true,
                },
              )],
            flags: MessageFlags.Ephemeral,
          });
        }
        // Opsiyonel parametreler her durumda yazılır (verilmişse).
        const limit = interaction.options.getInteger('katılım-limiti');
        const windowSecs = interaction.options.getInteger('pencere-sn');
        const minAge = interaction.options.getInteger('min-hesap-yaşı-gün');
        const action = interaction.options.getString('aksiyon');
        if (limit != null) setSetting('raid_join_limit', String(limit));
        if (windowSecs != null) setSetting('raid_window_secs', String(windowSecs));
        if (minAge != null) setSetting('raid_min_account_age_days', String(minAge));
        if (action) setSetting('raid_action', action);
        const enable = durum === 'on';
        setSetting('raid_enabled', enable ? '1' : '0');
        addCase('raid_toggle', null, interaction.user.id, null, enable ? 'açıldı' : 'kapatıldı');
        const s = raidSettings();
        return interaction.reply({
          embeds: [okEmbed(enable
            ? 'Toplu katılım algılandığında raid modu devreye girecek.'
            : 'Katılım hızı ve hesap yaşı kontrolleri devre dışı.',
          enable ? '🛡️ Raid Koruması Açıldı' : '🛡️ Raid Koruması Kapatıldı')
            .addFields(
              { name: 'Katılım limiti', value: `${s.joinLimit} / ${s.windowSecs} sn`, inline: true },
              {
                name: 'Min. hesap yaşı',
                value: s.minAccountAgeDays === 0 ? 'Kapalı' : `${s.minAccountAgeDays} gün`,
                inline: true,
              },
              {
                name: 'Raid modunda',
                value: s.action === 'kick' ? 'Yeni katılımlar atılır' : 'Yalnız kaydedilir',
                inline: true,
              },
            )],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'koruma') {
        const mode = interaction.options.getString('durum', true);
        if (mode === 'status') {
          const enabled = getSetting('guard_enabled', '1') === '1';
          return interaction.reply({
            embeds: [baseEmbed(enabled ? Colors.success : Colors.neutral)
              .setTitle(enabled ? '🛡️ Patlama Koruması Açık' : '🛡️ Patlama Koruması Kapalı')
              .setDescription(enabled
                ? 'Sunucuyu yıkıcı işlemlere karşı izliyorum.'
                : 'Yıkıcı işlemler şu anda izlenmiyor. `/admin koruma aç` ile geri açabilirsin.')
              .addFields({
                name: 'Nasıl çalışır',
                value: 'Kısa sürede toplu kanal/rol silme, toplu ban veya kick, webhook oluşturma ve '
                  + 'izinsiz bot ekleme girişimlerinde failin tüm rolleri alınır ve olay log kanalına düşer. '
                  + 'Kurucu bu kontrolden muaftır.',
              })],
            flags: MessageFlags.Ephemeral,
          });
        }
        const enable = mode === 'on';
        setSetting('guard_enabled', enable ? '1' : '0');
        addCase('guard_toggle', null, interaction.user.id, enable ? 'açıldı' : 'kapatıldı');
        return interaction.reply({
          embeds: [enable
            ? okEmbed('Yıkıcı işlemler yeniden izleniyor.', '🛡️ Patlama Koruması Açıldı')
            : baseEmbed(Colors.warn).setTitle('⚠️ Patlama Koruması Kapatıldı')
              .setDescription('Sunucu artık toplu silme ve yetki suistimaline karşı korunmuyor.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      return interaction.reply({
        embeds: [errEmbed('Bu alt komut tanınmıyor.', 'Bilinmeyen Komut')], flags: MessageFlags.Ephemeral,
      });
    },
  },

  {
    tier: Tier.ADMIN,
    data: new SlashCommandBuilder()
      .setName('duyuru')
      .setDescription('Bot adına bir kanala duyuru gönderir')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption((o) => o.setName('kanal').setDescription('Hedef kanal')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
      .addStringOption((o) => o.setName('mesaj').setDescription('Gönderilecek mesaj').setRequired(true))
      .addBooleanOption((o) => o.setName('embed').setDescription('Embed olarak gönderilsin mi (varsayılan: hayır)'))
      .addStringOption((o) => o.setName('başlık').setDescription('Embed başlığı'))
      .addStringOption((o) => o.setName('renk').setDescription('Embed rengi (hex, örn: #00b3b3)')),
    async execute(interaction) {
      const channel = interaction.options.getChannel('kanal', true);
      const message = interaction.options.getString('mesaj', true).replace(/\\n/g, '\n');
      const asEmbed = interaction.options.getBoolean('embed') ?? false;

      if (asEmbed) {
        const embed = baseEmbed(parseColor(interaction.options.getString('renk')))
          .setDescription(message);
        const title = interaction.options.getString('başlık');
        if (title) embed.setTitle(title);
        await channel.send({ embeds: [embed] });
      } else {
        await channel.send({ content: message, allowedMentions: { parse: ['users', 'roles'] } });
      }
      addCase('announce', null, interaction.user.id, null, `#${channel.name}`);
      return interaction.reply({
        embeds: [okEmbed(`Duyurun ${channel} kanalında yayında.`, '📣 Duyuru Gönderildi')],
        flags: MessageFlags.Ephemeral,
      });
    },
  },

  {
    tier: Tier.ADMIN,
    data: new SlashCommandBuilder()
      .setName('embed')
      .setDescription('Bot adına özel bir embed kartı gönderir')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption((o) => o.setName('kanal').setDescription('Hedef kanal')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
      .addStringOption((o) => o.setName('başlık').setDescription('Embed başlığı').setRequired(true))
      .addStringOption((o) => o.setName('açıklama').setDescription('Embed açıklaması (\\n = satır sonu)').setRequired(true))
      .addStringOption((o) => o.setName('renk').setDescription('Hex renk (örn: #e74c3c)'))
      .addStringOption((o) => o.setName('resim').setDescription('Büyük resim URL'))
      .addStringOption((o) => o.setName('küçük-resim').setDescription('Küçük resim (thumbnail) URL'))
      .addStringOption((o) => o.setName('alt-yazı').setDescription('Footer yazısı')),
    async execute(interaction) {
      const channel = interaction.options.getChannel('kanal', true);
      const embed = baseEmbed(parseColor(interaction.options.getString('renk')))
        .setTitle(interaction.options.getString('başlık', true))
        .setDescription(interaction.options.getString('açıklama', true).replace(/\\n/g, '\n'));
      const image = interaction.options.getString('resim');
      const thumb = interaction.options.getString('küçük-resim');
      const footer = interaction.options.getString('alt-yazı');
      if (image) embed.setImage(image);
      if (thumb) embed.setThumbnail(thumb);
      if (footer) embed.setFooter({ text: footer });
      try {
        await channel.send({ embeds: [embed] });
      } catch (err) {
        console.error('[admin] embed gönderilemedi:', err.message);
        return interaction.reply({
          embeds: [errEmbed('Embed gönderilemedi. Görsel bağlantılarının geçerli olduğundan ve botun '
            + `${channel} kanalına yazma izni olduğundan emin ol.`, 'Embed Gönderilemedi')],
          flags: MessageFlags.Ephemeral,
        });
      }
      addCase('embed', null, interaction.user.id, null, `#${channel.name}`);
      return interaction.reply({
        embeds: [okEmbed(`Embed ${channel} kanalında yayında.`, '📨 Embed Gönderildi')],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];
