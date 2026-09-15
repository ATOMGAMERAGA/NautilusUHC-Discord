import { SlashCommandBuilder, ChannelType, MessageFlags } from 'discord.js';
import { Tier, tierOf, tierName } from '../permissions.js';
import { baseEmbed, brandFooter, Colors, Assets, Brand } from '../embeds.js';
import { discordTime, codeText } from '../util.js';

/**
 * Genel amaçlı komutlar + iki referans ekranı:
 *  /yardım   → botun komutları, yetki kademesine göre filtrelenmiş
 *  /komutlar → Minecraft sunucusundaki plugin komutları
 *
 * Her ikisi de "duvar metin" değil, kategorilere ayrılmış kısa listelerdir:
 * kullanıcı aradığı komutu tarayarak bulabilmelidir.
 */

/** /yardım grupları. `min` alanı grubun görünmesi için gereken kademedir. */
const HELP_GROUPS = [
  {
    min: Tier.MEMBER,
    name: '🌍 Genel',
    value: '`/yardım` `/ping` `/sunucubilgi` `/kullanıcıbilgi` `/avatar` `/hatırlat`',
  },
  {
    min: Tier.MEMBER,
    name: '⛏️ Minecraft & Profil',
    value: '`/link` — Minecraft hesabını bağla veya durumu gör\n'
      + '`/profil` — ELO, rank ve maç istatistikleri\n'
      + '`/sıralama` — ELO / galibiyet / kill tablosu\n'
      + '`/mcdurum` — sunucu ve maç durumu\n'
      + '`/komutlar` — oyun içi plugin komutları',
  },
  {
    min: Tier.MEMBER,
    name: '⚔️ Maçlar',
    value: '`/maç bilgi|canlı|program|geçmiş|detay` — maç bilgileri\n'
      + '`/takımlar` `/sıra` `/senaryolar` — kadro, kuyruk ve senaryolar\n'
      + '`/maç-bildirim` — maç başlarken DM bildirimi',
  },
  {
    min: Tier.MEMBER,
    name: '🎫 Destek',
    value: '`/destek aç` — yetkililere ulaş\n`/destek kapat` — talebini kapat',
  },
  {
    min: Tier.REHBER,
    name: '🧭 Rehber',
    value: '`/sicil` `/uyarılar` `/not liste` — kullanıcı geçmişi\n'
      + '`/mconline` `/sunucuperf` `/sağlık` — sunucu ve bot durumu\n'
      + '`/maç envanter` `/anket` `/destek listele|bilgi|ata|öncelik`',
  },
  {
    min: Tier.MOD,
    name: '🛡️ Mod',
    value: '`/uyar` `/mute` `/unmute` `/kick` `/nick` `/not ekle`\n'
      + '`/sil` `/kilit` `/yavaşmod` `/çekiliş`\n'
      + '`/mcmute` `/mcunmute` `/mckick` `/mcuyar` `/mcsicil` `/mcbanlist` `/mcmutelist`\n'
      + '`/linkler` `/linkbilgi` `/linkgecmisi` — hesap bağlantılarını incele',
  },
  {
    min: Tier.BMOD,
    name: '⚔️ Baş Mod',
    value: '`/ban` `/unban` `/softban` `/uyarısil` `/lockdown`\n'
      + '`/mcban` `/mcunban` `/destek karaliste`',
  },
  {
    min: Tier.ADMIN,
    name: '👑 Admin',
    value: '`/rolver` `/rolal` `/duyuru` `/embed`\n'
      + '`/unlink` — hesap bağlantısını onayla kaldır (`/kayıtsil` eski kısayol)\n'
      + '`/admin` — kanal, koruma, destek, rol ve ELO ayarları',
  },
];

