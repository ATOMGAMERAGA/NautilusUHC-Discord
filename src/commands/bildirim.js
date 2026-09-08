import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { Tier } from '../permissions.js';
import { baseEmbed, brandFooter, Colors } from '../embeds.js';
import { dmSubscriptions } from '../db.js';
import { CONFIRM_TTL_MS } from '../matchdm.js';

/**
 * /maç-bildirim — kişisel, onaylı ve kalıcı maç başlangıç DM aboneliği.
 *
 * Tek komut hem açma hem kapatma akışını yönetir: mevcut durum gösterilir,
 * değişiklik ancak butonla AÇIK onaydan sonra uygulanır. Onay butonu yalnız
 * komutu kullanan kişiye çalışır ve 2 dakikada süresi dolar. Sonuçlar
 * ephemeral'dır; abonelik listesi hiçbir yerde dışarıya açılmaz.
 */

export { CONFIRM_TTL_MS };

export function statusEmbed(userId) {
  const enabled = dmSubscriptions.isEnabled(userId);
  const { last_error: lastError, last_error_at: lastErrorAt } = dmSubscriptions.lastError(userId);
  const e = baseEmbed(enabled ? Colors.success : Colors.neutral)
    .setTitle(enabled ? '🔔 Maç Bildirimin Açık' : '🔕 Maç Bildirimin Kapalı')
    .setDescription(enabled
      ? 'Normal bir maç başladığında duyurunun kopyası sana DM olarak geliyor.'
      : 'Şu anda maç başlangıcında DM almıyorsun.')
    .addFields({
      name: 'Nasıl çalışır',
      value: 'Bildirim yalnız **normal maçlarda** gönderilir, test maçları dahil değildir.\n'
        + 'Aboneliğin kişiseldir ve kimseyle paylaşılmaz.',
    })
    .setFooter(brandFooter('Değişiklik için aşağıdaki butonu kullan'));
  if (enabled && lastError) {
    e.addFields({
      name: 'Son bildirim ulaşmadı',
      value: 'Bir önceki duyuru sana iletilemedi '
        + `(<t:${Math.floor((lastErrorAt ?? Date.now()) / 1000)}:R>).\n`
        + 'Sunucu gizlilik ayarlarından "Sunucu üyelerinden özel mesaj" iznini açman gerekiyor olabilir.',
    });
    console.warn(`[maç-bildirim] ${userId} teslimat hatası: ${lastError}`);
  }
  return e;
}

export function actionRow(userId, enabled, now = Date.now()) {
  const row = new ActionRowBuilder();
  if (enabled) {
    row.addComponents(new ButtonBuilder()
      .setCustomId(`bildirim:kapat:${userId}:${now}`)
      .setLabel('Bildirimleri Kapat').setEmoji('🔕').setStyle(ButtonStyle.Danger));
  } else {
    row.addComponents(new ButtonBuilder()
      .setCustomId(`bildirim:ac:${userId}:${now}`)
      .setLabel('Bildirimleri Aç').setEmoji('🔔').setStyle(ButtonStyle.Success));
  }
  row.addComponents(new ButtonBuilder()
    .setCustomId(`bildirim:vazgec:${userId}:${now}`)
    .setLabel('Vazgeç').setStyle(ButtonStyle.Secondary));
  return row;
}

export default [
  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('maç-bildirim')
      .setDescription('Maç başlangıcı DM bildirimini açar veya kapatır'),
    async execute(interaction) {
      const userId = interaction.user.id;
      const enabled = dmSubscriptions.isEnabled(userId);
      await interaction.reply({
        embeds: [statusEmbed(userId)],
        components: [actionRow(userId, enabled)],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];
