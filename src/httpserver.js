import { createServer } from 'node:http';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { getSetting, processedEvents } from './db.js';
import { baseEmbed, brandFooter, Colors, Assets, Brand } from './embeds.js';
import { trDateTime, discordTime, formatSeconds, clean, codeText } from './util.js';
import { bridgeQueue, MAX_POLL_WAIT_MS, ANONYMOUS_INSTANCE_PREFIX } from './bridgequeue.js';
import { publicStats } from './statsproxy.js';
import { serveResourcePack } from './resourcepack.js';

/**
 * Receives lifecycle events from the NautilusUHC plugin (Pelican host) and turns
 * them into Turkish embeds in the match announcement channel.
 *
 * POST /api/event
 *   Zarf v2: { eventId, schemaVersion: 2, type, occurredAt, test, matchId?, data }
 *   Zarf v1 (legacy): { type, test?, data }
 *
 * TERS KÖPRÜ (bkz. bridgequeue.js) — Minecraft sunucusunda port açmamak için
 * bot→plugin yönü de buradan geçer:
 *   GET  /api/bridge/jobs?wait=…   plugin uzun-yoklama ile iş çeker (HMAC)
 *   POST /api/bridge/jobs/result   plugin işin sonucunu yollar (HMAC)
 *   GET  /api/v1/stats/…           sitenin okuduğu salt-okunur API (public)
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
function rateLimited(ip, { limit = 60, windowMs = 60_000, now = Date.now(), bucket = 'event' } = {}) {
  const key = `${bucket}:${ip}`;
  const arr = (rateBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  rateBuckets.set(key, arr);
  return arr.length > limit;
}

/**
 * Yoklayan plugin'in kimliği. Yeni pluginler `X-Bridge-Instance` başlığı (ya da
 * `?instance=`) gönderir; eski pluginler hiçbir şey göndermez ve kimlik IP'den
 * türetilir. GERİYE UYUMLU: başlıksız plugin çalışmaya devam eder, yalnız iki
 * ayrı sunucu aynı IP'nin arkasındaysa ayırt edilemez — kesin ayrım için
 * plugin tarafında BRIDGE_INSTANCE_ID ayarlanmalıdır.
 *
 * Bu değer kimlik DOĞRULAMASI değildir (o HMAC/paylaşılan sır işidir); yalnız
 * teşhis ve iş yönlendirme içindir.
 */
export function pollInstanceId(req, url, ip) {
  const raw = req.headers['x-bridge-instance'] ?? url.searchParams.get('instance') ?? '';
  const id = String(raw).trim().slice(0, 64);
  if (id) return id;
  // Ters vekil (Dokploy/Traefik/Cloudflare) arkasında req.socket.remoteAddress
  // HER plugin için aynı proxy IP'sidir; iki ayrı sunucu tek kimlik gibi
  // görünür. İletilen istemci IP'si onları yine de ayırır. Bu değer istemci
  // kontrolündedir, dolayısıyla YALNIZ teşhis/yönlendirme içindir — kimlik
  // doğrulaması değildir (o HMAC/paylaşılan sır işidir) ve belirsizlik tespiti
  // buna tek başına güvenmez (bkz. bridgequeue.js eşzamanlı yoklama sayacı).
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return `${ANONYMOUS_INSTANCE_PREFIX}${(forwarded || ip).slice(0, 64)}`;
}

/** Public stats uçlarının kökü — site bu yolu okur, kimlik doğrulaması YOKTUR. */
export const PUBLIC_STATS_BASE = '/api/v1/stats';

/**
 * İstek gövdesini okur. 256 KB'ı aşan istek bağlantı seviyesinde kesilir
 * (Promise asla çözülmez; soket kapandığı için istek de biter).
 */
function readRawBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 256_000) req.destroy();
    });
    req.on('end', () => resolve(raw));
  });
}

/**
 * Köprü isteğini doğrular: önce HMAC imzası, yoksa (izinliyse) eski
 * X-Bridge-Secret başlığı. Dönüş: null = geçerli, aksi hâlde hata kodu.
 */
