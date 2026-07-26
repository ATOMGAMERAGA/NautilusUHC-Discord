import { createServer } from 'node:http';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { getSetting, processedEvents } from './db.js';
import { baseEmbed, Colors, Assets } from './embeds.js';
import { trDateTime, discordTime, formatSeconds, clean } from './util.js';

/**
 * Receives lifecycle events from the NautilusUHC plugin (Pelican host) and turns
 * them into Turkish embeds in the match announcement channel.
 *
 * POST /api/event
 *   Zarf v2: { eventId, schemaVersion: 2, type, occurredAt, test, matchId?, data }
 *   Zarf v1 (legacy): { type, test?, data }
 *
 * Auth (docs/INTEGRATION-CONTRACT.md):
 *   Tercih edilen — HMAC-SHA256 imza başlıkları:
 *     X-Nautilus-Timestamp: epoch ms
 *     X-Nautilus-Nonce:     UUID (istek başına benzersiz)
 *     X-Nautilus-Signature: hex hmacSha256(secret, `${ts}.${nonce}.${rawBody}`)
 *   Legacy (config.bridgeAllowLegacy iken) — X-Bridge-Secret: <secret>
 *
 * Idempotency: eventId varsa processed_events üzerinden dedup edilir; aynı
 * eventId'nin retry'ı 200 döner ama ikinci bir Discord mesajı ÜRETMEZ.
 */

const SCHEMA_VERSIONS = [1, 2];
const EVENT_TYPES = [
  'match_scheduled', 'match_start', 'match_end', 'match_cancelled', 'message', 'host_message',
  'phase_change', 'tier_change', 'report_created', 'punishment', 'link_removed',
];

/*
 * Yeni (Faz 7) event tiplerinin kanal yönlendirmesi. Eski 6 tip her zaman maç
 * kanalına gider (data.channelId ?? config.matchChannelId). Yeni tipler:
 *  - setting: settings tablosundaki kanal anahtarı (/admin ... ile ayarlanır)
 *  - fallbackMatch: ayar boşsa maç kanalına düş; yoksa event YÖNLENDİRİLMEZ
 *    (200 {routed:false} — eventId claim edilir, retry fırtınası olmaz)
 *  - suppressDiscordSource: data.source === 'discord' ise duyuru BASTIRILIR;
 *    botun kendi /mc* komutu zaten modlog'a yazdı (çifte duyuru önlenir)
 */
export const EVENT_ROUTES = {
  phase_change: { fallbackMatch: true },
  tier_change: { setting: 'rank_channel', fallbackMatch: true },
  report_created: { setting: 'staff_channel' },
  punishment: { setting: 'staff_channel', suppressDiscordSource: true },
  link_removed: { setting: 'staff_channel', suppressDiscordSource: true },
};

/** Maç kanalı id'si: /admin mackanal ayarı > MATCH_CHANNEL_ID (env/varsayılan). */
export function matchChannelId() {
  return getSetting('match_channel', '') || config.matchChannelId;
}

/** Eventin gideceği kanal id'si; null = yönlendirme yok (bastırıldı/ayarsız). */
export function resolveEventChannel(type, data = {}) {
  const route = EVENT_ROUTES[type];
  if (!route) return data.channelId ?? matchChannelId(); // eski 6 tip
  if (route.suppressDiscordSource && data.source === 'discord') return null;
  const fromSetting = route.setting ? getSetting(route.setting, '') : '';
  if (fromSetting) return fromSetting;
  return route.fallbackMatch ? matchChannelId() : null;
}

/**
 * Ayarlı kanal id'si sunucuda yoksa (yanlış env, silinmiş kanal) İSME göre
 * son çare arama: "maçlar" / "maclar" adlı (ya da adı bunlarla başlayan) ilk
 * yazı kanalı. Böylece maç duyuruları kanal id'si yanlış diye sessizce kaybolmaz.
 */
