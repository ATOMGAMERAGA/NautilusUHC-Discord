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
 *
 * INSTANCE KİMLİĞİ (geriye uyumlu)
 * --------------------------------
 * Kuyruk eskiden tamamen anonimdi: yokluyan HERHANGİ bir plugin HERHANGİ bir
 * işi alabiliyordu. Aynı `BRIDGE_SECRET` ile iki Minecraft sunucusu bağlanırsa
 * (test + canlı, ya da eski konteyner kapanmamışsa) hesap bağlama doğrulaması
 * rastgele birine gider; kodu ÜRETMEYEN sunucu `invalid_code` döner ve oyuncu
 * sahte bir "kod geçersiz" mesajı görür.
 *
 * Bu yüzden her yoklama bir KİMLİK taşır:
 *   - Yeni plugin: `X-Bridge-Instance: <BRIDGE_INSTANCE_ID>` başlığı (veya
 *     `?instance=` sorgu parametresi).
 *   - Eski plugin: başlık yok → httpserver kimliği IP'den türetir (`ip:…`).
 * Kimlikler yalnız TEŞHİS ve YÖNLENDİRME içindir; kimlik doğrulaması
 * değildir (o hâlâ HMAC/paylaşılan sır işidir).
 *
 * `enqueue({ targetInstance })` verilen iş yalnız o instance'a teslim edilir.
 * Eski pluginler hiç açık kimlik göndermediği için onlara ASLA hedefli iş
 * yazılmaz — protokol geriye uyumludur.
 *
 * KİMLİKTEN BAĞIMSIZ İKİNCİ SİNYAL: EŞZAMANLI YOKLAMA SAYISI
 * ----------------------------------------------------------
 * Ters vekil (Dokploy/Traefik/Cloudflare) arkasında HER plugin aynı proxy
 * IP'sinden gelir; kimlik başlığı göndermeyen iki ayrı sunucu bu yüzden TEK
 * anonim instance gibi görünür — kimlik sayımı orada kördür.
 *
 * Ama taşıma katmanı yalan söylemez: sağlıklı BİR plugin aynı anda YALNIZ BİR
 * uzun-yoklama tutar (BridgePoller tek thread'de senkron döngüdür). Dolayısıyla
 * aynı anda iki açık yoklama = iki ayrı plugin süreci. Bu sayaç IP'den, ters
 * vekilden ve plugin sürümünden bağımsız çalışır.
 *
 * Bu KRİTİKTİR: iki yoklama bekliyorken arka arkaya gelen iki iş (linkStatus +
 * linkVerify) FARKLI pluginlere dağılır. Kodu üreten sunucu sorguyu, üretmeyen
 * sunucu doğrulamayı alır ve oyuncu doğru kodu girdiği hâlde HER SEFERİNDE
 * "invalid_code" görür.
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

/** Açık kimlik göndermeyen (eski) pluginler için kullanılan kimlik öneki. */
export const ANONYMOUS_INSTANCE_PREFIX = 'ip:';

export function createBridgeQueue({ now = Date.now } = {}) {
  /** Henüz plugin'e teslim EDİLMEMİŞ işler (FIFO). */
  const pending = [];
  /** jobId → { resolve, reject, timer } — sonucu bekleyen çağıranlar. */
  const waiting = new Map();
  /** Boşta bekleyen uzun-yoklama istekleri: { deliver, timer, instanceId }. */
  const pollers = [];
  /** instanceId → son yoklama zamanı (ms). */
  const instances = new Map();

  let lastPollAt = 0;
  /** Aynı anda en fazla kaç yoklama açıktı ve bu en son ne zaman görüldü. */
  let peakPollers = 0;
  let multiPollerSeenAt = 0;

  /** Pencere dışına düşmüş instance kayıtlarını atar. */
  function pruneInstances(at = now()) {
    for (const [id, seen] of instances) {
      if (at - seen >= CONNECTED_WINDOW_MS) instances.delete(id);
    }
  }

  /**
   * Son CONNECTED_WINDOW_MS içinde yoklama yapmış instance kimlikleri.
   * Uzunluğu 1'den büyükse köprüde BİRDEN FAZLA plugin var demektir.
   */
  function activeInstances() {
    pruneInstances();
    return [...instances.keys()];
  }

  /**
   * Verilen instance'ın alabileceği işleri kuyruktan çeker. İşi KİMİN aldığı
   * bekleyen kayda yazılır: sonuç döndüğünde teşhis logu hangi plugin'in
   * yanıtladığını söyleyebilsin diye.
   */
  function claimJobs(instanceId, pollId) {
    const taken = [];
    for (let i = 0; i < pending.length;) {
      const job = pending[i];
      if (!job.targetInstance || job.targetInstance === instanceId) {
        const entry = waiting.get(job.jobId);
        if (entry) {
          entry.claimedBy = instanceId;
          entry.claimedPollId = pollId;
        }
        // targetInstance kuyruk içi yönlendirme alanıdır; plugin'e giden
        // gövdede kalması zararsızdır ama pollId asla dışarı sızmaz.
        taken.push(job);
        pending.splice(i, 1);
      } else {
        i++;
      }
    }
    return taken;
  }

  /** Kuyrukta iş varsa bekleyen uygun bir yoklamacıya hemen teslim et. */
  function flush() {
    for (let i = 0; i < pollers.length && pending.length > 0;) {
      const poller = pollers[i];
      const jobs = claimJobs(poller.instanceId, poller.pollId);
      if (jobs.length === 0) {
        i++;
        continue;
      }
      pollers.splice(i, 1);
      clearTimeout(poller.timer);
      poller.deliver(jobs);
    }
  }

  /**
   * Bir MC isteğini kuyruğa koyar ve sonucunu bekler.
   * @param {{method?:string, path:string, body?:object|null, targetInstance?:string|null}} req
   * @returns {Promise<{status:number, data:object}>} plugin'in yanıtı
   * @throws  {Error} zaman aşımı veya kuyruk dolu
   */
  function enqueue(
    { method = 'GET', path, body = null, targetInstance = null },
    timeoutMs = DEFAULT_JOB_TIMEOUT_MS,
  ) {
    if (!path) return Promise.reject(new Error('Köprü isteği için yol (path) gerekli.'));
    if (pending.length >= MAX_PENDING) {
      return Promise.reject(new Error('Köprü kuyruğu dolu; Minecraft sunucusu yanıt vermiyor.'));
    }
    const jobId = randomUUID();
    // targetInstance protokolde yeni bir alandır; eski pluginler bilmediği
    // alanı yok sayar, dolayısıyla gövde geriye uyumludur.
    const job = { jobId, method, path, body, targetInstance };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(jobId);
        const idx = pending.findIndex((j) => j.jobId === jobId);
        if (idx >= 0) pending.splice(idx, 1);
        reject(new Error('Minecraft sunucusuna ulaşılamadı (zaman aşımı).'));
      }, timeoutMs);
      waiting.set(jobId, {
        resolve: (res) => resolve(res), reject, timer, claimedBy: null, claimedPollId: null,
      });
      pending.push(job);
      flush();
    });
  }

  /**
   * Uzun-yoklama: bekleyen işleri döndürür. İş yoksa en fazla `waitMs` bekler
   * ve boş dizi döner (plugin hemen yeniden yoklar).
   *
   * @param {number} waitMs
   * @param {{instanceId?: string}} [opts] plugin kimliği (yoksa 'legacy')
   */
  function takeJobs(waitMs = MAX_POLL_WAIT_MS, {
    instanceId = `${ANONYMOUS_INSTANCE_PREFIX}bilinmeyen`, signal = null,
  } = {}) {
    const at = now();
    lastPollAt = at;
    instances.set(instanceId, at);
    pruneInstances(at);

    const pollId = randomUUID().slice(0, 8);
    const ready = claimJobs(instanceId, pollId);
    if (ready.length > 0) return Promise.resolve(ready);

    const hold = Math.max(0, Math.min(Number(waitMs) || 0, MAX_POLL_WAIT_MS));
    if (hold === 0) return Promise.resolve([]);
    return new Promise((resolve) => {
      const entry = {
        instanceId,
        pollId,
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

      // Bağlantı koparsa yoklamayı HEMEN düş. Aksi hâlde plugin yeniden
      // başladığında terk edilmiş yoklama 25 sn boyunca açık sayılır, "iki
      // eşzamanlı yoklama" sanılır ve sağlıklı tek kurulumda hesap bağlama
      // boş yere bloklanırdı.
      if (signal) {
        if (signal.aborted) {
          entry.deliver([]);
          return;
        }
        signal.addEventListener('abort', () => entry.deliver([]), { once: true });
      }

      // Sağlıklı tek plugin aynı anda tek yoklama tutar; ikincisi ayrı bir
      // süreç demektir. Zamanı not ediyoruz ki sinyal, yoklamalar kapandıktan
      // sonra da bağlantı penceresi boyunca geçerli kalsın. Sayım yalnız
      // GERÇEKTEN açık olan yoklamalar üzerinden yapılır (bkz. abort).
      if (pollers.length > peakPollers) peakPollers = pollers.length;
      if (pollers.length > 1) multiPollerSeenAt = at;
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
    entry.resolve({
      status: Number(status) || 0,
      data: data ?? {},
      // Teşhis: işi hangi plugin yoklaması aldı. Aynı akışın iki isteği farklı
      // pollId'lere düşüyorsa köprüde birden fazla plugin var demektir.
      claimedBy: entry.claimedBy,
      claimedPollId: entry.claimedPollId,
    });
    return true;
  }

  /** Plugin son CONNECTED_WINDOW_MS içinde yokladı mı? */
  function pluginConnected() {
    return lastPollAt > 0 && now() - lastPollAt < CONNECTED_WINDOW_MS;
  }

  /**
   * Köprüde işin HANGİ plugin'e gideceği belirsiz mi?
   *
   * İki bağımsız sinyal kullanılır; biri yeterlidir:
   *   1. `instances` — farklı açık kimlik (BRIDGE_INSTANCE_ID) sayısı > 1.
   *      Kesindir ama kimlik göndermeyen eski pluginlerde çalışmaz.
   *   2. `concurrent_pollers` — aynı anda ikiden fazla açık uzun-yoklama.
   *      Kimlikten ve IP'den bağımsızdır; ters vekil arkasında da çalışır.
   *      Sağlıklı tek plugin aynı anda tek yoklama tutar.
   *
   * (2) yalnız "şu an" değil, bağlantı penceresi boyunca hatırlanır: ikinci
   * plugin tam o anda iki yoklama arasında olabilir, belirsizlik yine de gerçektir.
   *
   * @returns {{ambiguous:boolean, reason:string|null, instances:string[], pollers:number, peakPollers:number}}
   */
  function routingAmbiguity() {
    const active = activeInstances();
    const multiPollerRecent = multiPollerSeenAt > 0
      && now() - multiPollerSeenAt < CONNECTED_WINDOW_MS;
    let reason = null;
    if (active.length > 1) reason = 'instances';
    else if (pollers.length > 1 || multiPollerRecent) reason = 'concurrent_pollers';
    return {
      ambiguous: reason !== null,
      reason,
      instances: active,
      pollers: pollers.length,
      peakPollers,
    };
  }

  /** Teşhis için (/sağlık, /admin köprü). */
  function stats() {
    const ambiguity = routingAmbiguity();
    return {
      connected: pluginConnected(),
      lastPollAt: lastPollAt || null,
      pending: pending.length,
      waiting: waiting.size,
      /** Şu anda AÇIK tutulan uzun-yoklama sayısı. */
      pollers: pollers.length,
      /** Aynı anda görülen en yüksek yoklama sayısı (1'den büyükse çoklu plugin). */
      peakPollers,
      /** Son pencerede görülen farklı plugin instance sayısı. */
      instances: ambiguity.instances.length,
      instanceIds: ambiguity.instances,
      ambiguous: ambiguity.ambiguous,
      ambiguityReason: ambiguity.reason,
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
    instances.clear();
    lastPollAt = 0;
    peakPollers = 0;
    multiPollerSeenAt = 0;
  }

  return {
    enqueue, takeJobs, completeJob, pluginConnected, activeInstances, routingAmbiguity, stats, reset,
  };
}

/** Süreç genelinde tek kuyruk — httpserver ve mcapi bunu paylaşır. */
export const bridgeQueue = createBridgeQueue();