/** /komutlar ekranı: oyun içi plugin komutları, kategori kategori. */
const MC_COMMAND_GROUPS = [
  {
    name: '🎮 Temel',
    value: '`/spawn` — Spawn\'a ışınlanma (alias: `/hub` `/lobi`)\n'
      + '`/msg` `/r` `/msgtoggle` — Özel mesaj ve yanıt\n'
      + '`/liste` — Çevrimiçi oyuncular (alias: `/online`)\n'
      + '`/ping [oyuncu]` — Gecikme ölçümü\n'
      + '`/saat` — Türkiye saati\n'
      + '`/link` — Discord hesap bağlama kodu (alias: `/bagla`)\n'
      + '`/report <oyuncu> <sebep>` — Oyuncu raporlama',
  },
  {
    name: '⚔️ Maç & İstatistik',
    value: '`/mackatil` — Maç kaydı / hızlı katılım (alias: `/katil`)\n'
      + '`/latescatter` — Süren maça geç katılım (ilk 5 dk)\n'
      + '`/team` — Takım kur, davet et, kabul/ret\n'
      + '`/stats [oyuncu]` — ELO, rütbe, W/L, K/D\n'
      + '`/top [elo|galibiyet|kill]` — İlk 10 sıralaması\n'
      + '`/trims` — Zırh deseni menüsü',
  },
  {
    name: '🎯 Host (nautilus.host)',
    value: '`/host` — Maç kurulum sihirbazı (`zamanla` `iptal` `liste` `baslat` `bitir`)\n'
      + '`/uhcstart` `/uhc <forcestart|stop|reset>` — Başlatma ve sıfırlama\n'
      + '`/nextevent` — Sıradaki maç etkinliğine geç\n'
      + '`/scenario` — Senaryoları aç/kapat · `/team limit <sayı>` — Takım limiti\n'
      + '`/revive <oyuncu|all|team>` — Diriltme · `/givegoldenhead` — Golden head\n'
      + '`/testuhc` `/testhost` — Test paneli ve köprü testleri\n'
      + '`/setspawn` `/betterping` `/disguise` `/banner`',
  },
  {
    name: '🛡️ Moderasyon (nautilus.mod)',
    value: '`/panel` — Moderasyon GUI\'si (alias: `/modpanel`)\n'
      + '`/ban` `/tempban` `/unban` · `/mute` `/tempmute` `/unmute` · `/kick`\n'
      + '`/warn` `/unwarn` `/warns` · `/banlist` `/mutelist`\n'
      + '`/sicil <oyuncu>` — Kalıcı ceza geçmişi (alias: `/gecmis`)\n'
      + '`/freeze` `/vanish` `/mutechat` `/reports`\n'
      + '`/unlink <oyuncu> [sebep]` · `/unlink <mc|dc|uuid> <değer>` — bağlantıyı kaldır',
  },
  {
    name: '🧰 Yetkili Araçları',
    value: '`/duyuru <mesaj>` — Sunucu duyurusu (alias: `/bc`)\n'
      + '`/sohbettemizle` `/yavasmod <sn>` `/socialspy`\n'
      + '`/fly` `/heal` `/feed` `/gm <0-3>` `/envbak <oyuncu>`',
  },
];