function authenticate(req, raw) {
  const sigHeaders = {
    timestamp: req.headers['x-nautilus-timestamp'],
    nonce: req.headers['x-nautilus-nonce'],
    signature: req.headers['x-nautilus-signature'],
  };
  if (sigHeaders.timestamp || sigHeaders.nonce || sigHeaders.signature) {
    const err = verifySignature(sigHeaders, raw, config.bridgeSecret);
    return err ? `unauthorized:${err}` : null;
  }
  if (config.bridgeAllowLegacy) {
    const secret = req.headers['x-bridge-secret'];
    return !secret || !safeEqual(secret, config.bridgeSecret) ? 'unauthorized' : null;
  }
  return 'unauthorized:signature_required';
}

/**
 * Köprü eventlerinin duyuru kartları — botun en görünür yüzeyi.
 *
 * Ortak kurallar:
 *  - Başlık olayı tek bakışta anlatır; test olayları da temiz başlık kullanır; toplu etiketleme kapalıdır.
 *  - En önemli bilgi (kazanan, başlangıç saati, faz) en üstte durur.
 *  - Alan adları süssüzdür; emoji yalnız başlıkta ve durum işaretlerinde.
 *  - Duyurular zaman damgalıdır: geçmişe bakıldığında ne zaman olduğu okunur.
 */
const testTitle = (_test, title) => title;

/** Takım boyutu → okunur mod adı. */
const modeLabel = (teamSize) => (teamSize > 1 ? `To${teamSize}` : 'FFA (Solo)');

const scenarioList = (scenarios) => (scenarios?.length ? clean(scenarios.join(', '), 300) : '—');

