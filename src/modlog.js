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
export async function sendLog(client, options) {
  try {
    await sendLogStrict(client, options);
  } catch (err) {
    console.error('[modlog] gönderilemedi:', err.message);
  }
}

/**
 * sendLog'un hata fırlatan hâli: yeniden denenebilir yan işlemler (hesap
 * bağlama logları) başarısızlığı görebilsin diye. Log kanalı ayarlı değilse
 * yapılacak iş yoktur ve false döner.
 */
export async function sendLogStrict(client, {
  title, description, color = Colors.info, fields = [], content, pingRoles = [],
}) {
  const id = logChannelId();
  if (!id) return false;
  const channel = await client.channels.fetch(id);
  if (!channel?.isTextBased()) throw new Error(`log kanalı (${id}) bulunamadı ya da yazı kanalı değil`);
  const embed = baseEmbed(color).setTitle(title).setTimestamp();
  if (description) embed.setDescription(description);
  if (fields.length) embed.addFields(fields);
  const roles = pingRoles.filter(Boolean);
  await channel.send({
    content: content || undefined,
    embeds: [embed],
    allowedMentions: { parse: [], roles },
  });
  return true;
}
