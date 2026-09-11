import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { bridgeQueue } from './bridgequeue.js';

/**
 * NautilusUHC plugin köprüsünün istemcisi. Hatalar fırlatılmaz; komut
 * işleyicileri temiz bir Türkçe mesaj gösterebilsin diye
 * `{ ok: false, errorCode, error, status? }` olarak çözülür.
 *
 * İKİ TAŞIMA MODU vardır:
 *
 *  1. TERS KÖPRÜ (varsayılan, önerilen) — plugin bota bağlanıp iş çeker.
 *     Minecraft sunucusunda HİÇBİR port açılmaz, dolayısıyla DDoS yüzeyi yok.
 *     Plugin uzun-yoklama yaptığı sürece (bridgeQueue.pluginConnected()) tüm
 *     istekler kuyruk üzerinden gider ve MC_API_URL'e hiç ihtiyaç duyulmaz.
 *
 *  2. DOĞRUDAN (eski) — MC_API_URL ayarlıysa ve plugin ters köprüye bağlı
 *     değilse, plugin'in açık portuna doğrudan HTTP yapılır. Yalnızca geçiş
 *     dönemi içindir; MC_API_URL'i boş bırakmak artık tavsiye edilir.
 *
 * HATA KODU SÖZLEŞMESİ
 * --------------------
 * Backend'in MAKİNE OKUNUR hata kodu (`{"error":"invalid_code"}`) `errorCode`
 * alanında AYNEN korunur. Çağıranlar kararlarını buna göre verir; HTTP
 * status'una bakarak "kod geçersiz" gibi anlamlar ÜRETİLMEZ (404 pekâlâ
 * "yanlış uç", "yanlış servis" ya da "route yok" demek olabilir).
 *
 * Taşıma katmanının kendi ürettiği kodlar (backend'den gelmeyenler):
 *   plugin_not_connected      ters köprü bağlı değil, MC_API_URL de boş
 *   bridge_misconfigured      MC_API_URL doğrulamayı geçemedi (doğrudan yedek kapalı)
 *   multiple_plugin_instances köprüde birden fazla plugin var → hedef belirsiz
 *   bridge_timeout            iş zaman aşımına uğradı
 *   bridge_unreachable        doğrudan HTTP bağlantısı kurulamadı
 *   bad_gateway_response      yanıt JSON değil
 */

const TIMEOUT_MS = 8000;

/** Backend'in "bu kod yanlış/süresi dolmuş" dediği TEK kodlar. */
export const BAD_CODE_ERRORS = Object.freeze(['invalid_code', 'expired_code']);

