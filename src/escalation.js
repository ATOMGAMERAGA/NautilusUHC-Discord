import { getSetting, setSetting } from './db.js';

/**
 * Uyarı eskalasyonu — saf karar çekirdeği + settings tabanlı eşik deposu.
 * /uyar her uygulandığında toplam uyarı sayısı eşiklerle karşılaştırılır:
 * ban eşiği timeout eşiğinden önce değerlendirilir (daha ağır yaptırım kazanır).
 *
 * Settings anahtarları:
 *   warn_threshold_timeout → {"count":3,"durationMs":3600000}
 *   warn_threshold_ban     → {"count":5}
 */

const DEFAULT_TIMEOUT_MS = 3_600_000; // eşikte süre verilmemişse 1 saat

/** Saf karar: null | {type:'timeout', ms} | {type:'ban'} */
export function escalationAction(warnCount, cfg = {}) {
  const ban = cfg.ban;
  if (ban && Number.isFinite(ban.count) && ban.count > 0 && warnCount >= ban.count) {
    return { type: 'ban' };
  }
  const timeout = cfg.timeout;
  if (timeout && Number.isFinite(timeout.count) && timeout.count > 0 && warnCount >= timeout.count) {
    const ms = Number.isFinite(timeout.durationMs) && timeout.durationMs > 0
      ? timeout.durationMs : DEFAULT_TIMEOUT_MS;
    return { type: 'timeout', ms };
  }
  return null;
}

function parseThreshold(key) {
  const raw = getSetting(key, '');
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Ayarlı eşikler (bozuk/boş ayar null'a düşer → eskalasyon kapalı). */
export function escalationConfig() {
  return {
    timeout: parseThreshold('warn_threshold_timeout'),
    ban: parseThreshold('warn_threshold_ban'),
  };
}

export function setTimeoutThreshold(count, durationMs) {
  setSetting('warn_threshold_timeout', JSON.stringify({ count, durationMs }));
}

export function setBanThreshold(count) {
  setSetting('warn_threshold_ban', JSON.stringify({ count }));
}

export function clearEscalation() {
  setSetting('warn_threshold_timeout', '');
  setSetting('warn_threshold_ban', '');
}
