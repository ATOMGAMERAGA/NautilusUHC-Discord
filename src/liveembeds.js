import {
  baseEmbed, emptyEmbed, bridgeErrorEmbed, Colors, Assets, Brand,
} from './embeds.js';
import {
  formatSeconds, formatDuration, trDateTime, clean, codeText,
} from './util.js';

/**
 * Köprü verisinden embed üreten SAF modül — yalnız embeds/util'e bağımlıdır,
 * discord.js'e doğrudan dokunmaz; testler EmbedShim ile `.data` üzerinden
 * doğrular. Komut dosyaları (mac.js/mc.js) ve statusboard.js bunları kullanır.
 *
 * Ortak tasarım dili:
 *  - Başlık kısa ve durumu söyler; en fazla tek anlamlı emoji taşır.
 *  - Alan adları süssüzdür; emoji yalnız DURUM işareti olarak kullanılır
 *    (🟢 çevrimiçi / 💀 elenmiş gibi).
 *  - Bilgi önem sırasına göre dizilir: önce "ne oluyor", sonra ayrıntı.
 *  - Boş sonuçlar "yok" demez; bağlamı ve sıradaki adımı gösterir.
 */

/** Oyuncu adı listesini kod aralıklı, limite sığan tek satıra çevirir. */
export function nameList(names, { limit = 40, max = 1000 } = {}) {
  const list = (names ?? []).slice(0, limit).map((n) => `\`${codeText(n, 20)}\``).join(' ');
  const rest = (names?.length ?? 0) - limit;
  const suffix = rest > 0 ? ` +${rest}` : '';
  return `${list}${suffix}`.slice(0, max);
}

/** Sağlık göstergesi noktası. */
const dot = (ok, warn = false) => (ok ? '🟢' : warn ? '🟡' : '🔴');

/** `/maç canlı`: sunucu + aktif maç durumunun canlı skorboardu. */
export function liveMatchEmbed(status, current) {
  if (!status?.ok) return bridgeErrorEmbed(status, { context: 'sunucu durumu' });

  const match = status.match ?? {};
  if (!match.active) {
    return emptyEmbed(
      'Aktif Maç Yok',
      `Şu anda devam eden bir UHC maçı bulunmuyor. Sunucuda **${status.count ?? 0}** oyuncu çevrimiçi.`,
      'Sonraki maç saatlerini `/maç program` ile görebilirsin.',
    );
  }

  const e = baseEmbed(Colors.success)
    .setTitle('⚔️ Canlı Maç')
    .setThumbnail(Assets.item.diamondSword)
    .addFields(
      { name: 'Aşama', value: clean(match.state ?? '—', 40), inline: true },
      { name: 'Hayatta', value: `**${match.aliveCount ?? '?'}** / ${match.participantCount ?? '?'}`, inline: true },
      { name: 'Geçen Süre', value: formatSeconds(match.elapsedSecs ?? 0), inline: true },
    );

  if (match.secondsUntilPvp > 0) {
    e.addFields({ name: "PvP'ye Kalan", value: formatSeconds(match.secondsUntilPvp), inline: true });
  }
  if (match.secondsUntilHeal > 0) {
    e.addFields({ name: "Heal'e Kalan", value: formatSeconds(match.secondsUntilHeal), inline: true });
  }
  if (match.borderSize != null) {
    e.addFields({ name: 'Border', value: `±${match.borderSize}`, inline: true });
  }
  if (match.teamSize != null) {
    e.addFields({ name: 'Mod', value: match.teamSize > 1 ? `To${match.teamSize}` : 'FFA (Solo)', inline: true });
  }
  if (match.scenarios?.length) {
    e.addFields({ name: 'Senaryolar', value: clean(match.scenarios.join(', '), 300), inline: true });
  }

  const alive = current?.ok ? current.alive : null;
  if (alive?.length) {
    e.addFields({ name: `Hayatta Kalanlar (${alive.length})`, value: nameList(alive) });
  }
  return e;
}

/** `/takımlar`: aktif maç takım kadroları. */
export function teamsEmbed(res) {
  if (!res?.ok) return bridgeErrorEmbed(res, { context: 'takım listesi' });

  const teams = res.teams ?? [];
  if (res.ffa || !teams.length) {
    return res.ffa
      ? emptyEmbed('Takım Yok', 'Bu maç **FFA (solo)** oynanıyor — takım kadrosu bulunmuyor.')
      : emptyEmbed('Takım Yok', 'Henüz kurulmuş bir takım yok.',
        'Oyun içinde `/team invite <oyuncu>` ile takım kurabilirsin.');
  }

  const e = baseEmbed(Colors.brand)
    .setTitle(`👥 Takımlar — To${res.teamSize ?? '?'}`)
    .setDescription(`${teams.length} takım sahada.`);
  for (const t of teams.slice(0, 24)) {
    const members = (t.members ?? []).map((m) => `${m.alive ? '🟢' : '💀'} ${clean(m.name, 20)}`
      + `${t.leaderName === m.name ? ' 👑' : ''}${m.online ? '' : ' (çevrimdışı)'}`).join('\n') || '*boş*';
    e.addFields({ name: `${clean(t.id, 20)}`, value: members, inline: true });
  }
  return e;
}

