import { getSetting, setSetting } from './db.js';
import { mcapi } from './mcapi.js';
import { statusBoardEmbed } from './liveembeds.js';
import { Brand } from './embeds.js';

/**
 * Oto-güncellenen durum panosu + bot presence'ı.
 *
 * 60 sn'de bir /api/status + /api/server/perf çekilir; `status_channel`
 * ayarlıysa `status_message_id` mesajı düzenlenir (yoksa oluşturulur).
 * Görgü kuralları: içerik değişmediyse edit atlanır (payloadHash), presence
 * yalnız satır değişince veya 30 dk'da bir zorla tazelenir — Discord edit
 * limitlerine takılmadan sessiz çalışır.
 */

const TICK_MS = 60_000;
const PRESENCE_FORCE_MS = 30 * 60_000;

/** Embed'in değişim-karşılaştırma anahtarı — timestamp hariç (her build'de değişir). */
export function payloadHash(embed) {
  const data = embed?.data ?? {};
  return JSON.stringify({ ...data, timestamp: undefined });
}

/** Saf karar: yeni hash öncekinden farklıysa edit gerekir. */
export function shouldEdit(newHash, prevHash) {
  return newHash !== prevHash;
}

/**
 * Bot durumu (presence): maç varsa canlı sayaç, yoksa oyuncu sayısı, köprü
 * kapalıysa yalnız sunucu adresi. Tek satır olduğu için en değerli bilgi öne
 * yazılır ve ayraç tüm botta olduğu gibi "•" kullanır.
 */
export function presenceLine(status) {
  const match = status?.ok ? status.match : null;
  if (match?.active) {
    return `⚔️ ${match.aliveCount ?? '?'}/${match.participantCount ?? '?'} hayatta — ${match.state ?? 'maç'}`;
  }
  const count = status?.ok ? (status.count ?? 0) : null;
  return count != null ? `🎮 ${count} oyuncu • ${Brand.domain}` : Brand.domain;
}

const state = { lastHash: null, lastPresence: null, lastPresenceAt: 0 };

async function tick(client) {
  const status = await mcapi.status();
  const perf = await mcapi.perf();

  // Presence: yalnız değişince veya periyodik zorlamada set edilir
  // (presence bazen düştüğü için 30 dk'da bir yenilenir).
  const line = presenceLine(status);
  const now = Date.now();
  if (line !== state.lastPresence || now - state.lastPresenceAt > PRESENCE_FORCE_MS) {
    state.lastPresence = line;
    state.lastPresenceAt = now;
    try {
      client.user.setPresence({ activities: [{ name: line, type: 0 }], status: 'online' });
    } catch { /* presence düşerse bir sonraki tick dener */ }
  }

  const channelId = getSetting('status_channel', '');
  if (!channelId) return;
  const embed = statusBoardEmbed(status, perf);
  const hash = payloadHash(embed);
  if (!shouldEdit(hash, state.lastHash)) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const msgId = getSetting('status_message_id', '');
  let ok = false;
  if (msgId) {
    const msg = await channel.messages.fetch(msgId).catch(() => null);
    if (msg) {
      // Yalnız edit GERÇEKTEN başarılıysa "işlendi" say — mesaj fetch ile edit
      // arasında silinmiş/hata almışsa yeniden oluşturmaya düş.
      const edited = await msg.edit({ embeds: [embed] }).then(() => true).catch(() => false);
      ok = edited;
    }
  }
  if (!ok) {
    const sent = await channel.send({ embeds: [embed] }).catch(() => null);
    if (sent) {
      setSetting('status_message_id', sent.id);
      ok = true;
    }
  }
  // Hash yalnız başarılı gönderim/düzenlemede tüketilir; aksi halde sonraki
  // tick tekrar dener (pano sessizce donmaz).
  if (ok) state.lastHash = hash;
}

export function startStatusBoard(client) {
  const run = () => tick(client).catch((err) => console.error('[statusboard]', err.message));
  run();
  setInterval(run, TICK_MS).unref();
}
