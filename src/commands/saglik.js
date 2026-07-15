import { SlashCommandBuilder } from 'discord.js';
import { Tier } from '../permissions.js';
import { baseEmbed, Colors } from '../embeds.js';
import { db, pendingTaskCount, ticketsV2, getSetting } from '../db.js';
import { mcapi } from '../mcapi.js';
import { formatDuration } from '../util.js';

/**
 * /sağlık — bot sağlık paneli (Rehber+): uptime, DB, köprü erişimi,
 * zamanlayıcı kuyruğu, açık talep sayısı ve modül anahtarları.
 * Köprü erişilemezse "bozuk" değil "kısıtlı" sayılır (degraded, not fatal).
 */

const BRIDGE_TIMEOUT_MS = 3000;

function moduleLine(name, on) {
  return `${on ? '🟢' : '🔴'} ${name}: **${on ? 'açık' : 'kapalı'}**`;
}

export default [
  {
    tier: Tier.REHBER,
    data: new SlashCommandBuilder()
      .setName('sağlık')
      .setDescription('Bot sağlık durumu: uptime, veritabanı, köprü, zamanlayıcı (Rehber+)'),
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

      const uptimeMs = Math.floor(process.uptime() * 1000);
      const pending = pendingTaskCount();
      const openTickets = ticketsV2.openCount();

      const allOk = dbOk; // köprü degraded sayılır, genel durumu düşürmez
      const embed = baseEmbed(allOk ? Colors.success : Colors.danger)
        .setTitle(`${allOk ? '💚' : '❤️‍🩹'} Bot Sağlık Durumu`)
        .addFields(
          { name: '⏱️ Çalışma süresi', value: formatDuration(uptimeMs), inline: true },
          { name: '🗄️ Veritabanı', value: dbOk ? '🟢 Sağlıklı' : '🔴 HATA', inline: true },
          {
            name: '🌉 Köprü (plugin)',
            value: bridge.ok ? '🟢 Erişilebilir' : `🟡 Erişilemiyor — ${bridge.error ?? 'bilinmiyor'}`,
            inline: true,
          },
          { name: '📆 Bekleyen görev', value: String(pending), inline: true },
          { name: '🎫 Açık talep', value: String(openTickets), inline: true },
          { name: '📡 API gecikmesi', value: `${Math.round(interaction.client.ws.ping)}ms`, inline: true },
          {
            name: '🧩 Modüller',
            value: [
              moduleLine('Guard (anti-nuke)', getSetting('guard_enabled', '1') === '1'),
              moduleLine('Automod', getSetting('automod_enabled', '1') === '1'),
              moduleLine('Hoş geldin', Boolean(getSetting('welcome_channel', ''))),
              moduleLine('Destek sistemi', getSetting('tickets_enabled', '1') === '1'),
            ].join('\n'),
          },
        );
      return interaction.editReply({ embeds: [embed] });
    },
  },
];
