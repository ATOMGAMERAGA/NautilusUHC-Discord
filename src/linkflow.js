import { mcapi as defaultApi, BAD_CODE_ERRORS } from './mcapi.js';

/**
 * HESAP BAĞLAMA AKIŞI — saf karar katmanı.
 *
 * Doğrulamanın tek doğruluk kaynağı Minecraft plugin'idir; bot kodu ne üretir
 * ne saklar. Burada yalnız "plugin ne dedi → kullanıcıya ne gösterilir"
 * kararı verilir. Discord'a hiç bağımlı olmadığı için uçtan uca test edilebilir.
 *
 * KÖK NEDEN (bu modülün var oluş sebebi)
 * --------------------------------------
 * Eskiden components.js şöyle karar veriyordu:
 *
 *     const badCode = res.status === 404 || res.status === 400 || /invalid|…/
 *
 * Yani HTTP status'una bakıp "kod geçersiz" diyordu. Oysa 404, çok daha sık
 * olarak isteğin plugin'e HİÇ ULAŞMADIĞI anlamına gelir:
 *   - MC_API_URL botun kendi adresini gösteriyor → botun kendi HTTP sunucusu
 *     `/api/link/verify`'i tanımaz, `404 {"error":"not_found"}` döner;
 *   - yanlış host/port/ters vekil → 404 ya da başka bir servisin cevabı;
 *   - eksik alan → `400 {"error":"missing_fields"}` (entegrasyon hatası).
 * Hepsi oyuncuya "kodun geçersiz" diye gösteriliyor, oyuncu da defalarca yeni
 * kod alıp aynı duvara toslıyordu.
 *
 * Kural: "kod geçersiz/süresi dolmuş" YALNIZCA backend'in açıkça
 * `invalid_code` / `expired_code` demesiyle gösterilir. Başka her şey köprü
 * veya yapılandırma hatasıdır ve öyle söylenir.
 */

/** Backend'in "bu kod yanlış/süresi dolmuş" dediği tek kodlar. */
export const BAD_CODE_ERROR_CODES = new Set(BAD_CODE_ERRORS);

/** Discord hesabının BAŞKA bir MC hesabına bağlı olduğunu bildiren kodlar. */
const ALREADY_LINKED_CODES = new Set(['already_linked', 'discord_already_linked', 'conflict']);

/** Bot ↔ plugin sözleşmesinin tutmadığını gösteren kodlar. */
const CONTRACT_CODES = new Set(['missing_fields', 'bad_request', 'invalid_request', 'bad_json']);

/** İsteğin hiç doğru uca/servise varmadığını gösteren kodlar. */
const ROUTING_CODES = new Set(['not_found', 'no_route', 'unknown_endpoint', 'method_not_allowed']);

/** Yetkilendirme/paylaşılan sır uyuşmazlığı. */
const AUTH_CODES = new Set(['unauthorized', 'forbidden', 'invalid_token', 'bad_signature']);

