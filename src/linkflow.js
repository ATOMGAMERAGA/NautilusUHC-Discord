import { randomUUID } from 'node:crypto';
import { mcapi as defaultApi, BAD_CODE_ERRORS } from './mcapi.js';
import { planLinkTargets, LINK_PROTOCOL } from './linkrouting.js';

/**
 * HESAP BAĞLAMA AKIŞI — saf karar katmanı.
 *
 * Doğrulamanın tek doğruluk kaynağı Minecraft plugin'idir; bot kodu ne üretir
 * ne saklar. Burada yalnız "plugin ne dedi → kullanıcıya ne gösterilir"
 * kararı verilir. Discord'a hiç bağımlı olmadığı için uçtan uca test edilebilir.
 *
 * KURALLAR
 * --------
 *  - "Kod geçersiz/süresi dolmuş" YALNIZCA backend açıkça `invalid_code` /
 *    `expired_code` dediğinde gösterilir. HTTP 400/404, zaman aşımı, DB hatası
 *    ve köprü hataları kendi adıyla anlatılır.
 *  - Kod yalnız onu üreten depoya gönderilir (bkz. linkrouting.js). Çoklu
 *    depoda sahiplik salt-okunur yoklamayla TEK sahip çıkmadıkça hiçbir yere
 *    yazma isteği gönderilmez; "ilk başarı veren instance" seçimi yoktur.
 *  - Sonucu belirsiz kalan yazma (zaman aşımı/5xx) başka instance'ta denenmez;
 *    aynı instance'ta aynı requestId ile uzlaştırılır.
 *  - Başarı ancak doğrulama yanıtı ve ardından okunan kayıt AYNI UUID–Discord
 *    çiftini (ve link sürümünü) gösterirse başarı sayılır.
 */

/** Backend'in "bu kod yanlış/süresi dolmuş" dediği tek kodlar. */
export const BAD_CODE_ERROR_CODES = new Set(BAD_CODE_ERRORS);

/** Discord hesabının BAŞKA bir MC hesabına bağlı olduğunu bildiren kodlar. */
const ALREADY_LINKED_CODES = new Set(['already_linked', 'discord_already_linked', 'conflict']);

/** Bot ↔ plugin sözleşmesinin tutmadığını gösteren kodlar. */
const CONTRACT_CODES = new Set([
  'missing_fields', 'bad_request', 'invalid_request', 'bad_json', 'invalid_discord_id', 'invalid_request_id',
]);

/** İsteğin hiç doğru uca/servise varmadığını gösteren kodlar. */
const ROUTING_CODES = new Set(['not_found', 'no_route', 'unknown_endpoint', 'method_not_allowed']);

/** Yetkilendirme/paylaşılan sır uyuşmazlığı. */
const AUTH_CODES = new Set(['unauthorized', 'forbidden', 'invalid_token', 'bad_signature']);

/** Sonucu belirsiz bırakan (commit olmuş olabilir) yanıtlar. */
const UNCERTAIN_CODES = new Set([
  'bridge_timeout', 'bridge_unreachable', 'bad_gateway_response', 'store_unavailable', 'internal_error',
  'local_bridge_unreachable',
]);