export default [
  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder().setName('ping').setDescription('Botun gecikme süresini ölçer'),
    async execute(interaction) {
      // reply({ fetchReply: true }) discord.js v14'te kullanımdan kaldırıldı;
      // mesajı ayrı bir fetchReply() ile alıyoruz (davranış aynı).
      await interaction.reply({ content: 'Ölçülüyor…' });
      const sent = await interaction.fetchReply();
      const rtt = sent.createdTimestamp - interaction.createdTimestamp;
      const api = Math.round(interaction.client.ws.ping);
      await interaction.editReply({
        content: null,
        embeds: [baseEmbed(rtt < 400 ? Colors.success : Colors.warn)
          .setTitle('🏓 Pong')
          .addFields(
            { name: 'Mesaj gecikmesi', value: `${rtt} ms`, inline: true },
            { name: 'API gecikmesi', value: `${api} ms`, inline: true },
          )],
      });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder().setName('sunucubilgi').setDescription('Discord sunucusu hakkında özet bilgi verir'),
    async execute(interaction) {
      const g = interaction.guild;
      await g.members.fetch().catch(() => null);
      const channels = g.channels.cache;
      const embed = baseEmbed(Colors.brand)
        .setTitle(`🌊 ${codeText(g.name, 60)}`)
        .setThumbnail(g.iconURL({ size: 256 }))
        .addFields(
          { name: 'Üye', value: String(g.memberCount), inline: true },
          { name: 'Sahip', value: `<@${g.ownerId}>`, inline: true },
          { name: 'Kuruluş', value: discordTime(g.createdTimestamp, 'D'), inline: true },
          {
            name: 'Kanallar',
            value: `${channels.filter((c) => c.type === ChannelType.GuildText).size} yazı • `
              + `${channels.filter((c) => c.type === ChannelType.GuildVoice).size} ses`,
            inline: true,
          },
          { name: 'Roller', value: String(g.roles.cache.size), inline: true },
          { name: 'Boost', value: `Seviye ${g.premiumTier} (${g.premiumSubscriptionCount ?? 0})`, inline: true },
        );
      return interaction.reply({ embeds: [embed] });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('kullanıcıbilgi')
      .setDescription('Bir kullanıcının hesap ve rol bilgilerini gösterir')
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı (boş = kendin)')),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı') ?? interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      const embed = baseEmbed(Colors.brand)
        .setTitle(`👤 ${codeText(user.tag, 40)}`)
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'Kullanıcı ID', value: `\`${user.id}\``, inline: true },
          { name: 'Hesap açılışı', value: discordTime(user.createdTimestamp, 'D'), inline: true },
        );
      if (member) {
        const roles = member.roles.cache.filter((r) => r.id !== interaction.guild.id)
          .sort((a, b) => b.position - a.position).map((r) => `${r}`).slice(0, 15);
        embed.addFields(
          { name: 'Sunucuya katılış', value: member.joinedTimestamp ? discordTime(member.joinedTimestamp, 'D') : '—', inline: true },
          { name: 'Yetki kademesi', value: tierName(tierOf(member)), inline: true },
          { name: `Roller (${roles.length})`, value: roles.length ? roles.join(' ') : '—', inline: false },
        );
      }
      return interaction.reply({ embeds: [embed] });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('avatar')
      .setDescription('Bir kullanıcının avatarını büyük gösterir')
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı (boş = kendin)')),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı') ?? interaction.user;
      return interaction.reply({
        embeds: [baseEmbed(Colors.brand)
          .setTitle(`🖼️ ${codeText(user.tag, 40)}`)
          .setImage(user.displayAvatarURL({ size: 1024 }))],
      });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('komutlar')
      .setDescription('Minecraft sunucusundaki oyun içi komutları gösterir'),
    async execute(interaction) {
      // Plugin tarafındaki CommandCatalog ile aynı içerik — oyun içinde
      // /komutlar GUI'si, Discord'da bu ephemeral liste.
      const embed = baseEmbed(Colors.brand)
        .setTitle(`⚔️ ${Brand.product} — Oyun İçi Komutlar`)
        .setThumbnail(Assets.item.enchantedBook)
        .setDescription(`\`${Brand.domain}\` sunucusundaki plugin komutları. `
          + 'Oyun içinde `/komutlar` yazarsan aynı listeyi tıklanabilir menü olarak görürsün.')
        .addFields(MC_COMMAND_GROUPS)
        .setFooter(brandFooter('Yetki gerektiren komutlar yalnız yetkililerde görünür'));
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder().setName('yardım').setDescription('Kullanabileceğin bot komutlarını listeler'),
    async execute(interaction) {
      const tier = tierOf(interaction.member);
      const groups = HELP_GROUPS.filter((g) => tier >= g.min).map(({ name, value }) => ({ name, value }));
      const embed = baseEmbed(Colors.brand)
        .setTitle(`📖 ${Brand.community} — Bot Komutları`)
        .setThumbnail(Assets.mark)
        .setDescription('Aşağıda yetki kademene açık komutlar var. '
          + 'Oyun içi komutlar için `/komutlar` kullanabilirsin.')
        .addFields(groups)
        .setFooter(brandFooter(`Yetki kademen: ${tierName(tier)}`));
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  },
];
