import { createHash } from 'node:crypto';

/**
 * HESAP BAĞLAMA YÖNLENDİRMESİ — saf karar katmanı (Discord'a bağımlı değil).
 *
 * Bağlantı kodları plugin'in KENDİ kalıcı deposunda doğrulanır; bot kod
 * saklamaz. Birden fazla bağımsız plugin deposu bağlıyken aynı kısa kod iki
 * farklı oyuncu için bulunabilir. Eski akış kodu instance'lara sırayla gönderip
 * "ilk başarı"da duruyordu; bu, kodu HİÇ üretmemiş bir sunucudaki başka bir
 * oyuncuyla eşleşmeye yol açabiliyordu. Kural artık:
 *
 *  1. Plugin 1.2.2 kodu 2 karakterlik kapsam + 6 karakter rastgele üretir.
 *     Kapsam instance kimliğinden türetilir (plugin: LinkScope.java — birebir).
 *  2. Kapsamlı kod yalnız aynı kapsamdaki instance'a gider. Kapsam SAHİPLİĞİ
 *     kanıtlamaz; sahiplik plugin deposundaki özetle kanıtlanır.
 *  3. Aynı kapsamda birden fazla instance varsa ya da kod kapsamsızsa (eski
 *     kod), önce SALT-OKUNUR yoklama yapılır; tam olarak bir sahip yoksa yazma
 *     isteği hiçbir yere gönderilmez.
 *  4. Hedeflenemeyen kurulumlarda (anonim/aynı kimlikli çoklu poller, çoklu
 *     instance'ta protokol 2 desteklemeyen plugin) işlem açık hatayla durur.
 */

export const LINK_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const LINK_PROTOCOL = 2;
export const SCOPED_CODE_LENGTH = 8;
const SCOPE_DOMAIN = 'nautilus-link-scope-v1:';

/** Instance kimliğinin 2 karakterlik kapsamı (plugin LinkScope.of ile aynı). */
export function linkScope(instanceId) {
  const id = String(instanceId ?? '').trim();
  const digest = createHash('sha256').update(`${SCOPE_DOMAIN}${id}`, 'utf8').digest();
  const value = (digest[0] << 8) | digest[1];
  return LINK_ALPHABET[(value >>> 11) & 31] + LINK_ALPHABET[(value >>> 6) & 31];
}

/** Normalize edilmiş kod plugin 1.2.2 kapsamlı biçiminde mi? */
export function isScopedCode(normalized) {
  const code = String(normalized ?? '');
  return code.length === SCOPED_CODE_LENGTH && [...code].every((c) => LINK_ALPHABET.includes(c));
}

export function codeScope(normalized) {
  return isScopedCode(normalized) ? normalized.slice(0, 2) : null;
}

const isAnonymous = (id) => !id || String(id).startsWith('ip:');

/** Köprü durumundaki instance'lar ve bildirdikleri bağlantı protokolü. */
export function linkInstances(bridge) {
  const meta = Array.isArray(bridge?.instanceMeta) ? bridge.instanceMeta : null;
  if (meta) {
    return meta.map((m) => ({ id: m.id, linkProtocol: Number(m.linkProtocol) || 0 }));
  }
  return [...new Set(bridge?.instances ?? [])].map((id) => ({ id, linkProtocol: 0 }));
}

function refuse(errorCode, error) {
  return { ok: false, errorCode, error, transport: 'reverse' };
}

/**
 * Doğrulamanın gideceği hedef planı.
 *
 * @returns {{ok:true, mode:'direct'|'single'|'scoped'|'probe', targets:{id:string|null, linkProtocol:number}[]}
 *   | {ok:false, errorCode:string, error:string}}
 */
export function planLinkTargets(bridge, normalizedCode) {
  if (bridge?.transport !== 'reverse') {
    return { ok: true, mode: 'direct', targets: [{ id: null, linkProtocol: 0 }] };
  }
  const reason = bridge.routing?.reason;
  if (reason === 'concurrent_pollers' || reason === 'duplicate_instance') {
    return refuse('multiple_plugin_instances',
      'Aynı ya da anonim kimlikle birden fazla uzun-yoklama bağlı; doğrulama güvenle hedeflenemiyor. '
      + 'Her Minecraft sunucusunda farklı bridge.instance-id kullan.');
  }

  const instances = linkInstances(bridge);
  if (instances.length === 0) {
    return { ok: false, errorCode: 'plugin_not_connected', error: 'Bağlı plugin instance\'ı yok.', transport: 'reverse' };
  }
  if (instances.length === 1) {
    // Tek bağımsız depo: belirsizlik yok, doğrulama doğrudan ona gider.
    const only = instances[0];
    return {
      ok: true,
      mode: 'single',
      targets: [{ id: isAnonymous(only.id) ? null : only.id, linkProtocol: only.linkProtocol }],
    };
  }
  if (instances.some((instance) => isAnonymous(instance.id))) {
    return refuse('multiple_plugin_instances',
      'Birden fazla plugin bağlı ve en az biri kimlik göndermiyor; doğrulama güvenle hedeflenemiyor.');
  }

  const scope = codeScope(normalizedCode);
  if (scope) {
    const candidates = instances.filter((i) => i.linkProtocol >= LINK_PROTOCOL && linkScope(i.id) === scope);
    if (candidates.length === 1) return { ok: true, mode: 'scoped', targets: candidates };
    if (candidates.length > 1) return { ok: true, mode: 'probe', targets: candidates };
  }
  if (instances.some((instance) => instance.linkProtocol < LINK_PROTOCOL)) {
    return refuse('multiple_plugin_instances',
      'Birden fazla plugin bağlı ve en az biri 1.2.2 hesap bağlama protokolünü desteklemiyor; '
      + 'kodun hangi depoda olduğu kanıtlanamıyor. Tüm sunucuları NautilusUHC 1.2.2\'ye güncelle.');
  }
  return { ok: true, mode: 'probe', targets: instances };
}
