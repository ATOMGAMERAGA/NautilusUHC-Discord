import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Tier } from '../permissions.js';
import { okEmbed, errEmbed, baseEmbed, Colors } from '../embeds.js';
import { mcapi } from '../mcapi.js';
import { config } from '../config.js';
import { addCase } from '../db.js';
import { clean } from '../util.js';
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
      if (!res.ok) return interaction.editReply({ embeds: [errEmbed(`❌ ${res.error}`)] });
      if (res.linked) {
        return interaction.editReply({
          embeds: [okEmbed(`✅ Hesabın **${clean(res.mc, 30)}** Minecraft hesabına bağlı.\n`
            + 'Bir yanlışlık olduğunu düşünüyorsan değişiklik için destek talebi aç.')],
        });
      }
      return interaction.editReply({
        embeds: [baseEmbed(Colors.warn).setDescription(
          '🔗 Hesabın henüz bir Minecraft hesabına bağlı değil.\n\n'
          + '1. Minecraft sunucusuna gir ve sohbete `/link` yaz.\n'
          + `2. Sana verilen kodu <#${config.linkChannelId}> kanalındaki **Hesap Bağla** butonuna tıklayıp gir.\n\n`
          + 'Maçlara katılmak için hesap bağlantısı zorunludur.')],
      });
    },
  },

  {
    tier: Tier.ADMIN,
    data: new SlashCommandBuilder()
      .setName('kayıtsil')
      .setDescription('Bir hesap bağlantısını (MC↔DC) siler')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((s) => s.setName('mc').setDescription('Minecraft kullanıcı adına göre bağlantıyı siler')
        .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft oyuncu adı').setRequired(true)))
      .addSubcommand((s) => s.setName('dc').setDescription('Discord kullanıcısına göre bağlantıyı siler')
        .addUserOption((o) => o.setName('kullanıcı').setDescription('Discord kullanıcısı').setRequired(true))),
    async execute(interaction) {
      await interaction.deferReply();
      const sub = interaction.options.getSubcommand();
      const type = sub === 'mc' ? 'mc' : 'dc';
      const value = type === 'mc'
        ? interaction.options.getString('oyuncu', true).trim()
        : interaction.options.getUser('kullanıcı', true).id;

      const res = await mcapi.linkDelete(type, value);
      if (!res.ok) return interaction.editReply({ embeds: [errEmbed(`❌ ${res.error}`)] });
      if (!res.removed) {
        return interaction.editReply({ embeds: [errEmbed('Bu hesaba ait bir bağlantı kaydı bulunamadı.')] });
      }

      const label = type === 'mc' ? `MC: \`${clean(value, 30)}\`` : `DC: <@${value}>`;
      addCase('link_delete', type === 'dc' ? value : null, interaction.user.id, null, label);
      await sendLog(interaction.client, {
        title: '🗑️ Hesap Bağlantısı Silindi',
        color: Colors.warn,
        description: `${label}\nSilinen bağlantı: \`${clean(res.mc ?? '?', 30)}\` ↔ <@${res.discordId ?? '?'}>\nYetkili: ${interaction.user}`,
      });
      return interaction.editReply({ embeds: [okEmbed(`🗑️ Bağlantı kaydı silindi (${label}).`)] });
    },
  },
];
