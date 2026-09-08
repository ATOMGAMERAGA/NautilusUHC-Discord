import { getSetting, addGuardHit } from '../db.js';
import { sendLog } from '../modlog.js';
import { baseEmbed, Colors, Brand } from '../embeds.js';

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
        // Kullanıcıya suçlayıcı değil, açıklayıcı bir mesaj: ne oldu, neden,
        // ne yapabilir. Güvenlik eşikleri (limit/pencere) paylaşılmaz.
        await member.send({
          embeds: [baseEmbed(Colors.warn)
            .setTitle('Sunucuya Şu An Katılamıyorsun')
            .setDescription(`${Brand.community} sunucusu, çok yeni oluşturulmuş Discord hesaplarını `
              + 'güvenlik gereği geçici olarak kabul etmiyor. Bu bir ceza değildir.')
            .addFields({
              name: 'Ne yapabilirsin',
              value: `Hesabın ${cfg.minAccountAgeDays} günü doldurduğunda davet linkiyle tekrar katılabilirsin.\n`
                + 'Bunun bir yanlışlık olduğunu düşünüyorsan sunucudaki bir yetkiliye ulaşabilirsin.',
            })],
        }).catch(() => null);
        await member.kick('Raid koruması: minimum hesap yaşı').catch(() => null);
        await sendLog(client, {
          title: 'Raid Koruması — Yeni Hesap Engellendi',
          color: Colors.warn,
          fields: [
            { name: 'Kullanıcı', value: `${member.user.tag} (\`${member.id}\`)`, inline: true },
            { name: 'Sebep', value: `Hesap ${cfg.minAccountAgeDays} günden yeni`, inline: true },
          ],
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
            title: 'Raid Alarmı',
            color: Colors.danger,
            description: 'Kısa sürede olağan dışı sayıda katılım algılandı, raid modu devreye girdi.',
            fields: [
              { name: 'Algılanan', value: `${cfg.windowSecs} sn içinde ${cfg.joinLimit}+ katılım`, inline: true },
              { name: 'Raid modu', value: `${Math.round((windowMs * 2) / 1000)} sn aktif`, inline: true },
              {
                name: 'Yeni katılımlar',
                value: cfg.action === 'kick' ? 'Otomatik atılıyor' : 'Yalnız kaydediliyor',
                inline: true,
              },
              { name: 'Yönetim', value: '`/admin raidkoruma` ile ayarları değiştirebilirsin.', inline: false },
            ],
          }).catch(() => null);
        }
        if (cfg.action === 'kick') {
          await member.send({
            embeds: [baseEmbed(Colors.warn)
              .setTitle('Katılım Geçici Olarak Kısıtlandı')
              .setDescription(`${Brand.community} sunucusunda şu anda yoğun katılım koruması aktif. `
                + 'Bu bir ceza değildir ve seninle ilgili bir kayıt oluşturmaz.')
              .addFields({
                name: 'Ne yapabilirsin',
                value: 'Birkaç dakika sonra davet linkiyle tekrar katılmayı deneyebilirsin.',
              })],
          }).catch(() => null);
          await member.kick('Raid koruması: toplu katılım').catch(() => null);
        }
      }
    } catch (err) {
      console.error('[raid] katılım işlenemedi:', err.message);
    }
  });
}
