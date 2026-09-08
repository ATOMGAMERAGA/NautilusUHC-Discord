import { SlashCommandBuilder } from 'discord.js';
import { Tier } from '../permissions.js';
import { baseEmbed, brandFooter, Colors } from '../embeds.js';
import { db, pendingTaskCount, ticketsV2, getSetting } from '../db.js';
import { mcapi } from '../mcapi.js';
import { bridgeQueue } from '../bridgequeue.js';
import { formatDuration } from '../util.js';

/**
 * /sağlık — bot sağlık paneli (Rehber+): uptime, DB, köprü erişimi,
 * zamanlayıcı kuyruğu, açık talep sayısı ve modül anahtarları.
 * Köprü erişilemezse "bozuk" değil "kısıtlı" sayılır (degraded, not fatal).
 *
 * Ters köprüde plugin'in BOTA bağlanması gerekir; "bağlı değil" görüyorsan
 * sorun büyük ihtimalle plugin tarafındadır (bridge.bot-url / bridge.token).
 */

const BRIDGE_TIMEOUT_MS = 3000;

function moduleLine(name, on) {
  return `${on ? '🟢' : '⚫'} ${name} — ${on ? 'açık' : 'kapalı'}`;
}

export default [
  {
    tier: Tier.REHBER,
    data: new SlashCommandBuilder()
      .setName('sağlık')
      .setDescription('Botun sağlık durumunu gösterir: uptime, veritabanı, köprü, görev kuyruğu'),
    async execute(interaction) {
      await interaction.deferReply({ ephemeral: true });

      // DB: hızlı SELECT — hata fırlatırsa DB gerçekten sorunlu demektir.
      let dbOk = false;
      try {
        dbOk = db.prepare('SELECT 1 AS ok').get()?.ok === 1;
      } catch { /* dbOk false kalır */ }

      // Köprü: 3 sn zaman aşımıyla ping; ulaşamamak botu bozmaz (degraded).
      const bridge = await Promise.race([
        mcapi.ping(),
        new Promise((resolve) => setTimeout(resolve, BRIDGE_TIMEOUT_MS, { ok: false, error: 'zaman aşımı (3sn)' })),
      ]);

      const queue = bridgeQueue.stats();
      const uptimeMs = Math.floor(process.uptime() * 1000);
      const pending = pendingTaskCount();
      const openTickets = ticketsV2.openCount();

      // Köprü erişilemez olması botu "bozuk" yapmaz: bu bir kısıt (degraded),
      // genel sağlık kararını yalnız veritabanı belirler.
      const healthy = dbOk;
      const degraded = !bridge.ok || !queue.connected;
      const embed = baseEmbed(healthy ? (degraded ? Colors.warn : Colors.success) : Colors.danger)
        .setTitle('🩺 Bot Sağlık Durumu')
        .setDescription(healthy
          ? (degraded
            ? 'Bot çalışıyor, Minecraft köprüsü şu anda kısıtlı.'
            : 'Tüm sistemler normal çalışıyor.')
          : 'Veritabanına erişilemiyor — bot işlevlerinin çoğu çalışmayacak.')
        .addFields(
          { name: 'Çalışma süresi', value: formatDuration(uptimeMs), inline: true },
          { name: 'Veritabanı', value: dbOk ? '🟢 Sağlıklı' : '🔴 Erişilemiyor', inline: true },
          { name: 'API gecikmesi', value: `${Math.round(interaction.client.ws.ping)} ms`, inline: true },
          {
            name: 'Köprü erişimi',
            value: bridge.ok ? '🟢 Yanıt veriyor' : '🟡 Yanıt vermiyor',
            inline: true,
          },
          {
            name: 'Plugin bağlantısı',
            value: queue.connected
              ? `🟢 Bağlı${queue.pending ? ` • ${queue.pending} iş kuyrukta` : ''}`
              : '🟡 Bağlı değil',
            inline: true,
          },
          { name: 'Bekleyen görev', value: String(pending), inline: true },
          { name: 'Açık destek talebi', value: String(openTickets), inline: true },
          {
            name: 'Modüller',
            value: [
              moduleLine('Patlama koruması', getSetting('guard_enabled', '1') === '1'),
              moduleLine('Automod', getSetting('automod_enabled', '1') === '1'),
              moduleLine('Hoş geldin mesajı', Boolean(getSetting('welcome_channel', ''))),
              moduleLine('Destek sistemi', getSetting('tickets_enabled', '1') === '1'),
            ].join('\n'),
            inline: false,
          },
        )
        .setTimestamp();
      if (!queue.connected) {
        embed.addFields({
          name: 'Öneri',
          value: 'Plugin bota bağlanmıyor. Minecraft sunucusu kapalı olabilir ya da '
            + 'plugin `config.yml` içindeki `bridge.bot-url` / `bridge.token` değerleri eksik olabilir.',
          inline: false,
        });
      }
      return interaction.editReply({ embeds: [embed.setFooter(brandFooter('Yalnız yetkililer görür'))] });
    },
  },
];