/** Kod normalizasyonu — modal girdisi her zaman böyle temizlenir. */
export function normalizeLinkCode(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

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
  if (status === 409 || ALREADY_LINKED_CODES.has(errorCode)) {
    return {
      kind: 'already_linked_other',
      errorCode: errorCode || 'conflict',
      title: 'Hesabın Zaten Bağlı',
      description: 'Discord hesabın zaten başka bir Minecraft hesabına bağlı.\n'
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
 * karar nesnesi. Çağıran (components.js) yalnız kararı embed'e çevirir.
 *
 * Sıra:
 *   1. Kodu normalize et (trim + upper).
 *   2. Köprü durumunu ve hedeflenebilir instance'ları belirle.
 *   3. Tek instance'ta mevcut bağlantıyı sor.
 *   4. Kodu her açık instance'a AYRI HEDEFLİ istekle doğrulat. Ancak hepsi
 *      açıkça invalid/expired derse kullanıcıya kod hatası göster.
 *
 * @returns {Promise<{outcome:'linked'|'already_linked_self'|'failed', mc?:string, failure?:object, correlationId?:string}>}
 */
export async function verifyLinkCode({
  api = defaultApi, code, discordId, discordTag, logger = console,
} = {}) {
  const normalized = normalizeLinkCode(code);

  // 2) Köprü kapalıyken doğrulama çağrısı YAPILMAZ.
  const bridge = api.bridgeStatus({ requireSingleInstance: false });
  if (!bridge.ok) {
    logger.warn(`[link] doğrulama gönderilmedi: ${bridge.errorCode} — ${bridge.error}`);
    return { outcome: 'failed', failure: classifyLinkFailure(bridge) };
  }

  const plan = verificationTargets(bridge);
  if (!plan.ok) {
    logger.warn(`[link] doğrulama gönderilmedi: ${plan.errorCode} — ${plan.error}`);
    return { outcome: 'failed', failure: classifyLinkFailure(plan) };
  }

  // Tek hedefte mevcut "zaten bağlı" davranışını koru. Birden fazla hedefte
  // gereksiz N adet ön sorgu yerine atomik verify yanıtındaki 409 kullanılır.
  let status = null;
  if (plan.targets.length === 1) {
    const targetInstance = plan.targets[0];
    status = await api.linkStatus(`discord=${encodeURIComponent(discordId)}`, { targetInstance });
    if (status.ok && status.linked) {
      return { outcome: 'already_linked_self', mc: status.mc, correlationId: status.correlationId };
    }
  }

  // 4) Instance kimlikleri açık olduğunda yanlış sunucudaki invalid_code son
  // karar değildir. Her hedef ayrı denenir; başarı ilk bulunduğu yerde biter.
  let lastBadCode = null;
  let firstInfrastructureFailure = null;
  for (const targetInstance of plan.targets) {
    const res = await api.linkVerify(normalized, discordId, discordTag, { targetInstance });
    if (res.ok) {
      return { outcome: 'linked', mc: res.mc, correlationId: res.correlationId };
    }
    const failure = classifyLinkFailure(res);
    if (failure.kind === 'already_linked_other') {
      return { outcome: 'failed', failure, correlationId: res.correlationId };
    }
    if (failure.kind === 'bad_code') lastBadCode = { failure, res };
    else if (!firstInfrastructureFailure) firstInfrastructureFailure = { failure, res };
  }

  // Bir hedef timeout/route/auth hatası verdiyse "tüm instance'lar kodu açıkça
  // reddetti" diyemeyiz. Sahte invalid_code yerine o altyapı hatasını göster.
  const final = firstInfrastructureFailure ?? lastBadCode;
  const failure = final?.failure ?? classifyLinkFailure({});
  const res = final?.res ?? {};
  logger.warn(`[link] doğrulama başarısız (${failure.kind}/${failure.errorCode})`
    + ` status=${res.status ?? '-'} transport=${res.transport ?? '-'} cid=${res.correlationId ?? '-'}`
    + ` targets=${plan.targets.length} ${bridgeSnapshot(api)}`);

  // pollId her ardışık uzun-yoklamada değişir; süreç karşılaştırması claimedBy
  // ile yapılır. Yalnız süreç kimliği gerçekten farklıysa teşhis alarmı ver.
  if (failure.kind === 'bad_code' && status?.claimedBy && res.claimedBy
      && status.claimedBy !== res.claimedBy) {
    logger.error('[link] DİKKAT: sorgu ve doğrulama FARKLI plugin instance\'larına gitti'
      + ` (${status.claimedBy} ≠ ${res.claimedBy}). Köprüye birden fazla Minecraft sunucusu bağlıysa`
      + ' kodu üretmeyen sunucu doğrulamayı reddeder ve oyuncu doğru kodu girdiği hâlde'
      + ' "kod geçersiz" görür. Fazladan sunucuyu/konteyneri kapat ya da her instance\'a'
      + ' ayrı BRIDGE_INSTANCE_ID ver.');
  }
  return { outcome: 'failed', failure, correlationId: res.correlationId };
}

/**
 * Reverse bridge hedef planı. Yeni pluginler süreç başına açık bir instance
 * kimliği gönderir; birden fazlaysa hepsini ayrı ayrı güvenle deneyebiliriz.
 * Aynı/anonim kimliğin arkasında iki eşzamanlı poller varsa hedef seçilemez.
 */
function verificationTargets(bridge) {
  if (bridge.transport !== 'reverse') return { ok: true, targets: [null] };

  const instances = [...new Set(bridge.instances ?? [])];
  const explicit = instances.filter((id) => id && !id.startsWith('ip:'));
  const hasAnonymous = explicit.length !== instances.length;
  const duplicateIdentity = bridge.routing?.reason === 'concurrent_pollers';
  if (duplicateIdentity || (hasAnonymous && instances.length > 1)) {
    return {
      ok: false,
      transport: 'reverse',
      errorCode: 'multiple_plugin_instances',
      error: 'Birden fazla uzun-yoklama aynı/anonim kimlikle bağlı; doğrulama güvenle hedeflenemiyor. '
        + 'Her Minecraft sunucusunda farklı bridge.instance-id kullan.',
    };
  }

  return { ok: true, targets: explicit.length ? explicit : [null] };
}

/** Hata anındaki köprü durumunu tek satıra sıkıştırır (secret/kod içermez). */
function bridgeSnapshot(api) {
  const s = api.bridgeSnapshot?.();
  if (!s) return '';
  return `pollers=${s.pollers} peak=${s.peakPollers} instances=${s.instances}`;
}
