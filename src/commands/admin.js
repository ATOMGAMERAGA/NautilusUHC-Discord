import {
  SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType,
} from 'discord.js';
import { Tier } from '../permissions.js';
import { okEmbed, errEmbed, baseEmbed, Colors, Assets } from '../embeds.js';
import { getSetting, setSetting, addCase } from '../db.js';
import { config } from '../config.js';
import { clean } from '../util.js';
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
  if (!input) return Colors.main;
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
      embeds: [baseEmbed(Colors.main).setTitle('🏆 ELO Rank Kademeleri').setDescription(lines.join('\n'))],
    });
  }
  if (sub === 'rolkur') {
    // Rolleri oluşturmak birkaç API çağrısı sürer — önce defer.
    await interaction.deferReply();
    const res = await ensureTierRoles(interaction.guild);
    if (!res.ok) {
      return interaction.editReply({ embeds: [errEmbed(res.error)] });
    }
    addCase('elorank_roles', null, interaction.user.id, null,
      res.results.filter((r) => r.created).length + ' yeni rol');
    const lines = res.results.map((r) => `${r.created ? '🆕' : '♻️'} **${r.name}** → <@&${r.roleId}>`);
    return interaction.editReply({
      embeds: [baseEmbed(Colors.success)
        .setTitle('🎨 ELO Tier Rolleri Hazır')
        .setDescription(lines.join('\n')
          + '\n\n🆕 = yeni oluşturuldu, ♻️ = mevcut rol kullanıldı. '
          + 'Rol renkleri tier kimliğine göre ayarlandı. '
          + 'Botun rolünün bu rollerin **üstünde** olduğundan emin ol; '
          + 'ardından `/admin elorank senkron` ile herkese dağıt.')],
    });
  }
  if (sub === 'rol') {
    const tierName = interaction.options.getString('isim', true);
    const role = interaction.options.getRole('rol', true);
    const me = interaction.guild.members.me;
    if (role.managed || role.position >= me.roles.highest.position) {
      return interaction.reply({
        embeds: [errEmbed(`${role} eşlenemez: yönetilen rol ya da botun rolünün üstünde.`)],
        ephemeral: true,
      });
    }
    setTierRole(tierName, role.id);
    addCase('elorank_role_map', null, interaction.user.id, null, `${tierName} → ${role.id}`);
    return interaction.reply({
      embeds: [okEmbed(`🎨 **${clean(tierName, 20)}** kademesi ${role} rolüne eşlendi.`)],
    });
  }
  if (sub === 'senkron') {
    if (!Object.keys(roleMap()).length) {
      return interaction.reply({
        embeds: [errEmbed('Önce `/admin elorank rolkur` ile tier rollerini kur.')],
        ephemeral: true,
      });
    }
    await interaction.deferReply();
    const res = await mcapi.links();
    if (!res.ok) {
      return interaction.editReply({ embeds: [errEmbed(`❌ ${res.error}`)] });
    }
    const links = (res.links ?? []).filter((l) => l.discordId && l.tier);
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
      embeds: [okEmbed(`🔄 Toplu tier rol senkronu bitti.\n`
        + `• Güncellenen: **${synced}**\n`
        + `• Değişiklik gerekmeyen/atlanan: **${skipped}**\n`
        + `• Hata: **${failed}**\n`
        + `• Toplam bağlantı: **${links.length}**`)],
    });
  }
  if (sub === 'ekle') {
    const name = interaction.options.getString('isim', true).trim();
    const min = interaction.options.getInteger('min-elo', true);
    const emoji = interaction.options.getString('emoji')?.trim();
    const list = upsertRank(name, min, emoji);
    addCase('elorank_set', null, interaction.user.id, `${name} >= ${min}`);
    return interaction.reply({
      embeds: [okEmbed(`🏅 **${clean(name, 30)}** kademesi ayarlandı (min ${min} ELO). Toplam ${list.length} kademe.`)],
    });
  }
  if (sub === 'sil') {
    const name = interaction.options.getString('isim', true).trim();
    if (!removeRank(name)) {
      return interaction.reply({
        embeds: [errEmbed(`**${clean(name, 30)}** adında bir kademe yok (veya son kademe silinemez).`)],
        ephemeral: true,
      });
    }
    addCase('elorank_del', null, interaction.user.id, name);
    return interaction.reply({ embeds: [okEmbed(`🗑️ **${clean(name, 30)}** kademesi silindi.`)] });
  }
  // sıfırla
  resetRanks();
  addCase('elorank_reset', null, interaction.user.id, null);
  return interaction.reply({ embeds: [okEmbed('🔄 Rank kademeleri varsayılana döndürüldü.')] });
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
        embeds: [errEmbed(`${role} paneli için uygun değil (yönetilen/yetkili rol ya da botun üstünde).`)],
        ephemeral: true,
      });
    }
  }

  const title = interaction.options.getString('başlık') ?? '🎭 Rol Seçimi';
  const embed = baseEmbed(Colors.main)
    .setTitle(clean(title, 200))
    .setDescription('Aşağıdaki butonlara tıklayarak rolleri alabilir veya bırakabilirsin:\n\n'
      + roles.map((r) => `• ${r}`).join('\n'));
  const row = new ActionRowBuilder().addComponents(
    roles.map((r) => new ButtonBuilder()
      .setCustomId(`role:${r.id}`)
      .setLabel(r.name.slice(0, 80))
      .setStyle(ButtonStyle.Secondary)),
  );
  await channel.send({ embeds: [embed], components: [row] });
  addCase('role_panel', null, interaction.user.id, null, `#${channel.name} (${roles.length} rol)`);
  return interaction.reply({ embeds: [okEmbed(`🎭 Rol paneli ${channel} kanalına gönderildi.`)], ephemeral: true });
}

