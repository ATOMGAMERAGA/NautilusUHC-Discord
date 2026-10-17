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
 *
 * HESAP BAĞLAMA PROTOKOLÜ 2 (plugin 1.2.2)
 * ----------------------------------------
 * `/api/link/v2/*` uçları yanıtlayan instance kimliğini (`instance`) ve istek
 * kimliğini (`requestId`) geri taşır. Yazma uçları (verify/unlink) hedef
 * instance verilmeden çoklu köprüde gönderilmez.
 */

const TIMEOUT_MS = 8000;

/** Yazma yapan bağlantı işlemleri DB kilidi + dosya kilidi bekleyebilir. */
export const LINK_WRITE_TIMEOUT_MS = 12_000;

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
  readTimeoutMs = TIMEOUT_MS,
  linkWriteTimeoutMs = LINK_WRITE_TIMEOUT_MS,
} = {}) {
  /**
   * Köprünün şu anki durumu. `requireSingleInstance` hesap bağlama gibi
   * yan etkili işlemler içindir: köprüde birden fazla plugin varsa iş
   * RASTGELE birine gitmemelidir.
   *
   * @returns {{ok:boolean, transport:'reverse'|'direct'|'none', errorCode?:string, error?:string, instances?:string[], instanceMeta?:object[]}}
   */
  function bridgeStatus({ requireSingleInstance = false } = {}) {
    if (queue.pluginConnected()) {
      // routingAmbiguity yoksa (sade bir kuyruk taklidi) kimlik sayımına düş —
      // sinyali sessizce kaybetmek, belirsizliği görmezden gelmek olurdu.
      const routing = queue.routingAmbiguity?.() ?? (() => {
        const instances = queue.activeInstances?.() ?? [];
        return {
          ambiguous: instances.length > 1,
          reason: instances.length > 1 ? 'instances' : null,
          instances,
          pollers: instances.length,
        };
      })();
      const { instances } = routing;
      const instanceMeta = queue.instanceMeta?.() ?? null;
      if (requireSingleInstance && routing.ambiguous) {
        // Belirsizlik iki yoldan tespit edilir; ikisi de gerçek bir ikinci
        // plugin sürecine işaret eder (bkz. bridgequeue.js).
        const detail = routing.reason === 'instances'
          ? `${instances.length} farklı BRIDGE_INSTANCE_ID`
          : `aynı anda ${Math.max(routing.pollers, routing.peakPollers ?? 2)} açık uzun-yoklama`;
        return {
          ok: false,
          transport: 'reverse',
          instances,
          instanceMeta,
          routing,
          errorCode: 'multiple_plugin_instances',
          error: `Köprüye birden fazla plugin bağlı (${detail}); isteğin hangisine gideceği belirsiz. `
            + 'Kodu ÜRETEN sunucu ile doğrulayan sunucu farklı olursa oyuncu doğru kodu girdiği hâlde '
            + '"invalid_code" görür. Çözüm: fazladan Minecraft sunucusunu/konteynerini kapat ya da '
            + 'her instance\'a ayrı BRIDGE_INSTANCE_ID ver ve yalnız birini bu bota bağla.',
        };
      }
      return { ok: true, transport: 'reverse', instances, instanceMeta, routing };
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
        ...(data && typeof data === 'object' ? data : {}),
        ok: false,
        status,
        errorCode,
        error: data?.error || `Sunucu hatası (${status}).`,
        ...meta,
      };
    }
    return { ok: true, status, ...data, ...meta };
  }

  /**
   * Tek satırlık teşhis logu. KODU, discord token'ını ve BRIDGE_SECRET'ı ASLA
   * içermez: yalnız korelasyon kimliği, taşıma, yol, status, hata kodu ve süre.
   */
  function logResult({
    correlationId, transport, method, path, status, errorCode, startedAt, claimedBy, pollId, target,
  }) {
    const ms = now() - startedAt;
    // claimedBy süreç kimliğidir; pollId ise her uzun-yoklamada doğal olarak
    // değişir. İkisini logları ilişkilendirmek için taşıyoruz fakat çoklu
    // plugin kararı yalnız claimedBy/instance sinyaliyle verilebilir.
    const who = [
      target ? `hedef=${target}` : null,
      claimedBy ? `inst=${claimedBy}` : null,
      pollId ? `poll=${pollId}` : null,
    ].filter(Boolean).join(' ');
    const line = `[mcapi] ${correlationId} ${transport} ${method} ${logPath(path)}`
      + ` → ${status ?? '-'}${errorCode ? ` ${errorCode}` : ''}${who ? ` ${who}` : ''} ${ms}ms`;
    if (errorCode) logger.warn(line);
    else logger.log(line);
  }

  /**
   * @param {string} path
   * @param {{method?:string, body?:object, requireSingleInstance?:boolean, targetInstance?:string|null, timeoutMs?:number}} [opts]
   */
  async function request(path, {
    method = 'GET', body, requireSingleInstance = false, targetInstance = null,
    timeoutMs = readTimeoutMs,
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
      const queueTarget = targetInstance
        ?? (requireSingleInstance ? targetableInstance(status.instances) : null);
      try {
        const res = await queue.enqueue({
          method, path, body: body ?? null, targetInstance: queueTarget,
        }, timeoutMs);
        // Voice state is destructive authority: another server appearing while
        // this read awaited its response makes that state unsafe to apply.
        const completedStatus = path === '/api/voice'
          ? bridgeStatus({ requireSingleInstance: true }) : null;
        const ambiguity = completedStatus?.errorCode === 'multiple_plugin_instances'
          ? completedStatus : null;
        const shaped = ambiguity ? {
          ok: false, errorCode: ambiguity.errorCode, error: ambiguity.error,
          transport: 'reverse', correlationId,
        } : shape(res.status, res.data, {
          transport: 'reverse', correlationId, claimedBy: res.claimedBy, pollId: res.claimedPollId,
        });
        logResult({
          correlationId,
          transport: 'reverse',
          method,
          path,
          status: res.status,
          errorCode: shaped.ok ? null : shaped.errorCode,
          startedAt,
          claimedBy: res.claimedBy,
          pollId: res.claimedPollId,
          target: queueTarget,
        });
        return shaped;
      } catch (err) {
        const errorCode = /zaman aşımı/i.test(err.message) ? 'bridge_timeout' : 'bridge_unreachable';
        logResult({
          correlationId, transport: 'reverse', method, path, errorCode, startedAt, target: queueTarget,
        });
        return {
          ok: false,
          errorCode,
          error: `Minecraft sunucusuna ulaşılamadı (${err.message}).`,
          transport: 'reverse',
          correlationId,
          target: queueTarget,
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

  const query = (params) => Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');

  return {
    request,
    bridgeStatus,

    /** Teşhis logları için köprünün anlık durumu (secret/kod içermez). */
    bridgeSnapshot: () => (queue.stats ? queue.stats() : null),

    ping: () => request('/api/ping'),
    status: () => request('/api/status'),

    /* Account linking (1.2.1 uyumlu uçlar) — the plugin is the source of truth. */
    linkVerify: (code, discordId, discordTag, { targetInstance = null } = {}) => request('/api/link/verify', {
      method: 'POST',
      body: { code, discordId, discordTag },
      // Hedef verildiyse birden fazla instance güvenlidir; hedef yoksa eski
      // koruma sürer ve yan etkili çağrı rastgele poller'a gitmez.
      requireSingleInstance: !targetInstance,
      targetInstance,
      timeoutMs: linkWriteTimeoutMs,
    }),
    linkStatus: (queryString, { targetInstance = null } = {}) => request(`/api/link/status?${queryString}`, {
      targetInstance,
    }),
    linkDelete: (type, value) => request('/api/link', {
      method: 'DELETE', body: { type, value }, requireSingleInstance: true, timeoutMs: linkWriteTimeoutMs,
    }),

    /* Hesap bağlama protokolü 2 (plugin 1.2.2). */
    linkProbe: (code, discordId, { targetInstance = null, requestId = null } = {}) => request('/api/link/v2/probe', {
      method: 'POST',
      body: { code, ...(discordId ? { discordId } : {}), ...(requestId ? { requestId } : {}) },
      targetInstance,
    }),
    linkVerifyV2: ({
      code, discordId, discordTag, requestId,
    }, { targetInstance = null } = {}) => request('/api/link/v2/verify', {
      method: 'POST',
      body: {
        code, discordId, discordTag, requestId,
      },
      requireSingleInstance: !targetInstance,
      targetInstance,
      timeoutMs: linkWriteTimeoutMs,
    }),
    linkOperation: (requestId, { targetInstance = null } = {}) => request(
      `/api/link/v2/operation?${query({ requestId })}`,
      { targetInstance },
    ),
    /** selector: 'uuid' | 'discord' | 'name' */
    linkInfo: (selector, value, { targetInstance = null } = {}) => request(
      `/api/link/v2/info?${query({ [selector]: value })}`,
      { targetInstance },
    ),
    linkList: ({ offset = 0, limit = 10 } = {}, { targetInstance = null } = {}) => request(
      `/api/link/v2/list?${query({ offset, limit })}`,
      { targetInstance },
    ),
    linkHistory: ({
      uuid, discordId, limit = 10, beforeId,
    } = {}, { targetInstance = null } = {}) => request(
      `/api/link/v2/history?${query({
        uuid, discord: discordId, limit, beforeId,
      })}`,
      { targetInstance },
    ),
    linkUnlinkV2: ({
      selector, value, expectedLinkId = null, reason = null, actor, requestId,
    }, { targetInstance = null } = {}) => request('/api/link/v2/unlink', {
      method: 'POST',
      body: {
        selector,
        value,
        ...(expectedLinkId ? { expectedLinkId } : {}),
        ...(reason ? { reason } : {}),
        actor,
        requestId,
      },
      requireSingleInstance: !targetInstance,
      targetInstance,
      timeoutMs: linkWriteTimeoutMs,
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
    statsPlayer: (queryString) => request(`/api/stats/player?${queryString}`),
    statsTop: (by = 'elo', limit = 10) => request(
      `/api/stats/top?by=${encodeURIComponent(by)}&limit=${limit}`,
    ),

    /* Faz 7: genişletilmiş köprü yüzeyi. */
    capabilities: () => request('/api/capabilities'),
    teams: () => request('/api/teams'),
    voiceSnapshot: () => request('/api/voice', { requireSingleInstance: true }),
    teamAdmin: () => request('/api/teamadmin', { requireSingleInstance: true }),
    teamAction: (body) => request('/api/teamadmin', { method: 'POST', body, requireSingleInstance: true }),
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
