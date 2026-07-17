import { config } from './config.js';

/**
 * HTTP client for the NautilusUHC plugin bridge API. Every call is authenticated
 * with the shared secret. Failures resolve to `{ ok: false, error }` instead of
 * throwing so command handlers can show a clean Turkish error.
 */

const TIMEOUT_MS = 8000;

async function request(path, { method = 'GET', body } = {}) {
  if (!config.mcApiUrl) {
    return { ok: false, error: 'MC API adresi ayarlı değil (MC_API_URL).' };
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
