import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { Tier } from '../permissions.js';
import { baseEmbed, Colors } from '../embeds.js';
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
  const e = baseEmbed(enabled ? Colors.success : Colors.info)
    .setTitle('🔔 Maç Bildirimi (DM)')
    .setDescription(
      'Normal bir Nautilus UHC maçı başladığında, maçlar kanalındaki duyurunun '
      + 'bir kopyasını sana DM olarak gönderir. **Test maçları bu bildirime dahil değildir.**\n\n'
      + `Mevcut durum: ${enabled ? '🟢 **AÇIK**' : '🔴 **KAPALI**'}`,
    );
  if (enabled && lastError) {
    e.addFields({
      name: '⚠️ Son teslimat sorunu',
      value: `Son bildirim sana ulaştırılamadı: \`${lastError}\`\n`
        + 'DM ayarlarının bu sunucudan mesaj almaya izin verdiğinden emin ol '
        + `(<t:${Math.floor((lastErrorAt ?? Date.now()) / 1000)}:R>).`,
    });
  }
  return e;
}

export function actionRow(userId, enabled, now = Date.now()) {
  const row = new ActionRowBuilder();
  if (enabled) {
    row.addComponents(new ButtonBuilder()
      .setCustomId(`bildirim:kapat:${userId}:${now}`)
      .setLabel('Kapat').setEmoji('🔕').setStyle(ButtonStyle.Danger));
  } else {
    row.addComponents(new ButtonBuilder()
      .setCustomId(`bildirim:ac:${userId}:${now}`)
      .setLabel('Aç').setEmoji('🔔').setStyle(ButtonStyle.Success));
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
      .setDescription('Maç başlangıcında kişisel DM bildirimini aç/kapat (onaylı)'),
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