export function findMatchChannelByName(client) {
  try {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return null;
    const normalize = (s) => String(s ?? '').toLowerCase()
      .replaceAll('ç', 'c').replaceAll('ğ', 'g').replaceAll('ı', 'i')
      .replaceAll('ö', 'o').replaceAll('ş', 's').replaceAll('ü', 'u');
    const wanted = ['maclar', 'mac-duyuru', 'mac-duyurular', 'mac-duyurulari'];
    const channel = guild.channels.cache.find((c) => c.isTextBased?.()
      && wanted.some((w) => normalize(c.name) === w || normalize(c.name).startsWith(w)));
    return channel ?? null;
  } catch {
    return null;
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Görülen nonce'lar (replay engeli). Pencere dışına düşenler budanır. */
const seenNonces = new Map(); // nonce -> timestamp(ms)

function pruneNonces(windowMs, now = Date.now()) {
  for (const [nonce, ts] of seenNonces) {
    if (now - ts > windowMs) seenNonces.delete(nonce);
  }
}

/**
 * HMAC imzalı isteği doğrular. Dönüş: null = geçerli, aksi hâlde hata kodu.
 * Test edilebilirlik için saf tutulur (now enjekte edilebilir).
 */
export function verifySignature({ timestamp, nonce, signature }, rawBody, secret, {
  windowMs = config.bridgeReplayWindowMs,
  now = Date.now(),
  nonces = seenNonces,
} = {}) {
  if (!timestamp || !nonce || !signature) return 'missing_signature_headers';
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return 'bad_timestamp';
  if (Math.abs(now - ts) > windowMs) return 'timestamp_out_of_window';
  if (nonces.has(nonce)) return 'replay';
  const expected = createHmac('sha256', secret).update(`${timestamp}.${nonce}.${rawBody}`).digest('hex');
  if (!safeEqual(signature.toLowerCase(), expected)) return 'bad_signature';
  nonces.set(nonce, ts);
  if (nonces.size > 10_000) pruneNonces(windowMs, now);
  return null;
}

/** Basit IP başına kayan pencere rate limiti. */
const rateBuckets = new Map(); // ip -> number[]
function rateLimited(ip, { limit = 60, windowMs = 60_000, now = Date.now() } = {}) {
  const arr = (rateBuckets.get(ip) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  rateBuckets.set(ip, arr);
  return arr.length > limit;
}

function eventEmbed(type, data, test) {
  switch (type) {
    case 'match_scheduled': {
      const e = baseEmbed(test ? Colors.warn : Colors.info)
        .setTitle(`${test ? '🧪 TEST — ' : ''}📅 Maç Planlandı`)
        .setThumbnail(Assets.item.diamondSword)
        .setImage(Assets.wordmarkScene)
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
        .setThumbnail(Assets.item.diamondSword)
        .addFields(
          { name: '🎙️ Host', value: clean(data.host ?? '?', 30), inline: true },
          { name: '👥 Oyuncu', value: String(data.players ?? '?'), inline: true },
          { name: '🎲 Senaryolar', value: data.scenarios?.length ? data.scenarios.join(', ') : 'yok', inline: true },
          { name: '🕐 Başlangıç', value: `${trDateTime(data.startedAt ?? Date.now())} (TR)`, inline: false },
        );

    case 'match_end': {
      const e = baseEmbed(test ? Colors.warn : Colors.main)
        .setTitle(`${test ? '🧪 TEST — ' : ''}🏆 Maç Bitti!`)
        .setThumbnail(Assets.item.goldenApple)
        .addFields(
          { name: '🥇 Kazanan', value: `**${clean(data.winner ?? '—', 40)}**`, inline: true },
        );
      // MVP oylaması sonucu — kazananın hemen altında. Veri yoksa (test maçı,
      // solo, oylama kapalı) alan sessizce atlanır.
      if (data.mvpName && !data.mvpVotes) {
        // Oylamasız MVP (en çok öldüren) — oy sayısı gösterilmez.
        e.addFields({
          name: "🏆 Maçın MVP'si",
          value: `${clean(data.mvpName, 30)} — ${data.mvpKills ?? 0} kill`,
          inline: true,
        });
      } else if (data.mvpName) {
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
        .setThumbnail(Assets.block.cobweb)
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
        .setThumbnail(Assets.mark)
        .setDescription(clean(data.message ?? '', 3900))
        .addFields({ name: '🎙️ Host', value: clean(data.host ?? '?', 30), inline: true });

    // Faz değişimi — plugin yalnız pvp/border_shrink/deathmatch geçişlerini yollar
    // (start/end zaten match_start/match_end tarafından duyurulur).
    case 'phase_change': {
      const PHASES = {
        pvp: { title: '⚔️ PvP Açıldı!', color: Colors.danger },
        border_shrink: { title: '🧱 Border Daralmaya Başladı', color: Colors.warn },
        deathmatch: { title: '☠️ Deathmatch Zamanı!', color: Colors.danger },
      };
      const p = PHASES[data.phase]
        ?? { title: `📢 Faz: ${clean(String(data.phase ?? '?'), 30)}`, color: Colors.info };
      const e = baseEmbed(test ? Colors.warn : p.color)
        .setTitle(`${test ? '🧪 TEST — ' : ''}${p.title}`)
        .setThumbnail(Assets.item.ironSword)
        .addFields(
          { name: '⏱️ Geçen Süre', value: formatSeconds(data.elapsedSecs ?? 0), inline: true },
          { name: '❤️ Hayatta', value: String(data.aliveCount ?? '?'), inline: true },
        );
      if (data.borderSize != null) {
        e.addFields({ name: '🧱 Border', value: `±${data.borderSize}`, inline: true });
      }
      return e;
    }

    // ELO küme (tier) değişimi — kutlama/uyarı duyurusu.
    case 'tier_change': {
      const up = data.direction !== 'demote';
      return baseEmbed(test ? Colors.warn : (up ? Colors.success : Colors.warn))
        .setTitle(`${test ? '🧪 TEST — ' : ''}${up ? '📈 Küme Atladı!' : '📉 Küme Düştü'}`)
        .setThumbnail(Assets.item.diamond)
        .setDescription(
          `**${clean(data.player ?? '?', 30)}** — ${clean(data.oldTier ?? '?', 20)} → `
          + `**${clean(data.newTier ?? '?', 20)}** (${data.elo ?? '?'} ELO)`,
        );
    }

    // Oyun içi /report — staff kanalına düşer.
    case 'report_created':
      return baseEmbed(Colors.danger)
        .setTitle(`${test ? '🧪 TEST — ' : ''}🚨 Oyuncu Raporu`)
        .setThumbnail(Assets.block.cobweb)
        .addFields(
          { name: '📣 Raporlayan', value: clean(data.reporter ?? '?', 30), inline: true },
          { name: '🎯 Raporlanan', value: clean(data.reported ?? '?', 30), inline: true },
          { name: '📝 Sebep', value: clean(data.reason || '—', 500), inline: false },
        );

    // MC tarafı moderasyon aynası (source=discord olanlar routing'de bastırılır).
    case 'punishment': {
      const LABELS = {
        ban: 'Ban', unban: 'Ban Kaldırıldı', mute: 'Susturma',
        unmute: 'Susturma Kaldırıldı', kick: 'Sunucudan Atıldı', warn: 'Uyarı',
      };
      const label = LABELS[data.action] ?? clean(String(data.action ?? '?'), 20);
      const e = baseEmbed(Colors.warn)
        .setTitle(`${test ? '🧪 TEST — ' : ''}🔨 MC Ceza — ${label}`)
        .addFields(
          { name: '👤 Oyuncu', value: clean(data.player ?? '?', 30), inline: true },
          { name: '🛡️ Yetkili', value: clean(data.staff ?? '?', 30), inline: true },
        );
      if (data.action === 'ban' || data.action === 'mute') {
        e.addFields({
          name: '⏱️ Süre',
          value: data.durationMs ? formatSeconds(Math.round(data.durationMs / 1000)) : 'Kalıcı',
          inline: true,
        });
      }
      e.addFields({ name: '📝 Sebep', value: clean(data.reason || '—', 500), inline: false });
      return e;
    }

    // MC↔DC bağlantısı kaldırıldı (source=discord olanlar routing'de bastırılır).
    case 'link_removed':
      return baseEmbed(Colors.info)
        .setTitle(`${test ? '🧪 TEST — ' : ''}🔗 Hesap Bağlantısı Kaldırıldı`)
        .setDescription(
          `**${clean(data.mc ?? '?', 30)}** ↔ <@${data.discordId ?? '?'}> bağlantısı oyun tarafından kaldırıldı.`,
        );

    default:
      return null;
  }
}

/**
 * Kanal duyurusunun payload'ını üretir (embed + rol etiketi + allowedMentions).
 * DM aboneliği (Faz 4) aynı üreticiyi kullanır ki içerik drift etmesin.
 */
export function buildAnnouncement(type, data, test) {
  const embed = eventEmbed(type, data, test);
  if (!embed) return null;
  let content;
  const allowedMentions = { parse: [] };
  if (!test && (type === 'match_scheduled' || type === 'match_start')) {
    const pingRole = getSetting('match_ping_role', '');
    if (pingRole) {
      content = `<@&${pingRole}>`;
      allowedMentions.roles = [pingRole];
    }
  }
  return { content, embeds: [embed], allowedMentions };
}

/**
 * HTTP handler'ı üretir. `hooks.onEvent(envelope)` — event başarıyla kanala
 * gönderildikten sonra çağrılır (Faz 4 DM dağıtımı buradan beslenir).
 * Test edilebilirlik için client/hooks enjekte edilir.
 */
export function createRequestHandler(client, hooks = {}) {
  return (req, res) => {
    const respond = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/health') {
      return respond(200, { ok: true, bot: client.isReady() });
    }
    if (req.method === 'GET' && req.url === '/api/capabilities') {
      return respond(200, {
        ok: true,
        service: 'nautilusuhc-discord',
        schemaVersions: SCHEMA_VERSIONS,
        eventTypes: EVENT_TYPES,
        auth: config.bridgeAllowLegacy ? ['hmac-sha256', 'legacy-shared-secret'] : ['hmac-sha256'],
      });
    }
    if (req.method !== 'POST' || req.url !== '/api/event') {
      return respond(404, { ok: false, error: 'not_found' });
    }

    const ip = req.socket?.remoteAddress ?? '?';
    if (rateLimited(ip)) {
      return respond(429, { ok: false, error: 'rate_limited', mesaj: 'Çok fazla istek; kısa süre sonra tekrar dene.' });
    }
    if (!config.bridgeSecret) {
      return respond(401, { ok: false, error: 'unauthorized' });
    }

    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 256_000) req.destroy();
    });
    req.on('end', async () => {
      // ---- Auth: önce HMAC, yoksa (izinliyse) legacy shared secret ----
      const sigHeaders = {
        timestamp: req.headers['x-nautilus-timestamp'],
        nonce: req.headers['x-nautilus-nonce'],
        signature: req.headers['x-nautilus-signature'],
      };
      const hasSig = sigHeaders.timestamp || sigHeaders.nonce || sigHeaders.signature;
      if (hasSig) {
        const err = verifySignature(sigHeaders, raw, config.bridgeSecret);
        if (err) return respond(401, { ok: false, error: `unauthorized:${err}` });
      } else if (config.bridgeAllowLegacy) {
        const secret = req.headers['x-bridge-secret'];
        if (!secret || !safeEqual(secret, config.bridgeSecret)) {
          return respond(401, { ok: false, error: 'unauthorized' });
        }
      } else {
        return respond(401, { ok: false, error: 'unauthorized:signature_required' });
      }

      let envelope;
      try {
        envelope = JSON.parse(raw || '{}');
      } catch {
        return respond(400, { ok: false, error: 'bad_json' });
      }
      const { type, test = false, data = {}, eventId = null, schemaVersion = 1 } = envelope;
      const correlationId = eventId ?? randomUUID();
      if (!SCHEMA_VERSIONS.includes(schemaVersion)) {
        return respond(422, {
          ok: false, error: 'unsupported_schema_version', correlationId,
          mesaj: `Desteklenen şema sürümleri: ${SCHEMA_VERSIONS.join(', ')}`,
        });
      }
      const embedPayload = buildAnnouncement(type, data, test);
      if (!embedPayload) return respond(400, { ok: false, error: 'unknown_event_type', correlationId });

      // ---- Idempotency: eventId'yi göndermeden ÖNCE sahiplen ----
      if (eventId && !processedEvents.claim(eventId, type)) {
        console.log(`[bridge] duplicate event yoksayıldı: ${type} ${eventId}`);
        return respond(200, { ok: true, duplicate: true, correlationId });
      }

      // Hook, event KABUL EDİLDİĞİNDE bir kez koşar: hem başarılı kanal
      // gönderiminden sonra, hem de kanalsız/bastırılmış (routed:false) yolda —
      // böylece rol senkronu kanal ayarlanmamışken de işler. Hatası event
      // işlemesini bozmaz. NOT: Kanal fetch'i başarısız olursa (502) eventId
      // BIRAKILIR ve hook koşmaz; DM dağıtımı (dispatchMatchDms) idempotent
      // olmadığından hook'u burada koşturmak retry'da çift DM üretirdi. Kanal
      // gerektirmeyen rol senkronu ise retry'da veya link doğrulama/senkron
      // komutu yollarından uygulanır.
      const runHook = async () => {
        try {
          await hooks.onEvent?.({ type, test, data, eventId, schemaVersion });
        } catch (hookErr) {
          console.error(`[bridge] onEvent hook hatası (${correlationId}):`, hookErr.message);
        }
      };

      // ---- Yönlendirme: kanal yoksa/bastırıldıysa mesajsız kabul et ----
      const channelId = resolveEventChannel(type, data);
      if (!channelId) {
        console.log(`[bridge] olay yönlendirilmedi (kanal ayarsız/bastırıldı): ${type} (${correlationId})`);
        await runHook();
        return respond(200, { ok: true, routed: false, correlationId });
      }

      try {
        let channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased()) {
          // Kanal id'si geçersiz/erişilemez: maç kanalına giden eventlerde son
          // çare olarak "maçlar" adlı kanalı isimle bul (yanlış env id'si maç
          // duyurularını sessizce yutmasın).
          const isMatchRoute = channelId === matchChannelId();
          const fallback = isMatchRoute ? findMatchChannelByName(client) : null;
          if (fallback) {
            console.warn(`[bridge] kanal ${channelId} bulunamadı; isimle bulunan #${fallback.name} kullanılıyor. `
              + 'Kalıcı çözüm: /admin mackanal ile doğru kanalı ayarla.');
            channel = fallback;
          } else {
            if (eventId) processedEvents.release(eventId); // retry edilebilsin
            console.error(`[bridge] olay kanalı bulunamadı (${type} → ${channelId}). `
              + 'MATCH_CHANNEL_ID env değerini veya /admin mackanal ayarını kontrol et.');
            return respond(502, { ok: false, error: 'channel_unavailable', correlationId });
          }
        }
        await channel.send(embedPayload);
        console.log(`[bridge] olay işlendi: ${type}${test ? ' (test)' : ''} (${correlationId})`);
        // Kanal duyurusu sonrası hook (ör. Faz 4 DM dağıtımı, rol senkronu).
        await runHook();
        return respond(200, { ok: true, correlationId });
      } catch (err) {
        if (eventId) processedEvents.release(eventId);
        console.error(`[bridge] olay hatası (${correlationId}):`, err.message);
        return respond(500, { ok: false, error: 'internal_error', correlationId });
      }
    });
  };
}

export function startHttpServer(client, hooks = {}) {
  processedEvents.prune();
  const server = createServer(createRequestHandler(client, hooks));
  server.requestTimeout = 30_000;
  server.listen(config.port, () => {
    console.log(`[bridge] HTTP sunucusu ${config.port} portunda dinliyor`);
  });
  return server;
}
