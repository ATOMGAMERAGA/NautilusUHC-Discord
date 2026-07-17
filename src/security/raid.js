import { getSetting, addGuardHit } from '../db.js';
import { sendLog } from '../modlog.js';
import { Colors } from '../embeds.js';

/**
 * Raid koruması: (1) minimum hesap yaşı kapısı, (2) katılım-hızı alarmı.
 * Pencere aşılırsa geçici "raid modu"na girilir; moddayken yeni katılımlar
 * loglanır ve ayara göre atılır. Saf yardımcılar (joinRateExceeded /
 * accountTooYoung) discord.js'siz test edilir. /admin raidkoruma ile yönetilir.
 *
 * Settings: raid_enabled('0'), raid_join_limit(8), raid_window_secs(30),
 *           raid_min_account_age_days(0=kapalı), raid_action('kick'|'log').
 */

function intSetting(key, fallback) {
  const n = Number.parseInt(getSetting(key, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function raidSettings() {
  return {
    enabled: getSetting('raid_enabled', '0') === '1',
    joinLimit: intSetting('raid_join_limit', 8),
    windowSecs: intSetting('raid_window_secs', 30),
    minAccountAgeDays: Number.parseInt(getSetting('raid_min_account_age_days', '0'), 10) || 0,
    action: getSetting('raid_action', 'kick') === 'log' ? 'log' : 'kick',
  };
}

/** Saf: pencere içindeki katılım sayısı limiti aştı mı? */
export function joinRateExceeded(timestamps, limit, windowMs, now = Date.now()) {
  let recent = 0;
  for (const t of timestamps) {
    if (now - t < windowMs) recent++;
  }
  return recent > limit;
}

/** Saf: hesap, istenen minimum yaştan genç mi? (minDays<=0 → kapalı) */
export function accountTooYoung(createdTs, minDays, now = Date.now()) {
  if (!minDays || minDays <= 0) return false;
  return now - createdTs < minDays * 86_400_000;
}

export function registerRaidProtection(client) {
  const joins = [];
  let raidModeUntil = 0;

  client.on('guildMemberAdd', async (member) => {
    try {
      const cfg = raidSettings();
      if (!cfg.enabled || member.user?.bot) return;
      const now = Date.now();

      // 1) Minimum hesap yaşı kapısı.
      if (accountTooYoung(member.user.createdTimestamp, cfg.minAccountAgeDays, now)) {
        addGuardHit(member.id, 'raid_age', `hesap ${cfg.minAccountAgeDays} günden yeni`);
        await member.send('**Nautilus PvP** — Güvenlik nedeniyle çok yeni Discord hesapları '
          + `sunucuya alınmıyor. Hesabın ${cfg.minAccountAgeDays} günü doldurduğunda tekrar bekleriz.`)
          .catch(() => null);
        await member.kick('Raid koruması: minimum hesap yaşı').catch(() => null);
        await sendLog(client, {
          title: '🛡️ Raid Koruması — Yeni Hesap Engellendi',
          color: Colors.warn,
          description: `**${member.user.tag}** (\`${member.id}\`) — hesap `
            + `${cfg.minAccountAgeDays} günden yeni olduğu için atıldı.`,
        });
        return;
      }

      // 2) Katılım-hızı penceresi.
      joins.push(now);
      if (joins.length > 500) joins.splice(0, joins.length - 500);
      const windowMs = cfg.windowSecs * 1000;
      const inRaidMode = now < raidModeUntil;
      if (inRaidMode || joinRateExceeded(joins, cfg.joinLimit, windowMs, now)) {
        const freshAlarm = !inRaidMode;
        raidModeUntil = now + windowMs * 2;
        addGuardHit(member.id, 'raid_join', `${cfg.windowSecs}sn penceresinde yoğun katılım`);
        if (freshAlarm) {
          await sendLog(client, {
            title: '🚨 RAID ALARMI',
            color: Colors.danger,
            description: `${cfg.windowSecs} saniyede ${cfg.joinLimit}+ katılım algılandı. `
              + `Raid modu ${Math.round((windowMs * 2) / 1000)} sn aktif — yeni katılımlar `
              + `${cfg.action === 'kick' ? 'ATILACAK' : 'yalnız loglanacak'}. `
              + '`/admin raidkoruma` ile yönetebilirsin.',
          }).catch(() => null);
        }
        if (cfg.action === 'kick') {
          await member.send('**Nautilus PvP** — Şu anda yoğun katılım koruması aktif. '
            + 'Birkaç dakika sonra tekrar katılmayı dene.').catch(() => null);
          await member.kick('Raid koruması: toplu katılım').catch(() => null);
        }
      }
    } catch (err) {
      console.error('[raid] katılım işlenemedi:', err.message);
    }
  });
}
