import { Events } from 'discord.js';
import { config } from './config.js';
import { getSetting } from './db.js';
import { baseEmbed, Colors, Assets, Brand } from './embeds.js';
import { mentionUsers } from './util.js';

/** Varsayılan otorol — /admin otorol ile değiştirilebilir/kapatılabilir. */
const DEFAULT_AUTOROLE_ID = '1522154206285271102';

/**
 * Yeni üye karşılaması — botun ilk izlenimi.
 *
 * Tek ekranda üç şey verir: hoş geldin, kim olduğun (kaçıncı üye) ve ilk üç
 * adım. Uzun paragraf, kural duvarı veya banner yığını yok; marka görseli tek
 * ve büyük görsel olarak kullanılır. Kanal /admin hoşgeldin ile ayarlanır.
 */
export function registerWelcome(client) {
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      if (member.guild.id !== config.guildId || member.user.bot) return;

      // Otorol: sunucuya katılan herkese ayarlı rolü ver ('off' = kapalı).
      const autoroleId = getSetting('autorole_id', DEFAULT_AUTOROLE_ID);
      if (autoroleId && autoroleId !== 'off') {
        const role = member.guild.roles.cache.get(autoroleId)
          ?? await member.guild.roles.fetch(autoroleId).catch(() => null);
        if (role) {
          await member.roles.add(role, 'Otorol: sunucuya katılım').catch((err) =>
            console.error('[autorole]', err.message));
        }
      }

      const channelId = getSetting('welcome_channel', '');
      if (!channelId) return;
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) return;

      const linkChannel = config.linkChannelId ? `<#${config.linkChannelId}>` : 'hesap bağlama kanalı';
      const embed = baseEmbed(Colors.brand)
        .setTitle(`🌊 ${Brand.community}'ye Hoş Geldin`)
        .setDescription(`${member.user}, aramıza katıldın — sunucunun **${member.guild.memberCount}.** üyesisin.`)
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
        .setImage(Assets.wordmarkScene)
        .addFields(
          {
            name: 'Başlarken',
            value: `**1.** \`${Brand.domain}\` sunucusuna gir ve sohbete \`/link\` yaz.\n`
              + `**2.** Aldığın kodu ${linkChannel} kanalındaki **Hesap Bağla** butonuna gir.\n`
              + '**3.** `/maç program` ile sıradaki UHC maçının saatini gör.',
          },
          {
            name: 'İşine yarayacak komutlar',
            value: '`/profil` — ELO ve maç istatistiklerin\n'
              + '`/maç-bildirim` — maç başlarken DM al\n'
              + '`/destek aç` — bir sorunda yetkililere ulaş',
          },
        );
      await channel.send({
        content: `${member.user}`,
        embeds: [embed],
        allowedMentions: mentionUsers(member.id),
      });
    } catch (err) {
      console.error('[welcome]', err.message);
    }
  });
}
