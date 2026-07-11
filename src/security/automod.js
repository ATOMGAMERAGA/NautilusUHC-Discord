import { Events } from 'discord.js';
import { config } from '../config.js';
import { Tier, tierOf } from '../permissions.js';
import { getSetting } from '../db.js';
import { sendLog } from '../modlog.js';
import { Colors } from '../embeds.js';

/**
 * Lightweight chat automod: spam bursts, foreign invite links and mass mentions.
 * Staff (Rehber and above) are exempt. Violations delete the message; spam adds
 * a short timeout.
 */

const SPAM_WINDOW_MS = 5000;
const SPAM_MAX = 6;
const MENTION_MAX = 8;
const SPAM_TIMEOUT_MS = 5 * 60_000;

const INVITE_RE = /(discord\.(gg|io|me)|discord(app)?\.com\/invite)\/[\w-]+/i;

/** userId -> recent message timestamps */
const recent = new Map();

function isSpam(userId) {
  const now = Date.now();
  const list = (recent.get(userId) ?? []).filter((t) => now - t < SPAM_WINDOW_MS);
  list.push(now);
  recent.set(userId, list);
  return list.length >= SPAM_MAX;
}

export function registerAutomod(client) {
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!message.inGuild() || message.guild.id !== config.guildId) return;
      if (message.author.bot) return;
      if (getSetting('automod_enabled', '1') !== '1') return;
      const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
      if (member && tierOf(member) >= Tier.REHBER) return;

      // Foreign Discord invites.
      if (INVITE_RE.test(message.content)) {
        const invite = message.content.match(INVITE_RE)?.[0] ?? '';
        const ours = await message.guild.invites.fetch().catch(() => null);
        const isOwn = ours?.some((i) => invite.endsWith(`/${i.code}`));
        if (!isOwn) {
          await message.delete().catch(() => null);
          await sendLog(client, {
            title: '🔗 Davet Linki Engellendi',
            color: Colors.warn,
            description: `${message.author} — ${message.channel}\n\`${invite}\``,
          });
          return;
        }
      }

      // Mass mentions.
      const mentionCount = message.mentions.users.size + message.mentions.roles.size
        + (message.mentions.everyone ? MENTION_MAX : 0);
      if (mentionCount >= MENTION_MAX) {
        await message.delete().catch(() => null);
        await member?.timeout(SPAM_TIMEOUT_MS, 'Automod: toplu etiket').catch(() => null);
        await sendLog(client, {
          title: '📢 Toplu Etiket Engellendi',
          color: Colors.warn,
          description: `${message.author} — ${message.channel} (${mentionCount} etiket, 5dk susturuldu)`,
        });
        return;
      }

      // Spam bursts.
      if (isSpam(message.author.id)) {
        recent.delete(message.author.id);
        await member?.timeout(SPAM_TIMEOUT_MS, 'Automod: spam').catch(() => null);
        const msgs = await message.channel.messages.fetch({ limit: 20 }).catch(() => null);
        if (msgs) {
          const own = [...msgs.values()].filter((m) => m.author.id === message.author.id).slice(0, SPAM_MAX);
          await message.channel.bulkDelete(own, true).catch(() => null);
        }
        await sendLog(client, {
          title: '🚫 Spam Engellendi',
          color: Colors.warn,
          description: `${message.author} — ${message.channel} (5dk susturuldu, mesajları temizlendi)`,
        });
      }
    } catch (err) {
      console.error('[automod]', err.message);
    }
  });
}
