import { baseEmbed, Colors } from './embeds.js';
import { getSetting } from './db.js';
import { config } from './config.js';

/** Resolves the active log channel: /admin logkanal setting wins over env. */
export function logChannelId() {
  return getSetting('log_channel', config.logChannelId) || null;
}

/**
 * Sends an embed to the moderation/security log channel. Never throws — logging
 * must not break the action being logged.
 */
export async function sendLog(client, { title, description, color = Colors.info, fields = [] }) {
  try {
    const id = logChannelId();
    if (!id) return;
    const channel = await client.channels.fetch(id).catch(() => null);
    if (!channel?.isTextBased()) return;
    const embed = baseEmbed(color).setTitle(title);
    if (description) embed.setDescription(description);
    if (fields.length) embed.addFields(fields.slice(0, 25));
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[modlog] gönderilemedi:', err.message);
  }
}