/** Kod normalizasyonu — modal girdisi her zaman böyle temizlenir. */
export function normalizeLinkCode(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

/** Aynı Discord hesabı için kısa sürede kabul edilen en fazla hatalı kod. */
export const FAILED_ATTEMPT_LIMIT = 8;
const FAILED_ATTEMPT_WINDOW_MS = 10 * 60_000;

/**
 * Hatalı kod denemesi sınırlayıcı (tahmin saldırısına karşı ek katman).
 * Güvenlik kararı değildir; asıl doğrulama plugin deposundadır.
 */
export function createAttemptLimiter({
  limit = FAILED_ATTEMPT_LIMIT, windowMs = FAILED_ATTEMPT_WINDOW_MS, now = Date.now,
} = {}) {
  const buckets = new Map();
  const recent = (key) => (buckets.get(key) ?? []).filter((t) => now() - t < windowMs);
  return {
    blocked(key) {
      const list = recent(key);
      if (list.length) buckets.set(key, list);
      else buckets.delete(key);
      return list.length >= limit;
    },
    record(key) {
      const list = recent(key);
      list.push(now());
      buckets.set(key, list);
    },
    clear(key) {
      buckets.delete(key);
    },
  };
}

/**
 * Discord aynı modal teslimini yeniden gönderirse aynı bot sürecinde yalnız bir
 * doğrulama çalıştır. Plugin tarafındaki kalıcı makbuz farklı süreç/replica
 * tekrarlarını da güvenli biçimde idempotent yapar.
 */
const inFlightVerifications = new WeakMap();
const limiters = new WeakMap();

const YETKILIYE = 'Bu bir kod hatası değildir; lütfen bir yetkiliye bildir.';

/**
 * mcapi yanıtını kullanıcıya gösterilecek sınıflandırılmış bir karara çevirir.
 * Ham backend metni, adres, secret ya da istisna mesajı ASLA dışarı sızmaz.
 *
 * @param {object} res mcapi yanıtı ({ ok:false, errorCode, status })
 * @returns {{ kind:string, title:string, description:string, errorCode:string }}
 */
export function classifyLinkFailure(res = {}) {
  const errorCode = String(res.errorCode ?? '');
  const status = Number(res.status);

  if (BAD_CODE_ERROR_CODES.has(errorCode)) {
    return {
      kind: 'bad_code',
      errorCode,
      title: 'Kod Doğrulanamadı',
      description: 'Girdiğin kod geçersiz veya süresi dolmuş.\n'
        + 'Minecraft sunucusunda `/link` yazarak yeni bir kod al ve tekrar dene.',
    };
  }
  if (errorCode === 'too_many_attempts') {
    return {
      kind: 'too_many_attempts',
      errorCode,
      title: 'Çok Fazla Hatalı Deneme',
      description: 'Kısa sürede çok fazla hatalı kod girildi.\n'
        + 'Birkaç dakika bekle, sonra Minecraft\'ta `/link` ile aldığın güncel kodu gir.',
    };
  }
  if (errorCode === 'code_conflict') {
    return {
      kind: 'code_conflict',
      errorCode,
      title: 'Kod Birden Fazla Sunucuda Bulundu',
      description: 'Bu kod birden fazla Minecraft sunucusunda bekliyor. Hesabın yanlış kişiyle '
        + 'eşleşmemesi için işlem yapılmadı.\nMinecraft\'ta `/link` yazarak yeni bir kod al ve tekrar dene.',
    };
  }
  if (status === 409 || ALREADY_LINKED_CODES.has(errorCode)) {
    return {
      kind: 'already_linked_other',
      errorCode: errorCode || 'conflict',
      title: 'Hesabın Zaten Bağlı',
      description: (errorCode === 'discord_already_linked'
        ? 'Discord hesabına en fazla iki Minecraft hesabı bağlanabilir; iki hesabın da bağlı.\n'
        : 'Discord hesabın zaten başka bir Minecraft hesabına bağlı.\n')
        + 'Bağlantıyı değiştirmen gerekiyorsa `/destek aç` ile talep oluştur.',
    };
  }
  if (errorCode === 'plugin_not_connected') {
    return {
      kind: 'not_connected',
      errorCode,
      title: 'Minecraft Plugin Bağlantısı Yok',
      description: 'Minecraft eklentisi şu anda bota bağlı değil, bu yüzden kodun doğrulanamıyor.\n'
        + 'Kodun büyük ihtimalle geçerli. Sunucu açıldığında tekrar dene; sürerse bir yetkiliye bildir.',
    };
  }
  if (errorCode === 'bridge_misconfigured') {
    return {
      kind: 'misconfigured',
      errorCode,
      title: 'Köprü Ayarı Hatalı',
      description: `Doğrulama isteği Minecraft eklentisine yönlendirilemiyor.\n${YETKILIYE}`,
    };
  }
  if (errorCode === 'multiple_plugin_instances') {
    return {
      kind: 'ambiguous_plugin_instance',
      errorCode,
      title: 'Birden Fazla Sunucu Bağlı',
      description: 'Köprüye birden fazla Minecraft sunucusu bağlı; doğrulama isteğinin hangisine '
        + `gideceği belirsiz olduğu için gönderilmedi.\n${YETKILIYE}`,
    };
  }
  if (errorCode === 'wrong_instance' || errorCode === 'verification_mismatch') {
    return {
      kind: 'verification_mismatch',
      errorCode,
      title: 'Doğrulama Tutarsız',
      description: 'Minecraft sunucusundan gelen yanıt beklenen hesap ya da sunucuyla eşleşmedi; '
        + `bu yüzden işlem başarılı sayılmadı.\n${YETKILIYE}`,
    };
  }
  if (errorCode === 'state_changed') {
    return {
      kind: 'state_changed',
      errorCode,
      title: 'Bağlantı Değişti',
      description: 'İşlem sırasında hesap bağlantın değişti; güncel durum başarıyı doğrulamıyor.\n'
        + 'Discord\'da `/link` ile durumunu kontrol et.',
    };
  }
  if (errorCode === 'unconfirmed') {
    return {
      kind: 'unconfirmed',
      errorCode,
      title: 'Sonuç Doğrulanamadı',
      description: 'İsteğin Minecraft sunucusuna ulaştı ancak sonucu doğrulanamadı.\n'
        + 'Birkaç saniye sonra Discord\'da `/link` ile durumunu kontrol et; bağlı değilse aynı kodla tekrar dene.',
    };
  }
  if (errorCode === 'store_unavailable') {
    return {
      kind: 'store_unavailable',
      errorCode,
      title: 'Bağlantı Kayıtlarına Ulaşılamadı',
      description: 'Minecraft sunucusu bağlantı kayıtlarına şu anda erişemiyor.\n'
        + 'Kodun geçersiz olduğu anlamına gelmez; birkaç dakika sonra tekrar dene.',
    };
  }
  if (ROUTING_CODES.has(errorCode) || status === 404 || errorCode === 'http_404') {
    return {
      kind: 'routing',
      errorCode: errorCode || 'not_found',
      title: 'Doğrulama Servisine Ulaşılamadı',
      description: 'Doğrulama isteği Minecraft eklentisine ulaşmadı (uç bulunamadı).\n'
        + `Kodun geçersiz olduğu anlamına GELMEZ. ${YETKILIYE}`,
    };
  }
  if (CONTRACT_CODES.has(errorCode) || status === 400 || errorCode === 'http_400') {
    return {
      kind: 'contract',
      errorCode: errorCode || 'bad_request',
      title: 'Doğrulama İsteği Reddedildi',
      description: 'Bot ile Minecraft eklentisi arasındaki istek biçimi uyuşmuyor.\n'
        + `Kodun geçersiz olduğu anlamına GELMEZ. ${YETKILIYE}`,
    };
  }
  if (AUTH_CODES.has(errorCode) || status === 401 || status === 403
    || errorCode === 'http_401' || errorCode === 'http_403') {
    return {
      kind: 'auth',
      errorCode: errorCode || 'unauthorized',
      title: 'Köprü Yetkilendirmesi Reddedildi',
      description: 'Bot ile Minecraft eklentisi arasındaki güvenlik anahtarı uyuşmuyor.\n'
        + `Kodun geçersiz olduğu anlamına GELMEZ. ${YETKILIYE}`,
    };
  }
  if (status === 429 || errorCode === 'rate_limited') {
    return {
      kind: 'rate_limited',
      errorCode: 'rate_limited',
      title: 'Çok Fazla İstek',
      description: 'Minecraft sunucusu şu anda çok fazla istek alıyor.\n'
        + 'Birkaç saniye bekleyip tekrar dene.',
    };
  }
  if (errorCode === 'bridge_timeout' || errorCode === 'bridge_unreachable'
    || errorCode === 'bad_gateway_response') {
    return {
      kind: 'unreachable',
      errorCode,
      title: 'Sunucuya Ulaşılamıyor',
      description: 'Minecraft sunucusu doğrulama isteğine yanıt vermedi.\n'
        + 'Kodun geçersiz olduğu anlamına gelmez; birkaç dakika sonra tekrar dene.',
    };
  }
  if (status >= 500) {
    return {
      kind: 'server_error',
      errorCode: errorCode || `http_${status}`,
      title: 'Doğrulama Tamamlanamadı',
      description: 'Minecraft eklentisi isteği işleyemedi.\n'
        + `Kodun geçersiz olduğu anlamına gelmez. ${YETKILIYE}`,
    };
  }
  return {
    kind: 'unknown',
    errorCode: errorCode || 'unknown',
    title: 'Doğrulama Tamamlanamadı',
    description: 'Hesap bağlama şu anda tamamlanamadı.\n'
      + `Kodun geçersiz olduğu anlamına gelmez. ${YETKILIYE}`,
  };
}

/**
 * Modal akışının tamamı. Discord'dan bağımsızdır: girdi kod + kimlik, çıktı
 * karar nesnesi. Çağıran yalnız kararı embed'e çevirir.
 *
 * @returns {Promise<{outcome:'linked'|'failed', created?:boolean, replay?:boolean, mc?:string, link?:object, instance?:string|null, requestId:string, failure?:object, correlationId?:string}>}
 */
export function verifyLinkCode({
  api = defaultApi, code, discordId, discordTag, logger = console,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  retryDelayMs = 1500, reconcileAttempts = 3, readbackAttempts = 2, limiter = null,
} = {}) {
  const normalized = normalizeLinkCode(code);
  const id = String(discordId ?? '');
  let scoped = inFlightVerifications.get(api);
  if (!scoped) {
    scoped = new Map();
    inFlightVerifications.set(api, scoped);
  }
  const key = `${id} ${normalized}`;
  const active = scoped.get(key);
  if (active) {
    logger.warn('[link] yinelenen modal teslimi mevcut doğrulamayla birleştirildi');
    return active;
  }

  let attempts = limiter;
  if (!attempts) {
    attempts = limiters.get(api);
    if (!attempts) {
      attempts = createAttemptLimiter();
      limiters.set(api, attempts);
    }
  }
  const context = {
    api,
    normalized,
    discordId: id,
    discordTag,
    logger,
    sleep,
    retryDelayMs,
    reconcileAttempts,
    readbackAttempts,
    requestId: randomUUID(),
  };
  const task = (async () => {
    if (attempts.blocked(id)) {
      return failed(context, 'guard', null, classifyLinkFailure({ errorCode: 'too_many_attempts' }));
    }
    const decision = await verifyLinkCodeOnce(context);
    if (decision.outcome === 'failed' && decision.failure?.kind === 'bad_code') attempts.record(id);
    if (decision.outcome === 'linked') attempts.clear(id);
    return decision;
  })();
  const tracked = task.finally(() => {
    if (scoped.get(key) === tracked) scoped.delete(key);
  });
  scoped.set(key, tracked);
  return tracked;
}

async function verifyLinkCodeOnce(context) {
  const { api, normalized, logger } = context;

  // Köprü kapalıyken doğrulama çağrısı YAPILMAZ.
  const bridge = api.bridgeStatus({ requireSingleInstance: false });
  if (!bridge.ok) {
    logger.warn(`[link] rid=${context.requestId} doğrulama gönderilmedi: ${bridge.errorCode} — ${bridge.error}`);
    return failed(context, 'bridge', null, classifyLinkFailure(bridge));
  }

  const plan = planLinkTargets(bridge, normalized);
  if (!plan.ok) {
    logger.warn(`[link] rid=${context.requestId} doğrulama gönderilmedi: ${plan.errorCode} — ${plan.error}`);
    return failed(context, 'plan', null, classifyLinkFailure(plan), {}, bridgeSnapshot(api));
  }

  let target = plan.targets[0];
  if (plan.mode === 'probe') {
    const probed = await probeTargets(context, plan.targets);
    if (!probed.target) return probed.decision;
    target = probed.target;
  }
  if (bridge.transport !== 'reverse' || target.linkProtocol < LINK_PROTOCOL) {
    return legacyCommit(context, target);
  }
  return v2Commit(context, target);
}

/** Yanıt gerçekten hedeflenen instance'tan mı geldi? (Eski pluginlerde kimlik yok.) */
function fromTarget(res, targetId) {
  if (!targetId) return true;
  if (res.claimedBy && res.claimedBy !== targetId) return false;
  return res.instance === undefined || res.instance === targetId;
}

/**
 * Kapsamsız kod ya da aynı kapsamda birden fazla instance: salt-okunur yoklama.
 * Tam olarak bir sahip ve hiç çözülemeyen instance yoksa hedef döner.
 */
async function probeTargets(context, targets) {
  const { api, normalized, discordId, requestId } = context;
  const results = await Promise.all(targets.map((target) => api.linkProbe(normalized, discordId, {
    targetInstance: target.id, requestId,
  })));
  const holders = [];
  let expired = false;
  let unresolved = null;
  results.forEach((res, index) => {
    const target = targets[index];
    if (!res.ok || !fromTarget(res, target.id)) {
      unresolved ??= { target, res: res.ok ? { ...res, ok: false, errorCode: 'wrong_instance' } : res };
      return;
    }
    if (res.holder === true) holders.push(target);
    else if (res.expired === true) expired = true;
  });

  if (holders.length > 1) {
    context.logger.error(`[link] rid=${requestId} aynı kod ${holders.length} bağımsız depoda bulundu `
      + `(${holders.map((h) => h.id).join(', ')}); hiçbir yere yazılmadı`);
    return { decision: failed(context, 'probe', null, classifyLinkFailure({ errorCode: 'code_conflict' })) };
  }
  if (unresolved) {
    // Yanıt vermeyen bir depo da aynı kodu tutuyor olabilir: tek sahip kanıtlanamaz.
    return {
      decision: failed(context, 'probe', unresolved.target.id, classifyLinkFailure(unresolved.res), unresolved.res),
    };
  }
  if (holders.length === 1) return { target: holders[0] };
  const errorCode = expired ? 'expired_code' : 'invalid_code';
  return { decision: failed(context, 'probe', null, classifyLinkFailure({ errorCode })) };
}

async function v2Commit(context, target) {
  const {
    api, normalized, discordId, discordTag, requestId,
  } = context;
  const res = await api.linkVerifyV2({
    code: normalized, discordId, discordTag, requestId,
  }, { targetInstance: target.id });

  if (res.ok) {
    if (!fromTarget(res, target.id)) {
      return failed(context, 'commit', target.id, classifyLinkFailure({ errorCode: 'wrong_instance' }), res);
    }
    return confirmLinked(context, target, res);
  }
  if (res.errorCode === 'wrong_instance' || !fromTarget(res, target.id)) {
    return failed(context, 'commit', target.id, classifyLinkFailure({ errorCode: 'wrong_instance' }), res);
  }
  if (UNCERTAIN_CODES.has(res.errorCode) || Number(res.status) >= 500) {
    // İşlem commit olmuş olabilir. Başka instance'a yazma YOK; aynı işlemi uzlaştır.
    const settled = await reconcileOperation(context, target);
    if (settled) return settled;
    return failed(context, 'reconcile', target.id, classifyLinkFailure(res), res);
  }
  return failed(context, 'commit', target.id, classifyLinkFailure(res), res);
}

async function reconcileOperation(context, target) {
  const { api, requestId, logger } = context;
  for (let attempt = 0; attempt < context.reconcileAttempts; attempt++) {
    if (attempt > 0) await context.sleep(context.retryDelayMs);
    const op = await api.linkOperation(requestId, { targetInstance: target.id });
    if (!op.ok || !fromTarget(op, target.id)) continue;
    if (!op.found) continue;
    logger.warn(`[link] rid=${requestId} stage=reconcile target=${target.id ?? '-'} işlem sonucu=${op.result}`);
    if (op.result === 'linked') {
      return confirmLinked(context, target, { ...op, created: true, replay: false });
    }
    return failed(context, 'reconcile', target.id, classifyLinkFailure({ errorCode: op.result }), op);
  }
  return null;
}

/** Doğrulama yanıtı + geri okunan kayıt aynı UUID–Discord–sürüm üçlüsünü göstermeli. */
async function confirmLinked(context, target, res) {
  const { api, discordId, requestId } = context;
  const link = res.link;
  if (!link || typeof link.discordId !== 'string' || link.discordId !== discordId || !link.uuid || !link.linkId) {
    return failed(context, 'commit', target.id, classifyLinkFailure({ errorCode: 'verification_mismatch' }), res);
  }
  for (let attempt = 0; attempt < context.readbackAttempts; attempt++) {
    if (attempt > 0) await context.sleep(context.retryDelayMs);
    const info = await api.linkInfo('uuid', link.uuid, { targetInstance: target.id });
    if (!info.ok || !fromTarget(info, target.id)) continue;
    const current = info.link;
    if (info.linked && current?.uuid === link.uuid && current?.linkId === link.linkId
      && current?.discordId === discordId) {
      return {
        outcome: 'linked',
        created: Boolean(res.created),
        replay: Boolean(res.replay),
        mc: current.currentName ?? current.mcName,
        link: current,
        instance: target.id,
        requestId,
        correlationId: res.correlationId,
      };
    }
    return failed(context, 'readback', target.id, classifyLinkFailure({ errorCode: 'state_changed' }), info);
  }
  return failed(context, 'readback', target.id, classifyLinkFailure({ errorCode: 'unconfirmed' }), res);
}

/** 1.2.1 plugin (protokol 2 yok) ya da doğrudan HTTP: tek depo, eski uçlar. */
async function legacyCommit(context, target) {
  const {
    api, normalized, discordId, discordTag,
  } = context;
  const res = await api.linkVerify(normalized, discordId, discordTag, { targetInstance: target.id });
  if (!res.ok) {
    if (UNCERTAIN_CODES.has(res.errorCode) || Number(res.status) >= 500) {
      // Eski plugin işlem kimliği tutmaz: başarıyı kanıtlayamayız, "geçersiz" de diyemeyiz.
      const status = await api.linkStatus(`discord=${encodeURIComponent(discordId)}`, { targetInstance: target.id });
      if (status.ok && status.linked) {
        return failed(context, 'reconcile', target.id, classifyLinkFailure({ errorCode: 'unconfirmed' }), res);
      }
    }
    return failed(context, 'commit', target.id, classifyLinkFailure(res), res);
  }
  if (!fromTarget(res, target.id)) {
    return failed(context, 'commit', target.id, classifyLinkFailure({ errorCode: 'wrong_instance' }), res);
  }
  const status = await api.linkStatus(res.uuid ? `uuid=${encodeURIComponent(res.uuid)}` : `discord=${encodeURIComponent(discordId)}`, { targetInstance: target.id });
  if (!status.ok || !fromTarget(status, target.id)) {
    return failed(context, 'readback', target.id, classifyLinkFailure({ errorCode: 'unconfirmed' }), status);
  }
  if (!status.linked) {
    return failed(context, 'readback', target.id, classifyLinkFailure({ errorCode: 'state_changed' }), status);
  }
  const sameDiscord = status.discordId === undefined || String(status.discordId) === discordId;
  const sameAccount = !res.uuid || !status.uuid ? (!res.mc || status.mc === res.mc) : res.uuid === status.uuid;
  if (!sameDiscord || !sameAccount) {
    return failed(context, 'readback', target.id, classifyLinkFailure({ errorCode: 'verification_mismatch' }), status);
  }
  return {
    outcome: 'linked',
    created: res.created ?? true,
    replay: Boolean(res.replay),
    mc: status.mc ?? res.mc,
    link: status.uuid ? {
      uuid: status.uuid, discordId, linkId: status.linkId ?? null, currentName: status.mc,
    } : null,
    instance: target.id,
    requestId: context.requestId,
    legacy: true,
    correlationId: res.correlationId,
  };
}

function failed(context, stage, targetId, failure, res = {}, extra = '') {
  const snapshot = extra || bridgeSnapshot(context.api);
  context.logger.warn(`[link] rid=${context.requestId} stage=${stage} target=${targetId ?? '-'}`
    + ` sonuç=${failure.kind}/${failure.errorCode} status=${res.status ?? '-'} transport=${res.transport ?? '-'}`
    + ` cid=${res.correlationId ?? '-'} yanıtlayan=${res.instance ?? res.claimedBy ?? '-'}${snapshot ? ` ${snapshot}` : ''}`);
  return {
    outcome: 'failed', failure, requestId: context.requestId, correlationId: res.correlationId,
  };
}

/** Hata anındaki köprü durumunu tek satıra sıkıştırır (secret/kod içermez). */
function bridgeSnapshot(api) {
  const s = api.bridgeSnapshot?.();
  if (!s) return '';
  return `pollers=${s.pollers} peak=${s.peakPollers} instances=${s.instances}`;
}
