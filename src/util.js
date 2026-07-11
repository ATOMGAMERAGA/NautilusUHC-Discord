import { config } from './config.js';

const UNIT_MS = {
  sn: 1000, s: 1000, sec: 1000,
  dk: 60_000, d: 60_000, m: 60_000, min: 60_000,
  sa: 3_600_000, h: 3_600_000, saat: 3_600_000,
  g: 86_400_000, gün: 86_400_000, gun: 86_400_000, day: 86_400_000,
  hf: 604_800_000, w: 604_800_000, hafta: 604_800_000,
};

/**
 * Parses a Turkish/English duration string like "10dk", "2sa", "7g", "30sn",
 * "1h", "45m". Returns milliseconds, or null when it cannot be parsed.
 */
export function parseDuration(input) {
  if (!input) return null;
  const match = String(input).trim().toLowerCase().match(/^(\d+)\s*([a-zçğıöşü]+)$/i);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  const unit = UNIT_MS[match[2]];
  if (!unit || !Number.isFinite(amount) || amount <= 0) return null;
  return amount * unit;
}

/** Formats milliseconds as a short Turkish duration ("2sa 15dk"). */
export function formatDuration(ms) {
  if (ms == null || ms <= 0) return 'kalıcı';
  const parts = [];
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  if (days) parts.push(`${days}g`);
  if (hours) parts.push(`${hours}sa`);
  if (mins) parts.push(`${mins}dk`);
  if (secs && parts.length === 0) parts.push(`${secs}sn`);
  return parts.length ? parts.join(' ') : '0sn';
}

/** Formats seconds as mm:ss / h:mm:ss for match durations. */
export function formatSeconds(totalSecs) {
  const s = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const trFormatter = new Intl.DateTimeFormat('tr-TR', {
  timeZone: config.timezone,
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

/** "02.07.2026 21:30" in Türkiye time. */
export function trDateTime(epochMs) {
  return trFormatter.format(new Date(epochMs));
}

/** Discord-native timestamp that renders in each viewer's locale. */
export function discordTime(epochMs, style = 'F') {
  return `<t:${Math.floor(epochMs / 1000)}:${style}>`;
}

/** Escape user text before embedding it in markdown. */
export function clean(text, max = 900) {
  const s = String(text ?? '').replace(/[`*_~|]/g, '\\$&');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