/** `/senaryolar`: kayıtlı tüm senaryolar (aktifler işaretli). */
export function scenariosEmbed(res) {
  if (!res?.ok) return bridgeErrorEmbed(res, { context: 'senaryo listesi' });

  const list = res.scenarios ?? [];
  if (!list.length) {
    return emptyEmbed('Senaryo Yok', 'Sunucuda tanımlı bir senaryo bulunmuyor.');
  }
  const active = list.filter((s) => s.active);
  const e = baseEmbed(Colors.brand)
    .setTitle('🎲 Senaryolar')
    .setDescription(active.length
      ? `Şu an aktif: ${active.map((s) => `**${clean(s.name, 30)}**`).join(', ')}`
      : 'Şu anda aktif senaryo yok. Tüm liste aşağıda.');
  for (const s of list.slice(0, 25)) {
    e.addFields({
      name: `${s.active ? '✅' : '▫️'} ${clean(s.name, 40)}`,
      value: clean(s.lore || '—', 200),
      inline: false,
    });
  }
  return e;
}

/** `/sıra`: maç katılım kuyruğu. */
export function queueEmbed(res) {
  if (!res?.ok) return bridgeErrorEmbed(res, { context: 'maç kuyruğu' });

  const players = res.players ?? [];
  const e = baseEmbed(players.length ? Colors.info : Colors.neutral)
    .setTitle(`📋 Maç Kuyruğu — ${res.size ?? players.length} oyuncu`)
    .setDescription(players.length
      ? nameList(players, { limit: 100, max: 3800 })
      : 'Kuyruk boş. Oyun içinde `/maç katıl` yazarak sıraya girebilirsin.')
    .addFields(
      { name: 'Hesap bağlama', value: res.requireLink ? 'Zorunlu' : 'Serbest', inline: true },
      { name: 'Kayıt şartı', value: res.requireJoin ? 'Zorunlu (/maç katıl)' : 'Serbest', inline: true },
    );
  return e;
}

/** `/sunucuperf`: TPS/MSPT/bellek/uptime. */
export function perfEmbed(res) {
  if (!res?.ok) return bridgeErrorEmbed(res, { context: 'sunucu performansı' });

  const tps = res.tps ?? {};
  const m1 = tps.m1 ?? 0;
  const mem = res.memory ?? {};
  return baseEmbed(m1 >= 19.5 ? Colors.success : m1 >= 17 ? Colors.warn : Colors.danger)
    .setTitle('📈 Sunucu Performansı')
    .addFields(
      {
        name: 'TPS (1dk / 5dk / 15dk)',
        value: `${dot(m1 >= 19.5, m1 >= 17)} ${tps.m1 ?? '?'} / ${tps.m5 ?? '?'} / ${tps.m15 ?? '?'}`,
        inline: false,
      },
      { name: 'MSPT', value: `${res.mspt ?? '?'} ms`, inline: true },
      { name: 'Bellek', value: `${mem.usedMb ?? '?'} / ${mem.maxMb ?? '?'} MB`, inline: true },
      { name: 'Uptime', value: formatSeconds(res.uptimeSecs ?? 0), inline: true },
      { name: 'Çevrimiçi', value: String(res.onlineCount ?? '?'), inline: true },
    )
    .setTimestamp();
}

/** `/mcsicil`: oyuncunun kalıcı MC ceza geçmişi. */
export function modHistoryEmbed(player, res) {
  if (!res?.ok) return bridgeErrorEmbed(res, { context: 'MC ceza geçmişi' });

  const entries = res.entries ?? [];
  if (!entries.length) {
    return emptyEmbed(`Sicil Temiz — ${clean(player, 30)}`,
      'Bu oyuncunun Minecraft tarafında kayıtlı bir cezası bulunmuyor.');
  }
  const ICONS = { ban: '🔨', unban: '🔓', mute: '🔇', unmute: '🔊', kick: '👢', warn: '⚠️' };
  return baseEmbed(Colors.warn)
    .setTitle(`📜 MC Sicil — ${clean(player, 30)}`)
    .setDescription(entries.slice(0, 20).map((r) => {
      const dur = r.durationMs > 0 ? ` (${formatDuration(r.durationMs)})` : '';
      const reason = r.reason ? ` — ${clean(r.reason, 60)}` : '';
      return `${ICONS[r.action] ?? '•'} **${r.action}**${dur} • ${clean(r.staff ?? '?', 25)} • ${trDateTime(r.createdAt)}${reason}`;
    }).join('\n').slice(0, 3900))
    .setFooter({
      text: entries.length > 20
        ? `İlk 20 kayıt • toplam ${entries.length} • ${Brand.community}`
        : `${entries.length} kayıt • ${Brand.community}`,
      iconURL: Assets.mark,
    });
}

