/**
 * Central configuration. Everything comes from environment variables so the bot
 * can be deployed on Coolify without touching code; the Nautilus PvP guild and
 * channel/role ids ship as defaults.
 */

function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function required(name) {
  const v = env(name);
  if (!v) {
    console.error(`[config] Eksik ortam değişkeni: ${name}`);
    process.exit(1);
  }
  return v;
}

/** Kendi kendine istek atmayı ele veren döngüsel adresler. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', '::']);

function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * MC_API_URL (eski doğrudan-bağlantı yedeği) doğrulaması.
 *
 * Kurallar:
 *  - BOŞ = geçerli. Ters köprü (outbound) modunda plugin bota bağlanır, bu
 *    değişkene hiç ihtiyaç duyulmaz; önerilen kurulum budur.
 *  - Doluysa MUTLAK bir http:// veya https:// adresi olmalıdır.
 *  - Botun KENDİ public adresini gösteremez. Aksi hâlde bot `/api/link/verify`
 *    isteğini kendine atar, kendi HTTP sunucusu bu yolu tanımadığı için
 *    `404 {"error":"not_found"}` döner ve oyuncuya sahte bir "kod geçersiz"
 *    mesajı gösterilirdi. Bu durumda doğrudan yedek KAPATILIR.
 *
 * Saf fonksiyondur (test edilebilir); yan etkisi yoktur.
 *
 * @returns {{ url: string, error: string|null, code: string|null, selfLoop: boolean }}
 */
export function validateMcApiUrl(raw, { port = 25000, botPublicUrl = '' } = {}) {
  const value = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!value) return { url: '', error: null, code: null, selfLoop: false };

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return {
      url: '',
      code: 'mc_api_url_not_absolute',
      selfLoop: false,
      error: `MC_API_URL mutlak bir adres değil: "${value}". `
        + 'Ya tamamen boş bırak (önerilen: ters köprü), ya da http:// veya https:// ile '
        + 'başlayan tam bir adres yaz (örn. http://10.0.0.5:25000).',
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      url: '',
      code: 'mc_api_url_bad_scheme',
      selfLoop: false,
      error: `MC_API_URL yalnızca http:// veya https:// olabilir (verilen: ${parsed.protocol}//). `
        + 'Ters köprü kullanıyorsan bu değişkeni boş bırak.',
    };
  }

  const host = parsed.hostname.toLowerCase();
  const botHost = hostOf(botPublicUrl);
  const urlPort = parsed.port ? Number.parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);

  if (botHost && host === botHost) {
    return {
      url: '',
      code: 'mc_api_url_self_loop',
      selfLoop: true,
      error: `MC_API_URL botun KENDİ adresini gösteriyor (${host}). Bot kendi `
        + '/api/link/verify ucuna istek atamaz: kendi HTTP sunucusu bu yolu tanımaz ve '
        + '404 döner, oyuncu da sahte "kod geçersiz" mesajı görür. MC_API_URL\'i BOŞ bırak '
        + '(ters köprü) ya da Minecraft sunucusunun adresini yaz. Doğrudan bağlantı yedeği kapatıldı.',
    };
  }
  if (LOOPBACK_HOSTS.has(host) && urlPort === Number(port)) {
    return {
      url: '',
      code: 'mc_api_url_self_loop',
      selfLoop: true,
      error: `MC_API_URL botun kendi dinlediği portu gösteriyor (${host}:${urlPort}). `
        + 'Bu, botun kendi kendine istek atmasına ve sahte "kod geçersiz" hatalarına yol açar. '
        + 'MC_API_URL\'i BOŞ bırak (ters köprü). Doğrudan bağlantı yedeği kapatıldı.',
    };
  }
  return { url: value, error: null, code: null, selfLoop: false };
}

const port = Number.parseInt(env('PORT', '25000'), 10);

/**
 * Botun dışarıdan erişilen adresi (Dokploy/Coolify domaini, plugin'in
 * `bridge.bot-url` değeri). Yalnız teşhis içindir: MC_API_URL yanlışlıkla bu
 * adrese ayarlandığında açılışta yakalanır.
 */
const botPublicUrl = env('BOT_PUBLIC_URL', '').replace(/\/+$/, '');

