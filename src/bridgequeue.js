import { randomUUID } from 'node:crypto';

/**
 * TERS KÖPRÜ (reverse bridge) — iş kuyruğu.
 *
 * Eskiden bot ve site, Minecraft sunucusunda AÇIK bir porta (Pelican'da elle
 * açılan `bridge.port`) HTTP isteği atardı. O port internete açık olduğu için
 * DDoS hedefiydi. Artık bağlantı yönü TERSTİR:
 *
 *   plugin → (dışa HTTPS) → bot        : uzun-yoklama ile iş çeker
 *   plugin → (dışa HTTPS) → bot        : işin sonucunu geri yollar
 *
 * Yani Minecraft sunucusunda HİÇBİR port açılmaz; tüm bağlantılar plugin'den
 * dışarı doğrudur. Bot bir "iş kuyruğu" tutar:
 *
 *   1. Bir slash komutu (veya site isteği) MC verisine ihtiyaç duyar
 *      → `enqueue()` işi kuyruğa koyar ve sonucu bekleyen bir Promise döner.
 *   2. Plugin `GET /api/bridge/jobs?wait=…` ile uzun-yoklama yapar
 *      → `takeJobs()` bekleyen işleri ona teslim eder.
 *   3. Plugin işi kendi içinde çalıştırıp `POST /api/bridge/jobs/result`
 *      ile sonucu yollar → `completeJob()` 1. adımdaki Promise'i çözer.
 *
 * Plugin bağlı değilse iş zaman aşımına uğrar ve çağıran taraf temiz bir
 * Türkçe hata görür (asla asılı kalmaz).
 */

/** Bir işin sonucu için beklenecek varsayılan süre (ms). */
export const DEFAULT_JOB_TIMEOUT_MS = 8000;

/** Uzun-yoklamanın en fazla bekleyeceği süre (ms). Cloudflare/Traefik
 *  boşta kalan bağlantıyı ~100 sn'de keser; 25 sn güvenli ve ucuzdur. */
export const MAX_POLL_WAIT_MS = 25_000;

/** Kuyrukta aynı anda bekleyebilecek en fazla iş — bellek koruması. */
const MAX_PENDING = 200;

/**
 * Plugin'i "bağlı" saymak için son yoklamanın üstünden geçebilecek en uzun
 * süre. Uzun-yoklama en fazla MAX_POLL_WAIT_MS tutar, dolayısıyla sağlıklı bir
 * plugin en geç o kadar sonra tekrar görünür; iki katı + pay veriyoruz.
 */
const CONNECTED_WINDOW_MS = MAX_POLL_WAIT_MS * 2 + 10_000;

export function createBridgeQueue({ now = Date.now } = {}) {
  /** Henüz plugin'e teslim EDİLMEMİŞ işler (FIFO). */
  const pending = [];
  /** jobId → { resolve, reject, timer } — sonucu bekleyen çağıranlar. */
  const waiting = new Map();
  /** Boşta bekleyen uzun-yoklama istekleri: { deliver, timer }. */
  const pollers = [];

  let lastPollAt = 0;

  /** Kuyrukta iş varsa bekleyen bir yoklamacıya hemen teslim et. */
  function flush() {
    while (pollers.length > 0 && pending.length > 0) {
      const poller = pollers.shift();
      clearTimeout(poller.timer);
      poller.deliver(pending.splice(0, pending.length));
    }
  }

  /**
   * Bir MC isteğini kuyruğa koyar ve sonucunu bekler.
   * @returns {Promise<{status:number, data:object}>} plugin'in yanıtı
   * @throws  {Error} zaman aşımı veya kuyruk dolu
   */
  function enqueue({ method = 'GET', path, body = null }, timeoutMs = DEFAULT_JOB_TIMEOUT_MS) {
    if (!path) return Promise.reject(new Error('Köprü isteği için yol (path) gerekli.'));
    if (pending.length >= MAX_PENDING) {
      return Promise.reject(new Error('Köprü kuyruğu dolu; Minecraft sunucusu yanıt vermiyor.'));
    }
    const jobId = randomUUID();
    const job = { jobId, method, path, body };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(jobId);
        const idx = pending.findIndex((j) => j.jobId === jobId);
        if (idx >= 0) pending.splice(idx, 1);
        reject(new Error('Minecraft sunucusuna ulaşılamadı (zaman aşımı).'));
      }, timeoutMs);
      waiting.set(jobId, { resolve, reject, timer });
      pending.push(job);
      flush();
    });
  }

  /**
   * Uzun-yoklama: bekleyen işleri döndürür. İş yoksa en fazla `waitMs` bekler
   * ve boş dizi döner (plugin hemen yeniden yoklar).
   */
  function takeJobs(waitMs = MAX_POLL_WAIT_MS) {
    lastPollAt = now();
    if (pending.length > 0) {
      return Promise.resolve(pending.splice(0, pending.length));
    }
    const hold = Math.max(0, Math.min(Number(waitMs) || 0, MAX_POLL_WAIT_MS));
    if (hold === 0) return Promise.resolve([]);
    return new Promise((resolve) => {
      const entry = {
        deliver: (jobs) => {
          const idx = pollers.indexOf(entry);
          if (idx >= 0) pollers.splice(idx, 1);
          resolve(jobs);
        },
      };
      // Bilerek unref EDİLMEZ: açık bir uzun-yoklama gerçek iştir, süreç
      // bunun için ayakta kalmalıdır (aksi hâlde olay döngüsü boşalır).
      entry.timer = setTimeout(() => entry.deliver([]), hold);
      pollers.push(entry);
    });
  }

  /**
   * Plugin'den gelen sonucu ilgili bekleyene bağlar.
   * @returns {boolean} false = iş bilinmiyor (zaman aşımına uğramış olabilir)
   */
  function completeJob(jobId, status, data) {
    const entry = waiting.get(jobId);
    if (!entry) return false;
    waiting.delete(jobId);
    clearTimeout(entry.timer);
    entry.resolve({ status: Number(status) || 0, data: data ?? {} });
    return true;
  }

  /** Plugin son CONNECTED_WINDOW_MS içinde yokladı mı? */
  function pluginConnected() {
    return lastPollAt > 0 && now() - lastPollAt < CONNECTED_WINDOW_MS;
  }

  /** Teşhis için (/saglik, /admin köprü). */
  function stats() {
    return {
      connected: pluginConnected(),
      lastPollAt: lastPollAt || null,
      pending: pending.length,
      waiting: waiting.size,
      pollers: pollers.length,
    };
  }

  /** Test ve kapanış temizliği: bekleyen herkesi reddet, sayaçları bırak. */
  function reset() {
    for (const [, entry] of waiting) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Köprü kapatıldı.'));
    }
    waiting.clear();
    pending.length = 0;
    while (pollers.length) {
      const poller = pollers.shift();
      clearTimeout(poller.timer);
      poller.deliver([]);
    }
    lastPollAt = 0;
  }

  return { enqueue, takeJobs, completeJob, pluginConnected, stats, reset };
}

/** Süreç genelinde tek kuyruk — httpserver ve mcapi bunu paylaşır. */
export const bridgeQueue = createBridgeQueue();
