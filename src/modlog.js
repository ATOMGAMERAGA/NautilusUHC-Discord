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
 *
 * Log kartları operasyonel okunurluk için tek biçimdir: kısa başlık, gerekiyorsa
 * bir cümlelik özet, ardından sabit sıralı alanlar (Kullanıcı → Yetkili →
 * ayrıntı → Sebep). Zaman damgası burada anlamlıdır ve her kartta bulunur.
 *
 * Etiketleme varsayılan olarak KAPALIDIR: log kanalı kazara kimseyi pinglemez.
 * Yalnız gerçekten çağrı gerektiren olaylar (patlama koruması) `pingRoles` ile
 * bilinçli olarak yetkili rolünü etiketler.
 */
export async function sendLog(client, {
  title, description, color = Colors.info, fields = [], content, pingRoles = [],
}) {
  try {
    const id = logChannelId();
    if (!id) return;
    const channel = await client.channels.fetch(id).catch(() => null);
    if (!channel?.isTextBased()) return;
    const embed = baseEmbed(color).setTitle(title).setTimestamp();
    if (description) embed.setDescription(description);
    if (fields.length) embed.addFields(fields);
    const roles = pingRoles.filter(Boolean);
    await channel.send({
      content: content || undefined,
      embeds: [embed],
      allowedMentions: { parse: [], roles },
    });
  } catch (err) {
    console.error('[modlog] gönderilemedi:', err.message);
  }
}
