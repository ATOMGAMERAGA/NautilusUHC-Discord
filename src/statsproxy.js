import { bridgeQueue } from './bridgequeue.js';

/**
 * PUBLIC STATS PROXY — sitenin okuduğu salt-okunur istatistik API'si.
 *
 * Eskiden site doğrudan Minecraft sunucusunun açık portuna giderdi
 * (MC_STATS_API=http://<mc-ip>:25000). O port DDoS hedefi olduğu için artık
 * KAPALI: site bu bota gelir, bot da veriyi ters köprü kuyruğu üzerinden
 * plugin'den ister. Minecraft sunucusunda hiçbir port açık değildir.
 *
 *   tarayıcı → site (nautilusuhc.com) → bot (bot.nautilusuhc.com)
 *            → [iş kuyruğu] → plugin (dışa açılan bağlantı üzerinden)
 *
 * Sitenin kendi önbelleği zaten var; buradaki ikinci önbellek Minecraft
 * sunucusunu korur (aynı anda kaç istek gelirse gelsin plugin'e TTL başına
 * en fazla bir sorgu gider).
 */

/** Uç bazında önbellek süresi (ms). */
const TTL_MS = {
  '/live': 5_000,
  '/schedule': 30_000,
};
const DEFAULT_TTL_MS = 15_000;

/** Plugin ulaşılamazken bayat veriyi en fazla bu kadar süre sunarız. */
const STALE_MAX_MS = 10 * 60_000;

/**
 * Bu uçlar için iş zaman aşımı. Sitenin kendi upstream zaman aşımı 8 sn;
 * ondan ÖNCE vazgeçmemiz gerekir ki bayat önbelleğe düşme şansımız olsun,
 * yoksa site biz cevap veremeden bağlantıyı keser.
 */
const STATS_JOB_TIMEOUT_MS = 6000;

/**
 * İzin verilen public uçlar. Beyaz liste ZORUNLUDUR: bu uç kimlik doğrulaması
 * istemediği için, serbest bırakılırsa plugin'in token'lı yönetim API'sine
 * (/api/mod, /api/links …) tünel olarak kullanılabilirdi.
 */
const ALLOWED = [
  /^$/,
  /^\/$/,
  /^\/live$/,
  /^\/schedule$/,
  /^\/leaderboard$/,
  /^\/player$/,
  /^\/player\/matches$/,
  /^\/matches$/,
  /^\/match\/\d+$/,
];

export function isAllowedStatsPath(pathname) {
  return ALLOWED.some((re) => re.test(pathname));
}

const cache = new Map(); // key -> { at, status, body }

function ttlFor(pathname) {
  return TTL_MS[pathname] ?? DEFAULT_TTL_MS;
}

/**
 * @param {string} pathname public base'e GÖRE yol, örn. "/leaderboard"
 * @param {string} search   sorgu dizesi, örn. "?stat=elo&topN=10" (boş olabilir)
 * @returns {Promise<{status:number, body:object, stale?:boolean}>}
 */
export async function publicStats(pathname, search = '', { queue = bridgeQueue, now = Date.now } = {}) {
  if (!isAllowedStatsPath(pathname)) {
    return { status: 404, body: { error: 'not_found' } };
  }
  const key = pathname + search;
  const hit = cache.get(key);
  const at = now();
  if (hit && at - hit.at < ttlFor(pathname)) {
    return { status: hit.status, body: hit.body };
  }

  try {
    // Plugin hiç bağlı değilse beklemenin anlamı yok: 6 sn boyunca siteyi
    // oyalamak yerine hemen bayat önbelleğe/503'e düşeriz.
    if (queue.pluginConnected && !queue.pluginConnected()) {
      throw new Error('plugin köprüye bağlı değil');
    }
    const res = await queue.enqueue(
      { method: 'GET', path: `/api/v1/stats${pathname}${search}` },
      STATS_JOB_TIMEOUT_MS,
    );
    // 5xx'i önbelleğe almayız: geçici bir plugin hatası TTL boyunca
    // yapışıp kalmasın.
    if (res.status < 500) {
      cache.set(key, { at, status: res.status, body: res.data });
    }
    return { status: res.status, body: res.data };
  } catch (err) {
    // Plugin bağlı değil / zaman aşımı. Elimizde bayat veri varsa siteyi boş
    // bırakmaktansa onu sunarız (site "veri yok" yerine son bilinen sıralamayı
    // gösterir); yoksa dürüstçe 503 döneriz.
    if (hit && at - hit.at < STALE_MAX_MS) {
      return { status: hit.status, body: hit.body, stale: true };
    }
    return {
      status: 503,
      body: { error: 'mc_unavailable', mesaj: `Minecraft sunucusuna şu an ulaşılamıyor. (${err.message})` },
    };
  }
}

/** Testler için önbelleği boşaltır. */
export function resetStatsCache() {
  cache.clear();
}
