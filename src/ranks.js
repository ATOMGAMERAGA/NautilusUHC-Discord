import { getSetting, setSetting } from './db.js';

/**
 * Configurable ELO rank ladder. Stored as JSON in settings ('elo_ranks');
 * admins edit it with /admin elorank. Each tier: { name, min, emoji, color }.
 */

export const DEFAULT_RANKS = [
  { name: 'Şampiyon', min: 2200, emoji: '👑', color: 0xff2d78 },
  { name: 'Elmas', min: 1800, emoji: '💎', color: 0x4fd7ff },
  { name: 'Zümrüt', min: 1500, emoji: '🟢', color: 0x2ecc71 },
  { name: 'Altın', min: 1250, emoji: '🥇', color: 0xf1c40f },
  { name: 'Demir', min: 1000, emoji: '⚙️', color: 0xbdc3c7 },
  { name: 'Taş', min: 0, emoji: '🪨', color: 0x7f8c8d },
];

/** Current ladder, highest tier first. Falls back to defaults on bad data. */
export function ranks() {
  const raw = getSetting('elo_ranks');
  if (!raw) return DEFAULT_RANKS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_RANKS;
    return parsed
      .filter((r) => r && typeof r.name === 'string' && Number.isFinite(r.min))
      .sort((a, b) => b.min - a.min);
  } catch {
    return DEFAULT_RANKS;
  }
}

export function saveRanks(list) {
  setSetting('elo_ranks', JSON.stringify(list));
}

export function resetRanks() {
  setSetting('elo_ranks', JSON.stringify(DEFAULT_RANKS));
}

/** The tier a given ELO falls into (never null — lowest tier catches all). */
export function rankFor(elo) {
  const ladder = ranks();
  return ladder.find((r) => elo >= r.min) ?? ladder[ladder.length - 1];
}

/** "💎 Elmas" style label. */
export function rankLabel(elo) {
  const r = rankFor(elo);
  return `${r.emoji ?? ''} ${r.name}`.trim();
}

/** Adds or replaces a tier by name. */
export function upsertRank(name, min, emoji) {
  const list = ranks().filter((r) => r.name.toLowerCase() !== name.toLowerCase());
  list.push({ name, min, emoji: emoji || '🏅', color: 0x00b3b3 });
  list.sort((a, b) => b.min - a.min);
  saveRanks(list);
  return list;
}

/** Removes a tier by name. @return true when something was removed. */
export function removeRank(name) {
  const list = ranks();
  const next = list.filter((r) => r.name.toLowerCase() !== name.toLowerCase());
  if (next.length === list.length || next.length === 0) return false;
  saveRanks(next);
  return true;
}
