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
      title: '🗑️ Mesaj Silindi',
      color: Colors.dark,
      fields: [
        { name: 'Yazan', value: `${message.author} (\`${message.author.id}\`)`, inline: true },
        { name: 'Kanal', value: `${message.channel}`, inline: true },
        { name: 'İçerik', value: clean(message.content || '*içerik yok (embed/dosya)*'), inline: false },
      ],
    });
  });

  client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
    if (!newMsg.inGuild?.() || newMsg.guild.id !== config.guildId) return;
    if (oldMsg.partial || newMsg.author?.bot) return;
    if (oldMsg.content === newMsg.content) return;
    await sendLog(client, {
      title: '✏️ Mesaj Düzenlendi',
      color: Colors.dark,
      fields: [
        { name: 'Yazan', value: `${newMsg.author} — ${newMsg.channel} [mesaja git](${newMsg.url})`, inline: false },
        { name: 'Önce', value: clean(oldMsg.content || '*boş*', 500), inline: false },
        { name: 'Sonra', value: clean(newMsg.content || '*boş*', 500), inline: false },
      ],
    });
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild.id !== config.guildId) return;
    await sendLog(client, {
      title: '📥 Üye Katıldı',
      color: Colors.success,
      description: `${member.user} (\`${member.id}\`)\nHesap açılışı: ${discordTime(member.user.createdTimestamp, 'R')}`,
    });
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    if (member.guild.id !== config.guildId) return;
    await sendLog(client, {
      title: '📤 Üye Ayrıldı',
      color: Colors.dark,
      description: `${member.user?.tag ?? member.id} (\`${member.id}\`)`,
    });
  });
}
