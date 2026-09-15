import { verifyLinkCode } from './linkflow.js';
import { okEmbed, errEmbed, warnEmbed } from './embeds.js';
import { clean } from './util.js';
import { linkEffects, linkCreatedEffects } from './linkeffects.js';
import { resetStatsCache } from './statsproxy.js';

/**
 * Hesap bağlama modalı — discord.js'e bağımlı olmayan etkileşim katmanı.
 *
 * Sıra bilinçlidir:
 *   1. deferReply (Discord'un 3 sn sınırı içinde, tek acknowledge)
 *   2. plugin doğrulaması (linkflow.js)
 *   3. KULLANICIYA YANIT (kalıcı eşleme doğrulandıysa başarı)
 *   4. yan işlemler (audit/log/rol) kalıcı kuyruğa — hataları yanıtı değiştiremez
 */

export const EPHEMERAL = 64;

/** Panel butonunun açtığı kod modalı (Discord API JSON'u). */
export function linkCodeModal() {
  return {
    custom_id: 'link:modal',
    title: 'Minecraft Hesabını Bağla',
    components: [{
      type: 1,
      components: [{
        type: 4,
        custom_id: 'code',
        label: 'Bağlantı Kodu',
        placeholder: 'Örn: 9DK7QX4M',
        style: 1,
        min_length: 6,
        max_length: 12,
        required: true,
      }],
    }],
  };
}

export async function handleLinkModal(interaction, {
  verify = verifyLinkCode, effects = linkEffects, logger = console,
} = {}) {
  const code = interaction.fields.getTextInputValue('code');
  await interaction.deferReply({ flags: EPHEMERAL });

  const decision = await verify({
    code, discordId: interaction.user.id, discordTag: interaction.user.tag,
  });

  if (decision.outcome !== 'linked') {
    const { kind, title, description } = decision.failure;
    return safeEdit(interaction, {
      embeds: [kind === 'already_linked_other' || kind === 'unconfirmed'
        ? warnEmbed(description, title)
        : errEmbed(description, title)],
    }, logger, decision.requestId);
  }

  const mc = clean(decision.mc ?? '?', 30);
  const changed = decision.created || decision.replay;
  await safeEdit(interaction, {
    embeds: [changed
      ? okEmbed(`Minecraft hesabın **${mc}** ile eşleştirildi.\n`
        + 'Artık Nautilus maçlarına katılabilir, profilini `/profil` ile görebilirsin.', '🔗 Hesap Bağlandı')
      : okEmbed(`Discord hesabın zaten **${mc}** hesabına bağlı; değişiklik yapılmadı.`, '🔗 Hesabın Zaten Bağlı')],
  }, logger, decision.requestId);

  if (!changed) return undefined;
  try {
    resetStatsCache();
  } catch { /* önbellek temizliği eşlemeyi etkilemez */ }
  try {
    await effects.enqueue(linkCreatedEffects({
      link: decision.link,
      discordId: interaction.user.id,
      discordTag: interaction.user.tag,
      mc: decision.mc,
      instance: decision.instance,
      requestId: decision.requestId,
    }), { client: interaction.client });
  } catch (err) {
    // Eşleme plugin deposunda kalıcı; yan işlem kuyruğu yazılamadıysa bu görünür kalmalı.
    logger.error(`[link] rid=${decision.requestId} eşleme kalıcı fakat yan işlemler kuyruğa yazılamadı: ${err.message}`);
  }
  return undefined;
}

async function safeEdit(interaction, payload, logger, requestId) {
  try {
    await interaction.editReply(payload);
  } catch (err) {
    logger.error(`[link] rid=${requestId ?? '-'} Discord yanıtı gönderilemedi: ${err.message}`);
  }
}