/** Log satırında sorgu dizesi taşınmaz (oyuncu adı/discord id gürültüsü). */
function logPath(path) {
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

/**
 * mcapi istemcisi üretir. Bağımlılıklar enjekte edilebilir — testler gerçek
 * kuyruğa/ağa dokunmadan tüm hata yollarını sürebilir.
 */
export function createMcApi({
  queue = bridgeQueue,
  cfg = config,
  fetchImpl = (...args) => fetch(...args),
  logger = console,
  now = () => Date.now(),
  newId = () => randomUUID().slice(0, 8),
} = {}) {
  /**
   * Köprünün şu anki durumu. `requireSingleInstance` hesap bağlama gibi
   * yan etkili işlemler içindir: köprüde birden fazla plugin varsa iş
   * RASTGELE birine gitmemelidir.
   *
   * @returns {{ok:boolean, transport:'reverse'|'direct'|'none', errorCode?:string, error?:string, instances?:string[]}}
   */
  function bridgeStatus({ requireSingleInstance = false } = {}) {
    if (queue.pluginConnected()) {
      const instances = queue.activeInstances?.() ?? [];
      if (requireSingleInstance && instances.length > 1) {
        return {
          ok: false,
          transport: 'reverse',
          instances,
          errorCode: 'multiple_plugin_instances',
          error: `Köprüye ${instances.length} plugin instance bağlı; isteğin hangisine gideceği belirsiz. `
            + 'Çözüm: fazladan Minecraft sunucusunu/konteynerini kapat ya da her instance\'a ayrı '
            + 'BRIDGE_INSTANCE_ID ver ve yalnız birini bu bota bağla.',
        };
      }
      return { ok: true, transport: 'reverse', instances };
    }
    if (cfg.directFallbackDisabled) {
      return {
        ok: false,
        transport: 'none',
        errorCode: 'bridge_misconfigured',
        error: cfg.mcApiUrlError ?? 'MC_API_URL geçersiz; doğrudan bağlantı yedeği kapalı.',
      };
    }
    if (!cfg.mcApiUrl) {
      return {
        ok: false,
        transport: 'none',
        errorCode: 'plugin_not_connected',
        error: 'Minecraft plugin\'i köprüye bağlı değil (son yoklama yok) ve MC_API_URL boş.',
      };
    }
    return { ok: true, transport: 'direct' };
  }

  /**
   * Hedefli iş yazılabilecek instance. Yalnız TEK ve AÇIK kimlikli (eski
   * pluginlerin IP'den türetilmiş kimliği değil) instance varsa döner.
   */
  function targetableInstance(instances = []) {
    if (instances.length !== 1) return null;
    const id = instances[0];
    return id.startsWith('ip:') ? null : id;
  }

  /** Plugin'in yanıtını mcapi sözleşmesine ({ok, ...}) çevirir. */
  function shape(status, data, meta) {
    if (status >= 400) {
      const errorCode = typeof data?.error === 'string' && data.error ? data.error : `http_${status}`;
      return {
        ok: false,
        status,
        errorCode,
        error: data?.error || `Sunucu hatası (${status}).`,
        ...meta,
      };
    }
    return { ok: true, ...data, ...meta };
  }

  /**
   * Tek satırlık teşhis logu. KODU, discord token'ını ve BRIDGE_SECRET'ı ASLA
   * içermez: yalnız korelasyon kimliği, taşıma, yol, status, hata kodu ve süre.
   */
  function logResult({ correlationId, transport, method, path, status, errorCode, startedAt }) {
    const ms = now() - startedAt;
    const line = `[mcapi] ${correlationId} ${transport} ${method} ${logPath(path)}`
      + ` → ${status ?? '-'}${errorCode ? ` ${errorCode}` : ''} ${ms}ms`;
    if (errorCode) logger.warn(line);
    else logger.log(line);
  }

  /**
   * @param {string} path
   * @param {{method?:string, body?:object, requireSingleInstance?:boolean, timeoutMs?:number}} [opts]
   */
  async function request(path, {
    method = 'GET', body, requireSingleInstance = false, timeoutMs = TIMEOUT_MS,
  } = {}) {
    const correlationId = newId();
    const startedAt = now();
    const status = bridgeStatus({ requireSingleInstance });

    if (!status.ok) {
      logResult({
        correlationId, transport: status.transport, method, path, errorCode: status.errorCode, startedAt,
      });
      // Yapılandırma/ortam hatasının ayrıntısı yalnız logda kalır; çağıran
      // yalnız makine kodunu görür ve kullanıcıya sınıflandırılmış metin yazar.
      logger.warn(`[mcapi] ${correlationId} ${status.error}`);
      return {
        ok: false, errorCode: status.errorCode, error: status.error, transport: status.transport, correlationId,
      };
    }

    /* 1) Ters köprü — plugin aktif olarak yokluyorsa her zaman bunu tercih et. */
    if (status.transport === 'reverse') {
      const targetInstance = requireSingleInstance ? targetableInstance(status.instances) : null;
      try {
        const res = await queue.enqueue({
          method, path, body: body ?? null, targetInstance,
        }, timeoutMs);
        const shaped = shape(res.status, res.data, { transport: 'reverse', correlationId });
        logResult({
          correlationId,
          transport: 'reverse',
          method,
          path,
          status: res.status,
          errorCode: shaped.ok ? null : shaped.errorCode,
          startedAt,
        });
        return shaped;
      } catch (err) {
        const errorCode = /zaman aşımı/i.test(err.message) ? 'bridge_timeout' : 'bridge_unreachable';
        logResult({ correlationId, transport: 'reverse', method, path, errorCode, startedAt });
        return {
          ok: false,
          errorCode,
          error: `Minecraft sunucusuna ulaşılamadı (${err.message}).`,
          transport: 'reverse',
          correlationId,
        };
      }
    }

    /* 2) Doğrudan (eski) mod. */
    try {
      const res = await fetchImpl(cfg.mcApiUrl + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.bridgeSecret}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          logResult({
            correlationId, transport: 'direct', method, path, status: res.status, errorCode: 'bad_gateway_response', startedAt,
          });
          return {
            ok: false,
            status: res.status,
            errorCode: 'bad_gateway_response',
            error: `Sunucudan geçersiz yanıt (${res.status}).`,
            transport: 'direct',
            correlationId,
          };
        }
      }
      const shaped = shape(res.status, data, { transport: 'direct', correlationId });
      logResult({
        correlationId,
        transport: 'direct',
        method,
        path,
        status: res.status,
        errorCode: shaped.ok ? null : shaped.errorCode,
        startedAt,
      });
      return shaped;
    } catch (err) {
      const timedOut = err.name === 'TimeoutError';
      const errorCode = timedOut ? 'bridge_timeout' : 'bridge_unreachable';
      logResult({ correlationId, transport: 'direct', method, path, errorCode, startedAt });
      return {
        ok: false,
        errorCode,
        error: `Minecraft sunucusuna ulaşılamadı (${timedOut ? 'zaman aşımı' : err.message}).`,
        transport: 'direct',
        correlationId,
      };
    }
  }

  return {
    request,
    bridgeStatus,

    ping: () => request('/api/ping'),
    status: () => request('/api/status'),

    /* Account linking — the plugin is the source of truth. */
    linkVerify: (code, discordId, discordTag) => request('/api/link/verify', {
      method: 'POST',
      body: { code, discordId, discordTag },
      // Yan etkili: belirsiz instance'a asla gönderilmez.
      requireSingleInstance: true,
    }),
    linkStatus: (query) => request(`/api/link/status?${query}`),
    linkDelete: (type, value) => request('/api/link', {
      method: 'DELETE', body: { type, value }, requireSingleInstance: true,
    }),

    /* Minecraft moderation. */
    mod: (action, player, { reason, durationMs } = {}) => request('/api/mod', {
      method: 'POST',
      body: { action, player, reason, durationMs },
      requireSingleInstance: true,
    }),

    /* Match data. */
    currentMatch: () => request('/api/match/current'),
    matches: (limit = 10) => request(`/api/matches?limit=${limit}`),
    matchDetail: (id) => request(`/api/match/${encodeURIComponent(id)}`),
    matchInventory: (id, player) => request(
      `/api/match/${encodeURIComponent(id)}/inventory?player=${encodeURIComponent(player)}`,
    ),
    schedule: () => request('/api/schedule'),

    /* Lifetime stats & profile. */
    statsPlayer: (query) => request(`/api/stats/player?${query}`),
    statsTop: (by = 'elo', limit = 10) => request(
      `/api/stats/top?by=${encodeURIComponent(by)}&limit=${limit}`,
    ),

    /* Faz 7: genişletilmiş köprü yüzeyi. */
    capabilities: () => request('/api/capabilities'),
    teams: () => request('/api/teams'),
    perf: () => request('/api/server/perf'),
    scenarios: () => request('/api/scenarios'),
    queue: () => request('/api/queue'),
    modHistory: (player) => request(`/api/mod/history?player=${encodeURIComponent(player)}`),
    modList: (type) => request(`/api/mod/list?type=${encodeURIComponent(type)}`),
    links: () => request('/api/links'),
  };
}

/** Süreç genelinde tek istemci. */
export const mcapi = createMcApi();
