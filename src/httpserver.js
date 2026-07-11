import { createServer } from 'node:http';
import { config } from './config.js';
import { getSetting } from './db.js';
import { baseEmbed, Colors } from './embeds.js';
import { trDateTime, discordTime, formatSeconds, clean } from './util.js';

/**
 * Receives lifecycle events from the NautilusUHC plugin (Pelican host) and turns
 * them into Turkish embeds in the match announcement channel. Authenticated with
 * the shared bridge secret.
 *
 * POST /api/event  { type, test?, data }
 */

function eventEmbed(type, data, test) {
  switch (type) {
    case 'match_scheduled': {
      const e = baseEmbed(test ? Colors.warn : Colors.info)
        .setTitle(`${test ? '🧪 TEST — ' : ''}📅 Maç Planlandı`)
        .setDescription(`Yeni bir UHC maçı planlandı! Katılmak için sunucuya gir: \`nautilusuhc.com\``)
        .addFields(
          { name: '🕐 Başlangıç', value: `${discordTime(data.startsAt)} — **${data.slot ?? trDateTime(data.startsAt)}** (TR)`, inline: false },
          { name: '🎙️ Host', value: clean(data.host ?? '?', 30), inline: true },
          { name: '👥 Takım', value: data.teamSize > 1 ? `To${data.teamSize}` : 'FFA (Solo)', inline: true },
          { name: '🎲 Senaryolar', value: data.scenarios?.length ? data.scenarios.join(', ') : 'yok', inline: true },
        );
      if (data.settings) {
        const s = data.settings;
        e.addFields({
          name: '⚙️ Ayarlar',
          value: [
            s.pvpAt != null ? `PvP: ${s.pvpAt}. dk` : null,
            s.healAt != null ? `Heal: ${s.healAt}. dk` : null,
            s.borderSize != null ? `Border: ±${s.borderSize}` : null,
            s.latecomerWindow != null ? `Geç katılım: ${s.latecomerWindow} dk` : null,
          ].filter(Boolean).join(' • ') || '—',
        });
      }
      e.addFields({ name: '🔗 Katılım', value: 'Maça katılmak için Discord hesabını bağlamış olman gerekir (`/link`). Oyun içinde `/maç katıl` yaz.' });
      return e;
    }

    case 'match_start':
      return baseEmbed(test ? Colors.warn : Colors.success)
        .setTitle(`${test ? '🧪 TEST — ' : ''}⚔️ Maç Başladı!`)
        .addFields(
          { name: '🎙️ Host', value: clean(data.host ?? '?', 30), inline: true },
          { name: '👥 Oyuncu', value: String(data.players ?? '?'), inline: true },
          { name: '🎲 Senaryolar', value: data.scenarios?.length ? data.scenarios.join(', ') : 'yok', inline: true },
          { name: '🕐 Başlangıç', value: `${trDateTime(data.startedAt ?? Date.now())} (TR)`, inline: false },
        );

    case 'match_end': {
      const e = baseEmbed(test ? Colors.warn : Colors.main)
        .setTitle(`${test ? '🧪 TEST — ' : ''}🏆 Maç Bitti!`)
        .addFields(
          { name: '🥇 Kazanan', value: `**${clean(data.winner ?? '—', 40)}**`, inline: true },
        );
      // MVP oylaması sonucu — kazananın hemen altında. Veri yoksa (test maçı,
      // solo, oylama kapalı) alan sessizce atlanır.
      if (data.mvpName) {
        e.addFields({
          name: "🏆 Maçın MVP'si",
          value: `${clean(data.mvpName, 30)} — ${data.mvpVotes ?? 0} oy, ${data.mvpKills ?? 0} kill`,
          inline: true,
        });
      }
      e.addFields(
          { name: '⏱️ Süre', value: formatSeconds(data.durationSecs ?? 0), inline: true },
          { name: '👥 Katılımcı', value: String(data.participantCount ?? '?'), inline: true },
          { name: '📅 Bitiş', value: `${discordTime(data.endedAt ?? Date.now())} — ${trDateTime(data.endedAt ?? Date.now())} (TR)`, inline: false },
        );
      if (data.top?.length) {
        e.addFields({
          name: '🗡️ En Çok Kill',
          value: data.top.slice(0, 5).map((p, i) => `**${i + 1}.** ${clean(p.name, 20)} — ${p.kills} kill`).join('\n'),
        });
      }
      if (data.matchId != null) {
        e.addFields({ name: '📊 Detay', value: `\`/maç detay ${data.matchId}\` • Envanter snapshot: \`/maç envanter ${data.matchId} <oyuncu>\`` });
      }
      return e;
    }

    case 'match_cancelled':
      return baseEmbed(Colors.danger)
        .setTitle(`${test ? '🧪 TEST — ' : ''}❌ Maç İptal Edildi`)
        .setDescription(`**Saat:** ${data.slot ?? '?'} (TR)\n**Host:** ${clean(data.host ?? '?', 30)}`
          + (data.reason ? `\n**Sebep:** ${clean(data.reason)}` : ''));

    case 'message':
      return baseEmbed(test ? Colors.warn : Colors.main)
        .setTitle(clean(data.title ?? 'Nautilus PvP', 200))
        .setDescription(clean(data.message ?? '', 3900));

    // Host'un /host mesaj <metin> duyurusu — maç kanalına zengin embed.
    case 'host_message':
      return baseEmbed(test ? Colors.warn : Colors.main)
        .setTitle(`${test ? '🧪 TEST — ' : ''}📣 Nautilus UHC — Host Duyuru`)
        .setDescription(clean(data.message ?? '', 3900))
        .addFields({ name: '🎙️ Host', value: clean(data.host ?? '?', 30), inline: true });

    default:
      return null;
  }
}

export function startHttpServer(client) {
  const server = createServer((req, res) => {
    const respond = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/health') {
      return respond(200, { ok: true, bot: client.isReady() });
    }
    if (req.method !== 'POST' || req.url !== '/api/event') {
      return respond(404, { ok: false, error: 'not_found' });
    }

    const secret = req.headers['x-bridge-secret'];
    if (!config.bridgeSecret || secret !== config.bridgeSecret) {
      return respond(401, { ok: false, error: 'unauthorized' });
    }

    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 256_000) req.destroy();
    });
    req.on('end', async () => {
      try {
        const { type, test = false, data = {} } = JSON.parse(raw || '{}');
        const embed = eventEmbed(type, data, test);
        if (!embed) return respond(400, { ok: false, error: 'unknown_event_type' });

        const channelId = data.channelId ?? config.matchChannelId;
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) {
          return respond(502, { ok: false, error: 'channel_unavailable' });
        }
        // Maç duyurularında bildirim rolünü etiketle (test hariç).
        let content;
        if (!test && (type === 'match_scheduled' || type === 'match_start')) {
          const pingRole = getSetting('match_ping_role', '');
          if (pingRole) content = `<@&${pingRole}>`;
        }
        await channel.send({ content, embeds: [embed] });
        console.log(`[bridge] olay işlendi: ${type}${test ? ' (test)' : ''}`);
        return respond(200, { ok: true });
      } catch (err) {
        console.error('[bridge] olay hatası:', err.message);
        return respond(400, { ok: false, error: 'bad_request' });
      }
    });
  });

  server.listen(config.port, () => {
    console.log(`[bridge] HTTP sunucusu ${config.port} portunda dinliyor`);
  });
  return server;
}
