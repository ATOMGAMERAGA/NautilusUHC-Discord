import { buildAnnouncement } from './httpserver.js';
import { dmSubscriptions } from './db.js';
import { mcapi } from './mcapi.js';
import { clean } from './util.js';

/**
 * /maç-bildirim DM dağıtımı.
 *
 * Kurallar (docs/INTEGRATION-CONTRACT.md + Faz 4 kabulü):
 *  - YALNIZ `match_start` ve `test === false` eventinde gönderilir.
 *  - Kanal duyurusuyla AYNI embed üreticisi (buildAnnouncement) kullanılır —
 *    içerik drift edemez. DM'de rol pingi yerine kullanıcı mention'ı vardır.
 *  - Event-düzeyi dedup receiver'da (processed_events) yapılır; bu modül aynı
 *    event için ikinci kez ÇAĞRILMAZ.
 *  - DM'i kapalı kullanıcı (50007) veya başka hata bir sonraki aboneyi
 *    ENGELLEMEZ; hata kullanıcı kaydına yazılır ve devam edilir.
 *  - Sınırlı eşzamanlılık: Discord rate limitlerini kütüphane yönetir; biz
 *    yine de aynı anda en çok CONCURRENCY DM açarız.
 */

const CONCURRENCY = 3;

/** /maç-bildirim onay butonunun geçerlilik süresi. */
export const CONFIRM_TTL_MS = 2 * 60 * 1000;

/**
 * Onay butonu kararı (saf, test edilebilir): customId
 * `bildirim:<ac|kapat|vazgec>:<ownerId>:<issuedAt>` biçimindedir.
 * Dönüş: 'not_owner' | 'expired' | { action, ownerId }.
 */
export function confirmDecision(customId, clickerId, now = Date.now()) {
  const [, action, ownerId, issuedAt] = customId.split(':');
  if (clickerId !== ownerId) return 'not_owner';
  if (action !== 'vazgec' && now - Number(issuedAt) > CONFIRM_TTL_MS) return 'expired';
  return { action, ownerId };
}

/** Bağlı MC adını best-effort getirir; köprü kapalıysa sessizce boş döner. */
async function linkedMcName(discordId) {
  try {
    const res = await mcapi.linkStatus(`discord=${discordId}`);
    return res.ok && res.linked ? res.mc : null;
  } catch {
    return null;
  }
}

/** Tek aboneye DM. Dönüş: { ok, error? } — asla throw etmez. */
async function sendOne(client, userId, payloadBase) {
  try {
    const user = await client.users.fetch(userId);
    const mc = await linkedMcName(userId);
    const content = `<@${userId}>`
      + (mc ? ` — bağlı hesabın: **${clean(mc, 30)}**` : '');
    await user.send({
      content,
      embeds: payloadBase.embeds,
      allowedMentions: { users: [userId] },
    });
    dmSubscriptions.clearError(userId);
    return { ok: true };
  } catch (err) {
    const code = err?.code ?? err?.status ?? '';
    const msg = code === 50007
      ? 'DM kapalı (50007)'
      : `gönderilemedi (${code || err.message})`;
    dmSubscriptions.recordError(userId, msg);
    console.warn(`[maç-bildirim] ${userId} DM hatası: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Köprü eventini DM aboneliklerine dağıtır. Receiver'ın onEvent hook'undan
 * çağrılır; sonuç loglanır. Bir tarafın hatası diğerini düşürmez.
 */
export async function dispatchMatchDms(client, { type, test, data }) {
  if (type !== 'match_start' || test) return { sent: 0, failed: 0, skipped: true };

  const subscribers = dmSubscriptions.enabledUserIds();
  if (subscribers.length === 0) return { sent: 0, failed: 0 };

  // Kanal duyurusuyla aynı üretici; DM'de rol pingi kullanılmaz.
  const base = buildAnnouncement(type, data, false);
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < subscribers.length; i += CONCURRENCY) {
    const batch = subscribers.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((id) => sendOne(client, id, base)));
    for (const r of results) (r.ok ? sent++ : failed++);
  }
  console.log(`[maç-bildirim] DM dağıtımı: ${sent} gönderildi, ${failed} hata, ${subscribers.length} abone`);
  return { sent, failed };
}