function eventEmbed(type, data, test) {
  switch (type) {
    case 'match_scheduled': {
      const e = baseEmbed(test ? Colors.warn : Colors.info)
        .setTitle(testTitle(test, '📅 Maç Planlandı'))
        .setDescription(`Sıradaki UHC maçı ${discordTime(data.startsAt, 'R')} başlıyor — `
          + `**${data.slot ?? trDateTime(data.startsAt)}** (TR).`)
        .setThumbnail(Assets.item.diamondSword)
        .setImage(Assets.wordmarkScene)
        .addFields(
          { name: 'Başlangıç', value: discordTime(data.startsAt, 'f'), inline: true },
          { name: 'Mod', value: modeLabel(data.teamSize), inline: true },
          { name: 'Host', value: clean(data.host ?? '—', 30), inline: true },
        );
      if (data.scenarios?.length) {
        e.addFields({ name: 'Senaryolar', value: scenarioList(data.scenarios), inline: false });
      }
      if (data.settings) {
        const s = data.settings;
        const line = [
          s.pvpAt != null ? `PvP ${s.pvpAt}. dk` : null,
          s.healAt != null ? `Heal ${s.healAt}. dk` : null,
          s.borderSize != null ? `Border ±${s.borderSize}` : null,
          s.latecomerWindow != null ? `Geç katılım ${s.latecomerWindow} dk` : null,
        ].filter(Boolean).join(' • ');
        if (line) e.addFields({ name: 'Ayarlar', value: line, inline: false });
      }
      return e.addFields({
        name: 'Katılım',
        value: `\`${Brand.domain}\` sunucusuna gir ve \`/maç katıl\` yaz.\n`
          + 'Katılmak için Discord hesabının bağlı olması gerekir (`/link`).',
      }).setTimestamp();
    }

    case 'match_start':
      return baseEmbed(test ? Colors.warn : Colors.success)
        .setTitle(testTitle(test, '⚔️ Maç Başladı'))
        .setDescription(`Maç \`${Brand.domain}\` sunucusunda başladı. Canlı durum için \`/maç canlı\`.`)
        .setThumbnail(Assets.item.diamondSword)
        .addFields(
          { name: 'Oyuncu', value: String(data.players ?? '—'), inline: true },
          { name: 'Host', value: clean(data.host ?? '—', 30), inline: true },
          { name: 'Senaryolar', value: scenarioList(data.scenarios), inline: true },
        )
        .setTimestamp(new Date(data.startedAt ?? Date.now()));

    case 'match_end': {
      const winner = clean(data.winner ?? '', 40);
      const e = baseEmbed(test ? Colors.warn : Colors.brand)
        .setTitle(testTitle(test, winner ? `🏆 ${winner} Kazandı` : '🏆 Maç Bitti'))
        .setThumbnail(Assets.item.goldenApple)
        .setDescription(winner
          ? `Maç sona erdi. Kazanan: **${winner}**.`
          : 'Maç sona erdi.')
        .addFields(
          { name: 'Süre', value: formatSeconds(data.durationSecs ?? 0), inline: true },
          { name: 'Katılımcı', value: String(data.participantCount ?? '—'), inline: true },
        );
      // MVP oylaması sonucu. Veri yoksa (test maçı, solo, oylama kapalı) alan
      // sessizce atlanır.
      if (data.mvpName) {
        e.addFields({
          name: 'MVP',
          value: data.mvpVotes
            ? `${clean(data.mvpName, 30)} — ${data.mvpVotes} oy, ${data.mvpKills ?? 0} kill`
            : `${clean(data.mvpName, 30)} — ${data.mvpKills ?? 0} kill`,
          inline: true,
        });
      }
      if (data.top?.length) {
        e.addFields({
          name: 'En çok kill',
          value: data.top.slice(0, 5).map((p, i) => {
            const medal = ['🥇', '🥈', '🥉'][i] ?? `**${i + 1}.**`;
            return `${medal} ${clean(p.name, 20)} — ${p.kills} kill`;
          }).join('\n'),
        });
      }
      if (data.matchId != null) {
        e.addFields({ name: 'Ayrıntı', value: `\`/maç detay ${data.matchId}\`` });
      }
      return e.setTimestamp(new Date(data.endedAt ?? Date.now()));
    }

    case 'match_cancelled':
      return baseEmbed(Colors.danger)
        .setTitle(testTitle(test, '❌ Maç İptal Edildi'))
        .setThumbnail(Assets.block.cobweb)
        .setDescription(`**${clean(data.slot ?? '?', 20)}** saatindeki maç oynanmayacak.`
          + '\nSonraki saatler için `/maç program` kullanabilirsin.')
        .addFields(
          { name: 'Host', value: clean(data.host ?? '—', 30), inline: true },
          ...(data.reason ? [{ name: 'Sebep', value: clean(data.reason, 500), inline: true }] : []),
        )
        .setTimestamp();

    case 'message':
      return baseEmbed(test ? Colors.warn : Colors.brand)
        .setTitle(clean(data.title ?? Brand.community, 200))
        .setDescription(clean(data.message || '—', 3900))
        .setTimestamp();

    // Host'un /host mesaj <metin> duyurusu — maç kanalına zengin embed.
    case 'host_message':
      return baseEmbed(test ? Colors.warn : Colors.brand)
        .setTitle(testTitle(test, '📣 Host Duyurusu'))
        .setThumbnail(Assets.mark)
        .setDescription(clean(data.message || '—', 3900))
        .setFooter(brandFooter(`Host: ${codeText(data.host ?? '—', 30)}`))
        .setTimestamp();

    // Faz değişimi — plugin yalnız pvp/border_shrink/deathmatch geçişlerini yollar
    // (start/end zaten match_start/match_end tarafından duyurulur).
    case 'phase_change': {
      const PHASES = {
        pvp: { title: '⚔️ PvP Açıldı', color: Colors.danger, desc: 'Artık oyuncular birbirine vurabilir.' },
        border_shrink: { title: '🧱 Border Daralıyor', color: Colors.warn, desc: 'Harita küçülmeye başladı.' },
        deathmatch: { title: '☠️ Deathmatch', color: Colors.danger, desc: 'Son mücadele başladı.' },
      };
      const p = PHASES[data.phase]
        ?? { title: `📢 Yeni Faz: ${clean(String(data.phase ?? '?'), 30)}`, color: Colors.info, desc: null };
      const e = baseEmbed(test ? Colors.warn : p.color)
        .setTitle(testTitle(test, p.title))
        .setThumbnail(Assets.item.ironSword)
        .addFields(
          { name: 'Hayatta', value: String(data.aliveCount ?? '—'), inline: true },
          { name: 'Geçen Süre', value: formatSeconds(data.elapsedSecs ?? 0), inline: true },
        );
      if (p.desc) e.setDescription(p.desc);
      if (data.borderSize != null) {
        e.addFields({ name: 'Border', value: `±${data.borderSize}`, inline: true });
      }
      return e.setTimestamp();
    }

    // ELO küme (tier) değişimi — kutlama/uyarı duyurusu.
    case 'tier_change': {
      const up = data.direction !== 'demote';
      return baseEmbed(test ? Colors.warn : (up ? Colors.success : Colors.warn))
        .setTitle(testTitle(test, up ? '📈 Küme Atladı' : '📉 Küme Düştü'))
        .setThumbnail(Assets.item.diamond)
        .setDescription(
          `**${clean(data.player ?? '?', 30)}** — ${clean(data.oldTier ?? '?', 20)} → `
          + `**${clean(data.newTier ?? '?', 20)}**`,
        )
        .addFields({ name: 'ELO', value: String(data.elo ?? '—'), inline: true })
        .setTimestamp();
    }

    // Oyun içi /report — staff kanalına düşer.
    case 'report_created':
      return baseEmbed(Colors.danger)
        .setTitle(testTitle(test, '🚨 Oyuncu Raporu'))
        .setThumbnail(Assets.block.cobweb)
        .addFields(
          { name: 'Raporlanan', value: clean(data.reported ?? '?', 30), inline: true },
          { name: 'Raporlayan', value: clean(data.reporter ?? '?', 30), inline: true },
          { name: 'Sebep', value: clean(data.reason || '—', 500), inline: false },
        )
        .setTimestamp();

    // MC tarafı moderasyon aynası (source=discord olanlar routing'de bastırılır).
    case 'punishment': {
      const LABELS = {
        ban: 'Ban', unban: 'Ban Kaldırıldı', mute: 'Susturma',
        unmute: 'Susturma Kaldırıldı', kick: 'Sunucudan Atıldı', warn: 'Uyarı',
      };
      const label = LABELS[data.action] ?? clean(String(data.action ?? '?'), 20);
      const e = baseEmbed(data.action === 'ban' ? Colors.danger : Colors.warn)
        .setTitle(testTitle(test, `🔨 MC Ceza — ${label}`))
        .addFields(
          { name: 'Oyuncu', value: clean(data.player ?? '?', 30), inline: true },
          { name: 'Yetkili', value: clean(data.staff ?? '?', 30), inline: true },
        );
      if (data.action === 'ban' || data.action === 'mute') {
        e.addFields({
          name: 'Süre',
          value: data.durationMs ? formatSeconds(Math.round(data.durationMs / 1000)) : 'Kalıcı',
          inline: true,
        });
      }
      return e.addFields({ name: 'Sebep', value: clean(data.reason || '—', 500), inline: false })
        .setTimestamp();
    }

    // MC↔DC bağlantısı kaldırıldı (source=discord olanlar routing'de bastırılır).
    case 'link_removed':
      return baseEmbed(Colors.info)
        .setTitle(testTitle(test, '🔗 Hesap Bağlantısı Kaldırıldı'))
        .setDescription(
          `\`${codeText(data.mc ?? '?', 30)}\` ↔ <@${data.discordId ?? '?'}> bağlantısı oyun tarafında kaldırıldı.`,
        )
        .setTimestamp();

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
  if (!test && (type === 'match_scheduled' || (type === 'match_start' && !data.plannedAnnouncement))) {
    content = '@everyone';
    allowedMentions.parse = ['everyone'];
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
    const url = new URL(req.url ?? '/', 'http://nautilus.local');
    const path = url.pathname;
    const ip = req.socket?.remoteAddress ?? '?';

    if (serveResourcePack(req, res, path)) return;

    /* ---------------- Public stats (kimlik doğrulaması YOK) --------------- */
    // Site bu uçları okur. Salt-okunur, beyaz listeli ve önbellekli; veriyi
    // ters köprü kuyruğu üzerinden plugin'den alır.
    if (path === PUBLIC_STATS_BASE || path.startsWith(`${PUBLIC_STATS_BASE}/`)) {
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
        return res.end(JSON.stringify({ error: 'method_not_allowed' }));
      }
      // Public uç herkese açık: event kuyruğundan ayrı, daha geniş bir limit.
      if (rateLimited(ip, { limit: 300, bucket: 'stats' })) {
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
        return res.end(JSON.stringify({ error: 'rate_limited' }));
      }
      return publicStats(path.slice(PUBLIC_STATS_BASE.length), url.search)
        .then(({ status, body, stale }) => {
          res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=10',
            ...(stale ? { 'X-Nautilus-Stale': '1' } : {}),
            ...cors,
          });
          res.end(JSON.stringify(body));
        });
    }

    /* ---------------- Ters köprü: plugin uzun-yoklaması ------------------- */
    if (path === '/api/bridge/jobs' && req.method === 'GET') {
      if (!config.bridgeSecret) return respond(401, { ok: false, error: 'unauthorized' });
      // Uzun-yoklama açık bir bağlantı tutar; event limitine takılmasın diye
      // kendi kovasında sayılır.
      if (rateLimited(ip, { limit: 120, bucket: 'poll' })) {
        return respond(429, { ok: false, error: 'rate_limited' });
      }
      const authErr = authenticate(req, '');
      if (authErr) return respond(401, { ok: false, error: authErr });
      // DİKKAT: `|| MAX` yazılamaz — wait=0 ("hemen dön") falsy olduğu için
      // 25 sn'lik varsayılana düşer ve istek boşuna asılı kalırdı.
      const asked = Number(url.searchParams.get('wait'));
      const wait = Number.isFinite(asked) && asked >= 0
        ? Math.min(asked, MAX_POLL_WAIT_MS)
        : MAX_POLL_WAIT_MS;
      const instanceId = pollInstanceId(req, url, ip);
      // Plugin 1.2.2 hesap bağlama protokolünü bildirir; eski pluginler 0 sayılır.
      const linkProtocol = Number.parseInt(String(req.headers['x-bridge-link-protocol'] ?? '0'), 10) || 0;
      // Plugin yeniden başlar ya da ağ koparsa bağlantı kapanır; yoklamayı
      // kuyruktan hemen düşürmek için iptal sinyali veriyoruz. Terk edilmiş
      // yoklamaların açık sayılması "birden fazla plugin" yanlış pozitifine
      // yol açardı (bkz. bridgequeue.js).
      const aborter = new AbortController();
      req.on('close', () => aborter.abort());
      return bridgeQueue.takeJobs(wait, { instanceId, signal: aborter.signal, linkProtocol })
        .then((jobs) => {
          if (aborter.signal.aborted) return undefined; // istemci gitti
          return respond(200, { ok: true, jobs, instanceId });
        });
    }

    if (path === '/api/bridge/jobs/result' && req.method === 'POST') {
      if (!config.bridgeSecret) return respond(401, { ok: false, error: 'unauthorized' });
      if (rateLimited(ip, { limit: 600, bucket: 'poll' })) {
        return respond(429, { ok: false, error: 'rate_limited' });
      }
      return readRawBody(req).then((raw) => {
        const authErr = authenticate(req, raw);
        if (authErr) return respond(401, { ok: false, error: authErr });
        let payload;
        try {
          payload = JSON.parse(raw || '{}');
        } catch {
          return respond(400, { ok: false, error: 'bad_json' });
        }
        const sender = pollInstanceId(req, url, ip);
        const outcome = bridgeQueue.completeJobFrom(payload.jobId, payload.status, payload.data, sender);
        if (outcome === 'wrong_instance') {
          // İş başka bir instance'a teslim edilmişti: bu sonuç bekleyeni ÇÖZMEZ.
          console.warn(`[bridge] iş sonucu hedef dışı instance'tan geldi, reddedildi (iş=${payload.jobId} gönderen=${sender})`);
          return respond(409, { ok: false, error: 'wrong_instance' });
        }
        if (outcome === 'late') {
          const info = bridgeQueue.lateResultInfo(payload.jobId);
          console.warn(`[bridge] zaman aşımına uğramış işin sonucu geç geldi (iş=${payload.jobId} yol=${info?.path ?? '-'}`
            + ` hedef=${info?.targetInstance ?? '-'} alan=${info?.claimedBy ?? '-'} gönderen=${sender} status=${payload.status})`);
          return respond(200, { ok: true, unknown: true, late: true });
        }
        // İş bilinmiyorsa (zaman aşımına uğramış) 200 döneriz: plugin'in bunu
        // tekrar denemesinin bir anlamı yok, çağıran taraf çoktan vazgeçti.
        return respond(200, { ok: true, unknown: outcome !== 'completed' });
      });
    }

    if (req.method !== 'POST' || path !== '/api/event') {
      return respond(404, { ok: false, error: 'not_found' });
    }

    if (rateLimited(ip)) {
      return respond(429, { ok: false, error: 'rate_limited', mesaj: 'Çok fazla istek; kısa süre sonra tekrar dene.' });
    }
    if (!config.bridgeSecret) {
      return respond(401, { ok: false, error: 'unauthorized' });
    }

    readRawBody(req).then(async (raw) => {
      // ---- Auth: önce HMAC, yoksa (izinliyse) legacy shared secret ----
      const authErr = authenticate(req, raw);
      if (authErr) return respond(401, { ok: false, error: authErr });

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
