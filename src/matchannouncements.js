import { baseEmbed, Colors, Brand } from './embeds.js';
import { clean, codeText } from './util.js';

const MATCH_TYPES = ['match_scheduled', 'match_start', 'match_end'];
const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
let dateFormatter;

function dateParts(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  dateFormatter ??= new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(dateFormatter.formatToParts(date)
    .filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}

function openingTime(data, now) {
  const start = dateParts(data.startsAt);
  if (!start) return codeText(data.slot, 40).replace(':', '.');
  const today = dateParts(now);
  const time = `${start.hour}.${start.minute}`;
  if (today && ['year', 'month', 'day'].every((key) => start[key] === today[key])) return time;
  return `${Number(start.day)} ${MONTHS[Number(start.month) - 1]}, Saat ${time}`;
}

function hostLabel(data) {
  const id = String(data.hostDiscordId ?? '').trim();
  if (/^\d{17,20}$/.test(id)) return `<@${id}>`;
  return clean(codeText(data.host ?? data.hostName, 80), 100);
}

function scenarioLabel(value) {
  const key = codeText(value, 80);
  const names = { no_fire: 'Fire Resistance', fire_resistance: 'Fire Resistance', veinminer: 'Vein Miner', vein_miner: 'Vein Miner' };
  if (names[key.toLowerCase()]) return names[key.toLowerCase()];
  if (!key.includes('_')) return key;
  return key.split('_').filter(Boolean).map((word) =>
    word[0].toUpperCase() + word.slice(1).toLowerCase()).join(' ');
}

function scenarioLine(scenarios) {
  const enabled = Array.isArray(scenarios) ? scenarios
    : scenarios && typeof scenarios === 'object'
      ? Object.keys(scenarios).filter((key) => scenarios[key] === true) : [];
  // Bound each input and the total separately so the host and status survive.
  const tags = [];
  let used = 0;
  for (const value of enabled) {
    const tag = `\`${scenarioLabel(value)}\``;
    if (used + tag.length + 1 > 1600) break;
    tags.push(tag);
    used += tag.length + 1;
  }
  return tags.length ? tags.join(' ') : '—';
}

function matchDescription(type, data, now) {
  const rawTeamSize = Number(data.teamSize);
  const teamSize = Number.isInteger(rawTeamSize) && rawTeamSize > 1 && rawTeamSize <= 100 ? `To${rawTeamSize}` : 'FFA';
  const prize = String(data.prize ?? '').trim();
  const status = type === 'match_start' ? '<:saat:1559054932211138640> **Açıldı**'
    : `<:saat:1559054932211138640> **Açılma Zamanı:** \`${openingTime(data, now)}\``;
  return '<:goldenapple:1336769041934585948> **Nautilus UHC Match**\n\n'
    + `${DIVIDER}\n\n`
    + `<:bayrak:1541604665064423484> **Takım Boyutu:** \`${teamSize}\`\n\n`
    + `<:kitap:1559053100625690734> **Senaryolar:**\n${scenarioLine(data.scenarios)}\n\n`
    + `<:NautilusUHC:1546552489975873640> **IP:** \`${Brand.domain}\`\n`
    + '<:yldz:1559054377526886444> **Version:** `1.21+`\n'
    + (prize ? `<:para:1559053003703717989> **Ödül:** ${clean(prize, 600)}\n` : '')
    + `\n${status}\n\n${DIVIDER}\n\n**Hosted by ${hostLabel(data)}**`;
}

function resultsDescription(data) {
  const rawWinners = data.winners ?? data.winner;
  const winners = Array.isArray(rawWinners)
    ? rawWinners.slice(0, 50).map((name) => codeText(name, 40)).join(' , ')
    : rawWinners;
  return '<:NautilusUHC:1546552489975873640> **NautilusUHC Maç Sonuçları:**\n\n'
    + `${DIVIDER}\n\n`
    + `<:kazanan:1559164230127722507> **Kazanan:** \`\`${codeText(winners, 1600)}\`\`\n`
    + `<a:mvp:1559164030403219466> **MVP:** \`${codeText(data.mvpName ?? data.mvp, 40)}\`\n\n`
    + `${DIVIDER}\n\nHosted by ${hostLabel(data)}`;
}

/** Shared live/test/DM match announcement builder; flags opt in to guild pings. */
export function buildMatchAnnouncement(type, data = {}, test = false, { now = Date.now() } = {}) {
  if (!MATCH_TYPES.includes(type)) return null;
  const embed = baseEmbed(Colors.brand).setFooter(null)
    .setDescription(type === 'match_end' ? resultsDescription(data) : matchDescription(type, data, now));
  const allowedMentions = { parse: [], users: [] };
  let content;
  if (!test && !(type === 'match_start' && data.plannedAnnouncement)) {
    const mentions = [data.mentionEveryone === true && '@everyone', data.mentionHere === true && '@here'].filter(Boolean);
    if (mentions.length) {
      content = `||${mentions.join(' ')}||`;
      // Discord's "everyone" parse category includes both @everyone and @here.
      allowedMentions.parse = ['everyone'];
    }
  }
  return { content, embeds: [embed], allowedMentions };
}

/** Safe, production-identical payloads for the current-channel admin preview. */
export function sampleMatchAnnouncements(hostDiscordId, options = {}) {
  const now = options.now ?? Date.now();
  const data = {
    hostDiscordId, host: options.host ?? 'Host', teamSize: options.teamSize ?? 1,
    startsAt: options.startsAt ?? now + 60 * 60 * 1000,
    scenarios: options.scenarios ?? ['safe_loot', 'auto_smelt', 'team_backpacks', 'lucky_ores', 'golden_heads', 'no_clean', 'hastey_boys', 'no_fall', 'time_bomb', 'shieldless', 'speedy_miners', 'anonymous', 'veinminer', 'no_fire'],
    prize: options.prize ?? '', winners: ['example1', 'example2', 'example3'], mvpName: 'example1',
  };
  const types = options.type && options.type !== 'all' ? [options.type] : MATCH_TYPES;
  return types.filter((type) => MATCH_TYPES.includes(type)).map((type) => ({
    type, data: { ...data }, payload: buildMatchAnnouncement(type, data, true, { now }),
  }));
}
