import { SlashCommandBuilder, ChannelType } from 'discord.js';
import { Tier, tierOf, tierName } from '../permissions.js';
import { baseEmbed, Colors } from '../embeds.js';
import { discordTime } from '../util.js';

export default [
  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder().setName('ping').setDescription('Botun gecikmesini gösterir'),
    async execute(interaction) {
      const sent = await interaction.reply({ content: '🏓 Ölçülüyor…', fetchReply: true });
      const rtt = sent.createdTimestamp - interaction.createdTimestamp;
      await interaction.editReply({
        content: null,
        embeds: [baseEmbed(Colors.main).setDescription(
          `🏓 **Pong!**\nMesaj gecikmesi: **${rtt}ms**\nAPI gecikmesi: **${Math.round(interaction.client.ws.ping)}ms**`)],
      });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder().setName('sunucubilgi').setDescription('Discord sunucusu hakkında bilgi verir'),
    async execute(interaction) {
      const g = interaction.guild;
      await g.members.fetch().catch(() => null);
      const channels = g.channels.cache;
      const embed = baseEmbed(Colors.main)
        .setTitle(`🌊 ${g.name}`)
        .setThumbnail(g.iconURL({ size: 256 }))
        .addFields(
          { name: '👑 Sahip', value: `<@${g.ownerId}>`, inline: true },
          { name: '👥 Üyeler', value: String(g.memberCount), inline: true },
          { name: '📅 Kuruluş', value: discordTime(g.createdTimestamp, 'D'), inline: true },
          { name: '💬 Kanallar', value: `${channels.filter((c) => c.type === ChannelType.GuildText).size} yazı / ${channels.filter((c) => c.type === ChannelType.GuildVoice).size} ses`, inline: true },
          { name: '🎭 Roller', value: String(g.roles.cache.size), inline: true },
          { name: '🚀 Boost', value: `Seviye ${g.premiumTier} (${g.premiumSubscriptionCount ?? 0})`, inline: true },
        );
      return interaction.reply({ embeds: [embed] });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('kullanıcıbilgi')
      .setDescription('Bir kullanıcı hakkında bilgi verir')
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı (boş = kendin)')),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı') ?? interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      const embed = baseEmbed(Colors.main)
        .setTitle(`👤 ${user.tag}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'ID', value: `\`${user.id}\``, inline: true },
          { name: 'Hesap Açılışı', value: discordTime(user.createdTimestamp, 'D'), inline: true },
        );
      if (member) {
        const roles = member.roles.cache.filter((r) => r.id !== interaction.guild.id)
          .sort((a, b) => b.position - a.position).map((r) => `${r}`).slice(0, 15);
        embed.addFields(
          { name: 'Katılış', value: member.joinedTimestamp ? discordTime(member.joinedTimestamp, 'D') : '?', inline: true },
          { name: 'Yetki Kademesi', value: tierName(tierOf(member)), inline: true },
          { name: `Roller (${roles.length})`, value: roles.length ? roles.join(' ') : 'yok', inline: false },
        );
      }
      return interaction.reply({ embeds: [embed] });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('avatar')
      .setDescription('Bir kullanıcının avatarını gösterir')
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı (boş = kendin)')),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı') ?? interaction.user;
      return interaction.reply({
        embeds: [baseEmbed(Colors.main).setTitle(`🖼️ ${user.tag}`).setImage(user.displayAvatarURL({ size: 1024 }))],
      });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('komutlar')
      .setDescription('Minecraft sunucusundaki (NautilusUHC plugin) tüm komutları gösterir'),
    async execute(interaction) {
      // Plugin tarafındaki CommandCatalog ile aynı içerik — oyun içinde
      // /komutlar GUI'si, Discord'da bu ephemeral mesaj.
      const oyuncu = [
        '`/komutlar` — Tüm komutları sayfalı GUI\'de gösterir',
        '`/spawn` — Spawn noktasına ışınlar (alias: `/hub` `/lobi` `/lobby`)',
        '`/team` — Takım menüsü: kur, davet et, ayrıl (`create` `invite` `accept` `decline` `leave` `inventory`)',
        '`/stats [oyuncu]` — Elo, rütbe, W/L, K/D istatistikleri (alias: `/istatistik`)',
        '`/top [elo|galibiyet|kill]` — İlk 10 sıralaması (alias: `/siralama`)',
        '`/latescatter` — Süren maça geç katılım (ilk 5 dk)',
        '`/mackatil` — Hızlı katılım / maç kaydı (alias: `/macakatil` `/katil`)',
        '`/saat` — Gerçek Türkiye saati, time.now senkronlu (alias: `/zaman` `/tarih`)',
        '`/trims` — Zırh deseni işleme menüsü',
        '`/link` — Discord hesap bağlama kodu (alias: `/bagla`)',
        '`/report <oyuncu> <sebep>` — Oyuncu raporlama (alias: `/rapor`)',
      ].join('\n');
      const host = [
        '`/host` — Adım adım maç kurulum sihirbazı (`zamanla` `iptal` `liste` `baslat` `bitir`)',
        '`/testuhc` — Test paneli: aşama atlama, hızlı deathmatch, başlat/bitir',
        '`/uhc <forcestart|stop|reset>` — Anında başlat / durdur / dünya reseti',
        '`/uhcstart` — Geri sayımla başlat',
        '`/scenario` — Senaryoları aç/kapat',
        '`/revive <oyuncu|all|team>` — Diriltme',
        '`/setspawn` — Kalıcı spawn ayarla, DB\'de saklanır (alias: `/setlobbyspawn`)',
        '`/betterping` — Ping telafisi: durum/reload/test',
        '`/disguise` `/undisguise` `/disguisecheck` — Takma ad işlemleri',
        '`/givegoldenhead [oyuncu]` — Golden head verir',
        '`/banner [create]` — Sancak kütüphanesi',
        '`/testhost` — Discord köprüsü test eventleri',
      ].join('\n');
      const mod = [
        '`/panel` — Moderasyon yönetim GUI\'si: oyuncular, yasaklı arama, hazır cezalar, sicil (alias: `/modpanel`)',
        '`/sicil <oyuncu>` — Kalıcı ceza geçmişi (alias: `/gecmis`)',
        '`/ban` `/tempban` `/unban` — Yasaklama (alias: `/yasakla` `/sureliyasak` `/yasakkaldir`)',
        '`/mute` `/tempmute` `/unmute` — Susturma (alias: `/sustur` `/surelisustur` `/susturkaldir`)',
        '`/kick` — Atma (alias: `/at`) · `/warn` `/unwarn` `/warns` — Uyarılar',
        '`/banlist` `/mutelist` — Aktif ceza listeleri',
        '`/freeze` (alias: `/ss`) · `/vanish` · `/mutechat` · `/reports [temizle]`',
        '`/unlink <mc|dc>` — Hesap bağlantısı silme (alias: `/kayitsil`)',
      ].join('\n');
      const embed = baseEmbed(Colors.main)
        .setTitle('⚔️ NautilusUHC — Oyun İçi Komutlar')
        .setDescription('Minecraft sunucusundaki plugin komutları ve işlevleri. '
          + 'Oyun içinde `/komutlar` yazarsan aynı listeyi tıklanabilir GUI olarak görürsün.')
        .addFields(
          { name: '🎮 Oyuncu Komutları', value: oyuncu },
          { name: '🎯 Host Komutları (nautilus.host)', value: host },
          { name: '🛡️ Moderasyon (nautilus.mod)', value: mod },
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder().setName('yardım').setDescription('Kullanabileceğin komutları listeler'),
    async execute(interaction) {
      const tier = tierOf(interaction.member);
      const embed = baseEmbed(Colors.main)
        .setTitle('📖 NautilusUHC Bot — Komutlar')
        .setDescription(`Yetki kademen: **${tierName(tier)}**`)
        .addFields({
          name: '🌍 Herkes',
          value: '`/ping` `/sunucubilgi` `/kullanıcıbilgi` `/avatar` `/yardım` `/hatırlat`\n'
            + '`/komutlar` — Minecraft sunucusundaki plugin komutları\n'
            + '`/profil` — skinli oyuncu profili (ELO, rank, maçlar)\n'
            + '`/sıralama` — ELO/galibiyet/kill liderlik tablosu\n'
            + '`/mcdurum` — sunucu & maç durumu\n'
            + '`/maç bilgi|program|geçmiş|detay` — maç bilgileri\n'
            + '`/link` — MC hesap bağlantı durumun\n'
            + '`/destek aç` — destek talebi',
        });
      if (tier >= Tier.REHBER) {
        embed.addFields({
          name: '🧭 Rehber+',
          value: '`/mconline` `/uyarılar` `/sicil` `/anket` `/maç envanter`',
        });
      }
      if (tier >= Tier.MOD) {
        embed.addFields({
          name: '🛡️ Mod+',
          value: '`/kick` `/mute` `/unmute` `/uyar` `/sil` `/kilit` `/yavaşmod` `/çekiliş`\n'
            + '`/mcmute` `/mcunmute` `/mckick` `/mcuyar`',
        });
      }
      if (tier >= Tier.BMOD) {
        embed.addFields({
          name: '⚔️ Baş Mod+',
          value: '`/ban` (süreli destekli) `/unban` `/uyarısil` `/mcban` `/mcunban`',
        });
      }
      if (tier >= Tier.ADMIN) {
        embed.addFields({
          name: '👑 Admin+',
          value: '`/rolver` `/rolal` `/duyuru` `/embed` `/kayıtsil`\n'
            + '`/admin dclinkgönder|logkanal|koruma|automod|hoşgeldin|maçrol`\n'
            + '`/admin ticketpanel|ticketkategori|rolpanel|elorank`',
        });
      }
      return interaction.reply({ embeds: [embed], ephemeral: true });
    },
  },
];
