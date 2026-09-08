import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Tier } from '../permissions.js';
import {
  okEmbed, errEmbed, baseEmbed, bridgeErrorEmbed, Colors, Assets, Brand,
} from '../embeds.js';
import { mcapi } from '../mcapi.js';
import { config } from '../config.js';
import { addCase } from '../db.js';
import { clean, codeText } from '../util.js';
import { sendLog } from '../modlog.js';

export default [
  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('link')
      .setDescription('Minecraft hesap bağlantı durumunu gösterir'),
    async execute(interaction) {
      await interaction.deferReply({ ephemeral: true });
      const res = await mcapi.linkStatus(`discord=${interaction.user.id}`);
      if (!res.ok) {
        return interaction.editReply({ embeds: [bridgeErrorEmbed(res, { context: 'bağlantı durumu' })] });
      }
      if (res.linked) {
        return interaction.editReply({
          embeds: [okEmbed(
            `Discord hesabın **${clean(res.mc, 30)}** ile eşleşmiş durumda.\n`
            + 'Bağlantıyı değiştirmen gerekiyorsa `/destek aç` ile talep oluştur.',
            '🔗 Hesap Bağlı',
          )],
        });
      }
      return interaction.editReply({
        embeds: [baseEmbed(Colors.warn)
          .setTitle('🔗 Hesabın Henüz Bağlı Değil')
          .setThumbnail(Assets.item.enderPearl)
          .setDescription('Maçlara katılmak ve istatistik biriktirmek için Minecraft hesabını bağlaman gerekiyor.')
          .addFields({
            name: 'Üç adımda bağla',
            value: `**1.** \`${Brand.domain}\` sunucusuna gir ve sohbete \`/link\` yaz.\n`
              + `**2.** Sana verilen kodu kopyala.\n`
              + `**3.** <#${config.linkChannelId}> kanalındaki **Hesap Bağla** butonuna tıklayıp kodu gir.`,
          })],
      });
    },
  },

  {
    tier: Tier.ADMIN,
    data: new SlashCommandBuilder()
      .setName('kayıtsil')
      .setDescription('Bir Minecraft ↔ Discord hesap bağlantısını siler')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((s) => s.setName('mc').setDescription('Minecraft adına göre bağlantıyı siler')
        .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft oyuncu adı').setRequired(true)))
      .addSubcommand((s) => s.setName('dc').setDescription('Discord kullanıcısına göre bağlantıyı siler')
        .addUserOption((o) => o.setName('kullanıcı').setDescription('Discord kullanıcısı').setRequired(true))),
    async execute(interaction) {
      // Bağlantı kaydı kişisel veridir: sonuç yalnız yetkiliye gösterilir,
      // kalıcı iz log kanalına düşer.
      await interaction.deferReply({ ephemeral: true });
      const sub = interaction.options.getSubcommand();
      const type = sub === 'mc' ? 'mc' : 'dc';
      const value = type === 'mc'
        ? interaction.options.getString('oyuncu', true).trim()
        : interaction.options.getUser('kullanıcı', true).id;

      const res = await mcapi.linkDelete(type, value);
      if (!res.ok) {
        return interaction.editReply({ embeds: [bridgeErrorEmbed(res, { context: 'bağlantı silme' })] });
      }
      if (!res.removed) {
        return interaction.editReply({
          embeds: [errEmbed(
            type === 'mc'
              ? `\`${codeText(value, 30)}\` adına kayıtlı bir hesap bağlantısı yok.`
              : `<@${value}> için kayıtlı bir hesap bağlantısı yok.`,
            'Bağlantı Bulunamadı',
          )],
        });
      }

      const label = type === 'mc' ? `MC \`${codeText(value, 30)}\`` : `DC <@${value}>`;
      addCase('link_delete', type === 'dc' ? value : null, interaction.user.id, null, label);
      await sendLog(interaction.client, {
        title: 'Hesap Bağlantısı Silindi',
        color: Colors.warn,
        fields: [
          { name: 'Minecraft', value: `\`${codeText(res.mc ?? '?', 30)}\``, inline: true },
          { name: 'Discord', value: res.discordId ? `<@${res.discordId}>` : '—', inline: true },
          { name: 'Yetkili', value: `${interaction.user}`, inline: true },
        ],
      });
      return interaction.editReply({
        embeds: [okEmbed(
          `\`${codeText(res.mc ?? '?', 30)}\` ↔ ${res.discordId ? `<@${res.discordId}>` : 'bilinmeyen hesap'} bağlantısı kaldırıldı.\n`
          + 'Oyuncu yeniden bağlanmak için oyun içinde `/link` yazıp yeni bir kod almalı.',
          'Bağlantı Silindi',
        )],
      });
    },
  },
];
