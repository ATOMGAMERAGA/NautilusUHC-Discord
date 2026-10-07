import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { Tier } from '../permissions.js';
import {
  okEmbed, baseEmbed, bridgeErrorEmbed, Colors, Assets, Brand,
} from '../embeds.js';
import { mcapi } from '../mcapi.js';
import { config } from '../config.js';
import { clean } from '../util.js';
import { readDiscordLink } from '../linkeffects.js';
import { linkAdmin, actorFromInteraction } from '../linkadmin.js';

export default [
  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('link')
      .setDescription('Minecraft hesap bağlantı durumunu gösterir'),
    async execute(interaction) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // Çoklu sunucuda her bağımsız depo ayrı sorulur; rastgele bir depodan okunmaz.
      const res = await readDiscordLink(mcapi, interaction.user.id);
      if (!res.ok) {
        return interaction.editReply({ embeds: [bridgeErrorEmbed(res.res, { context: 'bağlantı durumu' })] });
      }
      if (res.linked) {
        const names = res.links.map((link) => `**${clean(link.currentName ?? link.mcName ?? '?', 30)}**`).join(', ');
        return interaction.editReply({
          embeds: [okEmbed(
            `Discord hesabına bağlı Minecraft hesapları: ${names}.\n`
            + (res.links.length < 2 ? 'İkinci Minecraft hesabını aynı Hesap Bağla butonuyla ekleyebilirsin.\n' : '')
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
              + '**2.** Sana verilen kodu kopyala (her `/link` yeni kod üretir, en son kodu kullan).\n'
              + `**3.** <#${config.linkChannelId}> kanalındaki **Hesap Bağla** butonuna tıklayıp kodu gir.`,
          })],
      });
    },
  },

  {
    tier: Tier.ADMIN,
    data: new SlashCommandBuilder()
      .setName('kayıtsil')
      .setDescription('Bir Minecraft ↔ Discord hesap bağlantısını siler (onaylı akış için /unlink)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((s) => s.setName('mc').setDescription('Minecraft adına göre bağlantıyı siler (birebir ad)')
        .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft oyuncu adı').setRequired(true)))
      .addSubcommand((s) => s.setName('dc').setDescription('Discord kullanıcısına göre bağlantıyı siler')
        .addUserOption((o) => o.setName('kullanıcı').setDescription('Discord kullanıcısı').setRequired(true))),
    async execute(interaction) {
      // Bağlantı kaydı kişisel veridir: sonuç yalnız yetkiliye gösterilir,
      // kalıcı iz log kanalına ve denetim geçmişine düşer.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const sub = interaction.options.getSubcommand();
      const selector = sub === 'mc' ? 'name' : 'discord';
      const value = sub === 'mc'
        ? interaction.options.getString('oyuncu', true).trim()
        : interaction.options.getUser('kullanıcı', true).id;
      return interaction.editReply(await linkAdmin.quickUnlink({
        actor: actorFromInteraction(interaction), selector, value,
      }));
    },
  },
];
