import { Events } from 'discord.js';
import { config } from '../config.js';
import { sendLog } from '../modlog.js';
import { Colors } from '../embeds.js';
import { clean, discordTime } from '../util.js';

/** Message delete/edit and member join/leave logging. */
export function registerMessageLog(client) {
  client.on(Events.MessageDelete, async (message) => {
    if (!message.inGuild?.() || message.guild.id !== config.guildId) return;
    if (message.partial || message.author?.bot) return;
    await sendLog(client, {
      title: 'Mesaj Silindi',
      color: Colors.neutral,
      fields: [
        { name: 'Yazan', value: `${message.author} (\`${message.author.id}\`)`, inline: true },
        { name: 'Kanal', value: `${message.channel}`, inline: true },
        { name: 'İçerik', value: clean(message.content || '_metin yok (embed veya dosya)_'), inline: false },
      ],
    });
  });

  client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
    if (!newMsg.inGuild?.() || newMsg.guild.id !== config.guildId) return;
    if (oldMsg.partial || newMsg.author?.bot) return;
    if (oldMsg.content === newMsg.content) return;
    await sendLog(client, {
      title: 'Mesaj Düzenlendi',
      color: Colors.neutral,
      fields: [
        { name: 'Yazan', value: `${newMsg.author} (\`${newMsg.author.id}\`)`, inline: true },
        { name: 'Kanal', value: `${newMsg.channel} • [mesaja git](${newMsg.url})`, inline: true },
        { name: 'Önce', value: clean(oldMsg.content || '_boş_', 500), inline: false },
        { name: 'Sonra', value: clean(newMsg.content || '_boş_', 500), inline: false },
      ],
    });
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild.id !== config.guildId) return;
    await sendLog(client, {
      title: 'Üye Katıldı',
      color: Colors.success,
      fields: [
        { name: 'Kullanıcı', value: `${member.user} (\`${member.id}\`)`, inline: true },
        { name: 'Hesap yaşı', value: discordTime(member.user.createdTimestamp, 'R'), inline: true },
      ],
    });
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    if (member.guild.id !== config.guildId) return;
    await sendLog(client, {
      title: 'Üye Ayrıldı',
      color: Colors.neutral,
      fields: [
        { name: 'Kullanıcı', value: `${member.user?.tag ?? 'Bilinmiyor'} (\`${member.id}\`)`, inline: true },
      ],
    });
  });
}
