import { Events } from 'discord.js';
import { config } from './config.js';
import { getSetting } from './db.js';
import { baseEmbed, Colors, Assets } from './embeds.js';
import { discordTime } from './util.js';

/** Varsayılan otorol — /admin otorol ile değiştirilebilir/kapatılabilir. */
const DEFAULT_AUTOROLE_ID = '1522154206285271102';

/** Sends a welcome embed when a member joins (channel set via /admin hoşgeldin). */
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

      const embed = baseEmbed(Colors.main)
        .setTitle('🌊 Nautilus PvP\'ye Hoş Geldin!')
        .setDescription(`${member.user}, aramıza katıldın — sen **${member.guild.memberCount}.** üyemizsin!\n\n`
          + '➤ Maçlara katılmak için önce Minecraft hesabını bağla: sunucuda `/link` yaz, '
          + 'kodu hesap bağlama kanalındaki butona gir.\n'
          + '➤ Maç saatleri ve detaylar için `/maç program` komutunu kullanabilirsin.\n'
          + '➤ Sunucu: `nautilusuhc.com`')
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
        .setImage(Assets.wordmarkScene)
        .addFields({ name: 'Hesap açılışı', value: discordTime(member.user.createdTimestamp, 'R'), inline: true });
      await channel.send({ content: `${member.user}`, embeds: [embed] });
    } catch (err) {
      console.error('[welcome]', err.message);
    }
  });
}
