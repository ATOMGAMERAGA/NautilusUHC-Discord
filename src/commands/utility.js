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
    data: new SlashCommandBuilder().setName('yardım').setDescription('Kullanabileceğin komutları listeler'),
    async execute(interaction) {
      const tier = tierOf(interaction.member);
      const embed = baseEmbed(Colors.main)
        .setTitle('📖 NautilusUHC Bot — Komutlar')
        .setDescription(`Yetki kademen: **${tierName(tier)}**`)
        .addFields({
          name: '🌍 Herkes',
          value: '`/ping` `/sunucubilgi` `/kullanıcıbilgi` `/avatar` `/yardım` `/hatırlat`\n'
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