export default [
  {
    tier: Tier.ADMIN,
    data: new SlashCommandBuilder()
      .setName('admin')
      .setDescription('Bot yönetim komutları')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((s) => s.setName('dclinkgönder')
        .setDescription('Hesap bağlama panelini link kanalına gönderir'))
      .addSubcommand((s) => s.setName('logkanal')
        .setDescription('Moderasyon/güvenlik log kanalını ayarlar')
        .addChannelOption((o) => o.setName('kanal').setDescription('Log kanalı')
          .addChannelTypes(ChannelType.GuildText).setRequired(true)))
      .addSubcommand((s) => s.setName('koruma')
        .setDescription('Patlama korumasını (anti-nuke) yönetir')
        .addStringOption((o) => o.setName('durum').setDescription('aç / kapat / durum')
          .addChoices(
            { name: 'aç', value: 'on' },
            { name: 'kapat', value: 'off' },
            { name: 'durum', value: 'status' },
          ).setRequired(true)))
      .addSubcommand((s) => s.setName('automod')
        .setDescription('Automod\'u (spam/davet/etiket filtresi) açar veya kapatır')
        .addStringOption((o) => o.setName('durum').setDescription('aç / kapat')
          .addChoices({ name: 'aç', value: 'on' }, { name: 'kapat', value: 'off' }).setRequired(true)))
      .addSubcommand((s) => s.setName('hoşgeldin')
        .setDescription('Hoş geldin mesajı kanalını ayarlar veya kapatır')
        .addChannelOption((o) => o.setName('kanal')
          .setDescription('Hoş geldin kanalı (boş bırak = kapat)').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('maçrol')
        .setDescription('Maç duyurularında etiketlenecek rolü ayarlar')
        .addRoleOption((o) => o.setName('rol').setDescription('Bildirim rolü (boş bırak = kapat)')))
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
        .setDescription('Destek (ticket) sistemini açar veya kapatır')
        .addStringOption((o) => o.setName('durum').setDescription('aç / kapat / durum')
          .addChoices(
            { name: 'aç', value: 'on' },
            { name: 'kapat', value: 'off' },
            { name: 'durum', value: 'status' },
          ).setRequired(true)))
      .addSubcommand((s) => s.setName('rolpanel')
        .setDescription('Buton ile alınıp bırakılabilen rol paneli gönderir (en fazla 5 rol)')
        .addChannelOption((o) => o.setName('kanal').setDescription('Panel kanalı')
          .addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addRoleOption((o) => o.setName('rol1').setDescription('1. rol').setRequired(true))
        .addRoleOption((o) => o.setName('rol2').setDescription('2. rol'))
        .addRoleOption((o) => o.setName('rol3').setDescription('3. rol'))
        .addRoleOption((o) => o.setName('rol4').setDescription('4. rol'))
        .addRoleOption((o) => o.setName('rol5').setDescription('5. rol'))
        .addStringOption((o) => o.setName('başlık').setDescription('Panel başlığı')))
      .addSubcommand((s) => s.setName('staffkanal')
        .setDescription('Rapor/ceza aynası eventlerinin düşeceği staff kanalını ayarlar')
        .addChannelOption((o) => o.setName('kanal').setDescription('Staff kanalı (boş bırak = kapat)')
          .addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('rankkanal')
        .setDescription('ELO küme değişimi duyurularının kanalını ayarlar')
        .addChannelOption((o) => o.setName('kanal')
          .setDescription('Rank kanalı (boş bırak = maç kanalına düşer)')
          .addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('durumkanal')
        .setDescription('Oto-güncellenen sunucu durum panosunun kanalını ayarlar')
        .addChannelOption((o) => o.setName('kanal')
          .setDescription('Durum kanalı (boş bırak = kapat)')
          .addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('uyarıeşiği')
        .setDescription('Uyarı sayısına göre otomatik yaptırım eşiklerini ayarlar')
        .addStringOption((o) => o.setName('tür').setDescription('Eşik türü').setRequired(true)
          .addChoices(
            { name: 'timeout (susturma)', value: 'timeout' },
            { name: 'ban', value: 'ban' },
            { name: 'kapat (tümü)', value: 'kapat' },
            { name: 'durum', value: 'durum' },
          ))
        .addIntegerOption((o) => o.setName('adet')
          .setDescription('Kaç uyarıda tetiklensin (timeout/ban için)').setMinValue(1).setMaxValue(50))
        .addStringOption((o) => o.setName('süre')
          .setDescription('timeout süresi (örn. 1sa, 1g) — yalnız timeout türünde')))
      .addSubcommand((s) => s.setName('raidkoruma')
        .setDescription('Raid korumasını (katılım hızı + min hesap yaşı) yönetir')
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
        .addSubcommand((s) => s.setName('ekle').setDescription('Rank kademesi ekler/günceller')
          .addStringOption((o) => o.setName('isim').setDescription('Rank adı (örn. Elmas)').setRequired(true))
          .addIntegerOption((o) => o.setName('min-elo').setDescription('Bu rank için alt ELO sınırı').setRequired(true))
          .addStringOption((o) => o.setName('emoji').setDescription('Rank emojisi (örn. 💎)')))
        .addSubcommand((s) => s.setName('sil').setDescription('Rank kademesini siler')
          .addStringOption((o) => o.setName('isim').setDescription('Silinecek rank adı').setRequired(true)))
        .addSubcommand((s) => s.setName('sıfırla').setDescription('Rank kademelerini varsayılana döndürür'))
        .addSubcommand((s) => s.setName('rolkur')
          .setDescription('6 tier rolünü uygun renklerle otomatik oluşturur/eşler'))
        .addSubcommand((s) => s.setName('rol')
          .setDescription('Bir tier\'ı mevcut bir Discord rolüne elle eşler')
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
          embeds: [okEmbed(enable ? '🤖 Automod **açıldı**.' : '⚠️ Automod **kapatıldı**.')],
        });
      }

      if (sub === 'hoşgeldin') {
        const channel = interaction.options.getChannel('kanal');
        setSetting('welcome_channel', channel ? channel.id : '');
        addCase('welcome_channel', null, interaction.user.id, null, channel?.id ?? 'kapalı');
        return interaction.reply({
          embeds: [okEmbed(channel
            ? `👋 Hoş geldin mesajları ${channel} kanalına gönderilecek.`
            : '👋 Hoş geldin mesajları kapatıldı.')],
        });
      }

      if (sub === 'maçrol') {
        const role = interaction.options.getRole('rol');
        setSetting('match_ping_role', role ? role.id : '');
        addCase('match_ping_role', null, interaction.user.id, null, role?.id ?? 'kapalı');
        return interaction.reply({
          embeds: [okEmbed(role
            ? `📣 Maç duyurularında ${role} etiketlenecek. (Rolü rol panelinden aldırabilirsin.)`
            : '📣 Maç duyuru etiketi kapatıldı.')],
        });
      }

      if (sub === 'staffkanal') {
        const channel = interaction.options.getChannel('kanal');
        setSetting('staff_channel', channel ? channel.id : '');
        addCase('staff_channel', null, interaction.user.id, null, channel?.id ?? 'kapalı');
        return interaction.reply({
          embeds: [okEmbed(channel
            ? `🛡️ Oyun içi raporlar ve ceza aynaları ${channel} kanalına düşecek.`
            : '🛡️ Staff event kanalı kapatıldı — rapor/ceza eventleri duyurulmayacak.')],
        });
      }

      if (sub === 'rankkanal') {
        const channel = interaction.options.getChannel('kanal');
        setSetting('rank_channel', channel ? channel.id : '');
        addCase('rank_channel', null, interaction.user.id, null, channel?.id ?? 'varsayılan');
        return interaction.reply({
          embeds: [okEmbed(channel
            ? `📈 ELO küme değişimleri ${channel} kanalında duyurulacak.`
            : '📈 Rank kanalı ayarı kaldırıldı — duyurular maç kanalına düşer.')],
        });
      }

      if (sub === 'durumkanal') {
        const channel = interaction.options.getChannel('kanal');
        setSetting('status_channel', channel ? channel.id : '');
        setSetting('status_message_id', ''); // yeni kanal → pano mesajı yeniden kurulur
        addCase('status_channel', null, interaction.user.id, null, channel?.id ?? 'kapalı');
        return interaction.reply({
          embeds: [okEmbed(channel
            ? `📊 Durum panosu ${channel} kanalında ~60 sn'de bir güncellenecek.`
            : '📊 Durum panosu kapatıldı.')],
        });
      }

      if (sub === 'ticketkategori') {
        const category = interaction.options.getChannel('kategori', true);
        const tur = interaction.options.getString('tür');
        if (tur) {
          setSetting(`ticket_category_${tur}`, category.id);
          return interaction.reply({
            embeds: [okEmbed(`🎫 **${TICKET_TYPES[tur]?.label ?? tur}** talepleri **${category.name}** kategorisinde açılacak.`)],
          });
        }
        setSetting('ticket_category', category.id);
        return interaction.reply({ embeds: [okEmbed(`🎫 Destek talepleri **${category.name}** kategorisinde açılacak.`)] });
      }

      if (sub === 'destekmodu') {
        const durum = interaction.options.getString('durum', true);
        if (durum === 'status') {
          const on = getSetting('tickets_enabled', '1') === '1';
          return interaction.reply({
            embeds: [baseEmbed(on ? Colors.success : Colors.danger)
              .setTitle('🎫 Destek Sistemi')
              .setDescription(`Durum: **${on ? 'AÇIK' : 'KAPALI'}**`)],
            ephemeral: true,
          });
        }
        const enable = durum === 'on';
        setSetting('tickets_enabled', enable ? '1' : '0');
        addCase('tickets_toggle', null, interaction.user.id, null, enable ? 'açık' : 'kapalı');
        return interaction.reply({
          embeds: [okEmbed(enable
            ? '🎫 Destek sistemi **açıldı** — panel ve komutlar tekrar kullanılabilir.'
            : '🎫 Destek sistemi **kapatıldı** — panel etkileşimleri reddedilecek.')],
        });
      }

      if (sub === 'ticketpanel') {
        const channel = interaction.options.getChannel('kanal', true);
        const embed = baseEmbed(Colors.main)
          .setTitle('🎫 Destek Talebi')
          .setDescription('Bir sorunun mu var? Aşağıdaki menüden **konuya uygun türü seç**, açılan forma '
            + 'konu ve açıklamanı yaz — sana özel bir destek kanalı açılır.\n\n'
            + 'Talebini yalnızca sen ve yetkililer görebilir.');
        await channel.send({ embeds: [embed], components: ticketPanelComponents() });
        addCase('ticket_panel', null, interaction.user.id, null, `#${channel.name}`);
        return interaction.reply({ embeds: [okEmbed(`✅ Destek paneli ${channel} kanalına gönderildi.`)], ephemeral: true });
      }

      if (sub === 'rolpanel') {
        return handleRolePanel(interaction);
      }

      if (sub === 'dclinkgönder') {
        const channel = await interaction.client.channels.fetch(config.linkChannelId).catch(() => null);
        if (!channel?.isTextBased()) {
          return interaction.reply({ embeds: [errEmbed(`Link kanalına ulaşamıyorum (<#${config.linkChannelId}>).`)], ephemeral: true });
        }
        const embed = baseEmbed(Colors.main)
          .setTitle('🔗 Minecraft Hesabını Bağla')
          .setThumbnail(Assets.item.enderPearl)
          .setImage(Assets.wordmarkScene)
          .setDescription(
            'Nautilus PvP maçlarına katılmak için Minecraft hesabını Discord hesabına bağlaman **zorunludur**.\n\n'
            + '**Nasıl yapılır?**\n'
            + '1️⃣ `nautilusuhc.com` sunucusuna gir.\n'
            + '2️⃣ Sohbete `/link` yaz — sana tek kullanımlık bir kod verilecek.\n'
            + '3️⃣ Aşağıdaki **Hesap Bağla** butonuna tıkla ve kodu gir.\n\n'
            + 'Zaten bağlıysan `/link` komutu sana hangi hesapla bağlı olduğunu söyler. '
            + 'Bir yanlışlık olduğunu düşünüyorsan destek talebi aç.');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('link:open').setLabel('Hesap Bağla').setEmoji('🔗').setStyle(ButtonStyle.Primary),
        );
        await channel.send({ embeds: [embed], components: [row] });
        addCase('link_panel', null, interaction.user.id, null, `#${channel.name}`);
        return interaction.reply({ embeds: [okEmbed(`✅ Bağlantı paneli ${channel} kanalına gönderildi.`)], ephemeral: true });
      }

      if (sub === 'logkanal') {
        const channel = interaction.options.getChannel('kanal', true);
        setSetting('log_channel', channel.id);
        addCase('log_channel', null, interaction.user.id, null, channel.id);
        return interaction.reply({ embeds: [okEmbed(`📋 Log kanalı ${channel} olarak ayarlandı.`)] });
      }

      if (sub === 'uyarıeşiği') {
        const tur = interaction.options.getString('tür', true);
        if (tur === 'durum') {
          const cfg = escalationConfig();
          const t = cfg.timeout?.count
            ? `${cfg.timeout.count} uyarı → ${formatDuration(cfg.timeout.durationMs || 3_600_000)} timeout`
            : 'kapalı';
          const b = cfg.ban?.count ? `${cfg.ban.count} uyarı → ban` : 'kapalı';
          return interaction.reply({
            embeds: [baseEmbed(Colors.main).setTitle('⚙️ Uyarı Eşikleri')
              .setDescription(`⏱️ **Timeout:** ${t}\n🔨 **Ban:** ${b}`)],
            ephemeral: true,
          });
        }
        if (tur === 'kapat') {
          clearEscalation();
          addCase('warn_threshold', null, interaction.user.id, null, 'kapatıldı');
          return interaction.reply({ embeds: [okEmbed('⚙️ Otomatik uyarı yaptırımları kapatıldı.')] });
        }
        const adet = interaction.options.getInteger('adet');
        if (!adet) {
          return interaction.reply({ embeds: [errEmbed('Eşik için `adet` gerekli.')], ephemeral: true });
        }
        if (tur === 'timeout') {
          const rawSure = interaction.options.getString('süre');
          const durationMs = rawSure ? parseDuration(rawSure) : 3_600_000;
          if (!durationMs) {
            return interaction.reply({ embeds: [errEmbed('Süre anlaşılamadı. Örnek: `1sa`, `1g`.')], ephemeral: true });
          }
          setTimeoutThreshold(adet, durationMs);
          addCase('warn_threshold', null, interaction.user.id, null, `timeout ${adet} → ${formatDuration(durationMs)}`);
          return interaction.reply({
            embeds: [okEmbed(`⏱️ **${adet}** uyarıya ulaşan kullanıcı otomatik **${formatDuration(durationMs)}** susturulacak.`)],
          });
        }
        // ban
        setBanThreshold(adet);
        addCase('warn_threshold', null, interaction.user.id, null, `ban ${adet}`);
        return interaction.reply({
          embeds: [okEmbed(`🔨 **${adet}** uyarıya ulaşan kullanıcı otomatik yasaklanacak.`)],
        });
      }

      if (sub === 'raidkoruma') {
        const durum = interaction.options.getString('durum', true);
        if (durum === 'status') {
          const s = raidSettings();
          return interaction.reply({
            embeds: [baseEmbed(s.enabled ? Colors.success : Colors.danger)
              .setTitle('🛡️ Raid Koruması')
              .setDescription(`Durum: **${s.enabled ? 'AÇIK' : 'KAPALI'}**\n`
                + `• Katılım limiti: **${s.joinLimit}** / **${s.windowSecs}** sn\n`
                + `• Min. hesap yaşı: **${s.minAccountAgeDays === 0 ? 'kapalı' : `${s.minAccountAgeDays} gün`}**\n`
                + `• Raid modu aksiyonu: **${s.action === 'kick' ? 'at (kick)' : 'yalnız logla'}**`)],
            ephemeral: true,
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
          embeds: [okEmbed(`🛡️ Raid koruması **${enable ? 'açıldı' : 'kapatıldı'}**.\n`
            + `• Katılım: ${s.joinLimit}/${s.windowSecs}sn • Min. yaş: `
            + `${s.minAccountAgeDays === 0 ? 'kapalı' : `${s.minAccountAgeDays}g`} • Aksiyon: ${s.action}`)],
        });
      }

      if (sub === 'koruma') {
        const mode = interaction.options.getString('durum', true);
        if (mode === 'status') {
          const enabled = getSetting('guard_enabled', '1') === '1';
          return interaction.reply({
            embeds: [baseEmbed(enabled ? Colors.success : Colors.danger)
              .setTitle('🛡️ Patlama Koruması')
              .setDescription(`Durum: **${enabled ? 'AÇIK' : 'KAPALI'}**\n\n`
                + 'Kısa sürede toplu kanal/rol silme, toplu ban/kick, webhook oluşturma ve bot ekleme '
                + 'girişimlerinde failin tüm rolleri alınır ve olay loglanır. Kurucu muaftır.')],
          });
        }
        const enable = mode === 'on';
        setSetting('guard_enabled', enable ? '1' : '0');
        addCase('guard_toggle', null, interaction.user.id, enable ? 'açıldı' : 'kapatıldı');
        return interaction.reply({
          embeds: [okEmbed(enable ? '🛡️ Patlama koruması **açıldı**.' : '⚠️ Patlama koruması **kapatıldı**.')],
        });
      }

      return interaction.reply({ embeds: [errEmbed('Bilinmeyen alt komut.')], ephemeral: true });
    },
  },

  {
    tier: Tier.ADMIN,
    data: new SlashCommandBuilder()
      .setName('duyuru')
      .setDescription('Bot üzerinden bir kanala mesaj gönderir')
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
      return interaction.reply({ embeds: [okEmbed(`📣 Mesaj ${channel} kanalına gönderildi.`)], ephemeral: true });
    },
  },

  {
    tier: Tier.ADMIN,
    data: new SlashCommandBuilder()
      .setName('embed')
      .setDescription('Bot üzerinden detaylı bir embed mesajı gönderir')
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
        return interaction.reply({ embeds: [errEmbed(`Embed gönderilemedi: ${clean(err.message, 100)}`)], ephemeral: true });
      }
      addCase('embed', null, interaction.user.id, null, `#${channel.name}`);
      return interaction.reply({ embeds: [okEmbed(`📨 Embed ${channel} kanalına gönderildi.`)], ephemeral: true });
    },
  },
];