/** `/mcbanlist` & `/mcmutelist`: aktif ceza listesi. */
export function modListEmbed(res) {
  if (!res?.ok) return bridgeErrorEmbed(res, { context: 'MC ceza listesi' });

  const entries = res.entries ?? [];
  const isBan = res.type !== 'mute';
  if (!entries.length) {
    return emptyEmbed(isBan ? 'Aktif Ban Yok' : 'Aktif Susturma Yok',
      isBan
        ? 'Minecraft sunucusunda şu anda yasaklı oyuncu bulunmuyor.'
        : 'Minecraft sunucusunda şu anda susturulmuş oyuncu bulunmuyor.');
  }
  const e = baseEmbed(isBan ? Colors.danger : Colors.warn)
    .setTitle(`${isBan ? '🔨 Aktif Banlar' : '🔇 Aktif Susturmalar'} — ${entries.length}`)
    .setDescription(entries.slice(0, 20).map((r) => {
      const expiry = r.expiresAt > 0 ? `bitiş: ${trDateTime(r.expiresAt)}` : '**kalıcı**';
      const reason = r.reason ? ` — ${clean(r.reason, 50)}` : '';
      return `• **${clean(r.player, 25)}** (${clean(r.staff ?? '?', 20)}, ${expiry})${reason}`;
    }).join('\n').slice(0, 3900));
  if (entries.length > 20) {
    e.setFooter({ text: `İlk 20 gösteriliyor • toplam ${entries.length} • ${Brand.community}`, iconURL: Assets.mark });
  }
  return e;
}

/**
 * Durum panosu (60 sn'de bir düzenlenen sabit mesaj).
 *
 * Dashboard mantığı: bir bakışta sunucu ayakta mı, kaç kişi var, maç var mı.
 * Teknik tanı ekranı DEĞİLDİR — ayrıntılı sağlık için /sağlık kullanılır.
 * Zaman damgası "son güncelleme" anlamı taşıdığı için burada bilerek vardır
 * (statusboard.js hash'inde hariç tutulur, boşuna edit üretmez).
 */
export function statusBoardEmbed(status, perf) {
  if (!status?.ok) {
    return baseEmbed(Colors.danger)
      .setTitle('🔌 Sunucuya Ulaşılamıyor')
      .setDescription('Minecraft sunucusuyla bağlantı kurulamadı. '
        + 'Bağlantı geri geldiğinde bu pano kendini günceller.')
      .setTimestamp();
  }

  const match = status.match ?? {};
  const e = baseEmbed(match.active ? Colors.success : Colors.brand)
    .setTitle(`🌊 ${Brand.community} — Canlı Durum`)
    .addFields(
      { name: 'Sunucu', value: '🟢 Çevrimiçi', inline: true },
      { name: 'Oyuncular', value: String(status.count ?? 0), inline: true },
      { name: 'Maç', value: match.active ? `⚔️ ${clean(match.state ?? 'devam ediyor', 30)}` : '💤 Aktif maç yok', inline: true },
    );
  if (match.active) {
    e.addFields(
      { name: 'Hayatta', value: `**${match.aliveCount ?? '?'}** / ${match.participantCount ?? '?'}`, inline: true },
      { name: 'Geçen Süre', value: formatSeconds(match.elapsedSecs ?? 0), inline: true },
      { name: 'Border', value: match.borderSize != null ? `±${match.borderSize}` : '—', inline: true },
    );
  }
  if (perf?.ok) {
    const m1 = perf.tps?.m1 ?? 0;
    e.addFields({
      name: 'Performans',
      value: `${dot(m1 >= 19.5, m1 >= 17)} TPS ${perf.tps?.m1 ?? '?'} • ${perf.mspt ?? '?'} ms • `
        + `${perf.memory?.usedMb ?? '?'}/${perf.memory?.maxMb ?? '?'} MB`,
      inline: false,
    });
  }
  e.addFields({ name: 'Sunucu adresi', value: `\`${Brand.domain}\``, inline: false })
    .setFooter({ text: `Otomatik güncellenir • ${Brand.community}`, iconURL: Assets.mark })
    .setTimestamp();
  return e;
}