const mcApi = validateMcApiUrl(env('MC_API_URL', ''), { port, botPublicUrl });

export const config = {
  token: required('DISCORD_TOKEN'),

  /** The ONLY guild this bot will ever serve. It leaves everything else. */
  guildId: env('GUILD_ID', '1521979737201836233'),

  /** Match announcements (schedule / start / result / test) land here. */
  matchChannelId: env('MATCH_CHANNEL_ID', '1522216307809063154'),

  /** The account-link panel (button + modal) is posted here. */
  linkChannelId: env('LINK_CHANNEL_ID', '1522335045593858228'),

  /** Moderation & security log channel (can be overridden with /admin logkanal). */
  logChannelId: env('LOG_CHANNEL_ID', ''),

  roles: {
    kurucu: env('ROLE_KURUCU', '1522149038298894450'),
    admin: env('ROLE_ADMIN', '1522149134830800946'),
    bmod: env('ROLE_BMOD', '1522149269568622733'),
    mod: env('ROLE_MOD', '1522149408555139072'),
    rehber: env('ROLE_REHBER', '1522149952527138889'),
  },

  /**
   * Base URL of the NautilusUHC plugin bridge API (Pelican Panel host), e.g.
   * http://1.2.3.4:25000. Doğrulamayı geçemezse BOŞ kalır ve doğrudan yedek
   * kapatılır (bkz. directFallbackDisabled).
   */
  mcApiUrl: mcApi.url,

  /** MC_API_URL doğrulama hatası (yoksa null). Açılışta loglanır. */
  mcApiUrlError: mcApi.error,

  /**
   * true iken mcapi ASLA doğrudan HTTP'ye düşmez. Yanlış yapılandırılmış bir
   * adrese sessizce istek atıp anlamsız 404'ler üretmektense açık hata veririz.
   */
  directFallbackDisabled: Boolean(mcApi.error),

  /** Botun public adresi (teşhis/döngü tespiti). */
  botPublicUrl,

  /**
   * Public base URL of the NautilusUHC website. The site serves its branding and
   * Minecraft item icons under /assets, which the bot reuses in embeds so Discord
   * and the website share one visual identity. No trailing slash.
   */
  siteUrl: env('SITE_URL', 'https://nautilusuhc.com').replace(/\/+$/, ''),

  /** Shared secret between the bot and the plugin (both directions). */
  bridgeSecret: env('BRIDGE_SECRET', ''),

  /**
   * Geçiş modu: HMAC imzasız (yalnız X-Bridge-Secret başlıklı) eski plugin
   * isteklerini kabul et. Plugin HMAC'e geçtikten sonra BRIDGE_ALLOW_LEGACY=0
   * yapılmalı. (bkz. docs/INTEGRATION-CONTRACT.md)
   */
  bridgeAllowLegacy: env('BRIDGE_ALLOW_LEGACY', '1') === '1',

  /** HMAC imzalı isteklerde kabul edilen saat sapması / replay penceresi (ms). */
  bridgeReplayWindowMs: Number.parseInt(env('BRIDGE_REPLAY_WINDOW_MS', '300000'), 10),

  /**
   * HTTP port the bot listens on for plugin events (Dokploy/Coolify exposes
   * it). Nautilus altyapısında köprü için ayrılan port: 25000.
   */
  port,

  dbPath: env('DB_PATH', 'data/bot.db'),

  timezone: 'Europe/Istanbul',
};

/**
 * Açılışta yapılandırma sorunlarını gürültülü şekilde bildirir. Sessiz yanlış
 * yapılandırma, kullanıcıya sahte "kod geçersiz" hatası olarak yansıdığı için
 * bu satırlar bilerek ERROR seviyesindedir.
 *
 * @returns {string[]} bildirilen sorunlar (test edilebilirlik için)
 */
export function logConfigIssues(logger = console, cfg = config) {
  const issues = [];
  if (cfg.mcApiUrlError) issues.push(cfg.mcApiUrlError);
  if (!cfg.bridgeSecret) {
    issues.push('BRIDGE_SECRET boş. Plugin köprüsü kimlik doğrulaması yapamaz; '
      + 'plugin config.yml > bridge.token ile birebir aynı değeri gir.');
  }
  for (const issue of issues) logger.error(`[config] ${issue}`);
  return issues;
}
