import { config } from './config.js';
import { bridgeQueue } from './bridgequeue.js';

/**
 * NautilusUHC plugin köprüsünün istemcisi. Hatalar fırlatılmaz; komut
 * işleyicileri temiz bir Türkçe mesaj gösterebilsin diye `{ ok: false, error }`
 * olarak çözülür.
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
 */

const TIMEOUT_MS = 8000;

/** Plugin'in yanıtını mcapi sözleşmesine ({ok, ...}) çevirir. */
function shape(status, data) {
  if (status >= 400) {
    return { ok: false, error: data?.error || `Sunucu hatası (${status}).`, status };
  }
  return { ok: true, ...data };
}

async function request(path, { method = 'GET', body } = {}) {
  // 1) Ters köprü — plugin aktif olarak yokluyorsa her zaman bunu tercih et.
  if (bridgeQueue.pluginConnected()) {
    try {
      const res = await bridgeQueue.enqueue({ method, path, body: body ?? null }, TIMEOUT_MS);
      return shape(res.status, res.data);
    } catch (err) {
      return { ok: false, error: `Minecraft sunucusuna ulaşılamadı (${err.message}).` };
    }
  }

  // 2) Doğrudan (eski) mod.
  if (!config.mcApiUrl) {
    return {
      ok: false,
      error: 'Minecraft sunucusu köprüye bağlı değil. Sunucu kapalı olabilir; '
        + 'birazdan tekrar dene.',
    };
  }
  try {
    const res = await fetch(config.mcApiUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.bridgeSecret}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, error: `Sunucudan geçersiz yanıt (${res.status}).` };
      }
    }
    if (!res.ok) {
      return { ok: false, error: data.error || `Sunucu hatası (${res.status}).`, status: res.status };
    }
    return { ok: true, ...data };
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'zaman aşımı' : err.message;
    return { ok: false, error: `Minecraft sunucusuna ulaşılamadı (${reason}).` };
  }
}

export const mcapi = {
  ping: () => request('/api/ping'),
  status: () => request('/api/status'),

  /* Account linking — the plugin is the source of truth. */
  linkVerify: (code, discordId, discordTag) =>
    request('/api/link/verify', { method: 'POST', body: { code, discordId, discordTag } }),
  linkStatus: (query) => request(`/api/link/status?${query}`),
  linkDelete: (type, value) =>
    request('/api/link', { method: 'DELETE', body: { type, value } }),

  /* Minecraft moderation. */
  mod: (action, player, { reason, durationMs } = {}) =>
    request('/api/mod', { method: 'POST', body: { action, player, reason, durationMs } }),

  /* Match data. */
  currentMatch: () => request('/api/match/current'),
  matches: (limit = 10) => request(`/api/matches?limit=${limit}`),
  matchDetail: (id) => request(`/api/match/${encodeURIComponent(id)}`),
  matchInventory: (id, player) =>
    request(`/api/match/${encodeURIComponent(id)}/inventory?player=${encodeURIComponent(player)}`),
  schedule: () => request('/api/schedule'),

  /* Lifetime stats & profile. */
  statsPlayer: (query) => request(`/api/stats/player?${query}`),
  statsTop: (by = 'elo', limit = 10) =>
    request(`/api/stats/top?by=${encodeURIComponent(by)}&limit=${limit}`),

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
