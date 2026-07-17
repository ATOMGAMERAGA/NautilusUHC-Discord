import { baseEmbed, errEmbed, Colors, Assets } from './embeds.js';
import { formatSeconds, formatDuration, trDateTime, clean } from './util.js';

/**
 * Köprü verisinden embed üreten SAF modül — yalnız embeds/util'e bağımlıdır,
 * discord.js'e doğrudan dokunmaz; testler EmbedShim ile `.data` üzerinden
 * doğrular. Komut dosyaları (mac.js/mc.js) ve statusboard.js bunları kullanır.
 */

/** `/maç canlı`: sunucu + aktif maç durumunun zengin özeti. */
export function liveMatchEmbed(status, current) {
  if (!status?.ok) {
    return errEmbed(`❌ ${status?.error ?? 'Sunucuya ulaşılamadı.'}`);
  }
  const match = status.match ?? {};
  if (!match.active) {
    return baseEmbed(Colors.dark)
      .setTitle('💤 Aktif maç yok')
      .setDescription(`Sunucuda **${status.count ?? 0}** oyuncu çevrimiçi. `
        + 'Program için `/maç program` kullan.');
  }
  const e = baseEmbed(Colors.success)
    .setTitle('⚔️ Canlı Maç')
    .setThumbnail(Assets.item.diamondSword)
    .addFields(
      { name: 'Aşama', value: String(match.state ?? '?'), inline: true },
      { name: 'Geçen Süre', value: formatSeconds(match.elapsedSecs ?? 0), inline: true },
      { name: 'Hayatta', value: `${match.aliveCount ?? '?'} / ${match.participantCount ?? '?'}`, inline: true },
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
  if (match.scenarios?.length) {
    e.addFields({ name: 'Senaryolar', value: match.scenarios.join(', '), inline: true });
  }
  const alive = current?.ok ? current.alive : null;
  if (alive?.length) {
    e.addFields({
      name: `🟢 Hayatta Kalanlar (${alive.length})`,
      value: alive.map((n) => `\`${clean(n, 20)}\``).join(', ').slice(0, 1020),
    });
  }
  return e;
}

/** `/takımlar`: aktif maç takım kadroları. */
export function teamsEmbed(res) {
  if (!res?.ok) return errEmbed(`❌ ${res?.error ?? 'Sunucuya ulaşılamadı.'}`);
  const teams = res.teams ?? [];
  if (res.ffa || !teams.length) {
    return baseEmbed(Colors.dark)
      .setTitle('👥 Takımlar')
      .setDescription(res.ffa
        ? 'Bu maç **FFA (solo)** — takım yok.'
        : 'Şu anda kurulmuş takım yok.');
  }
  const e = baseEmbed(Colors.main)
    .setTitle(`👥 Takımlar — To${res.teamSize ?? '?'} (${teams.length} takım)`);
  for (const t of teams.slice(0, 24)) {
    const members = (t.members ?? []).map((m) => `${m.alive ? '🟢' : '💀'} ${clean(m.name, 20)}`
      + `${t.leaderName === m.name ? ' 👑' : ''}${m.online ? '' : ' (çevrimdışı)'}`).join('\n') || '*boş*';
    e.addFields({ name: `${clean(t.id, 20)}`, value: members.slice(0, 1020), inline: true });
  }
  return e;
}

/** `/senaryolar`: kayıtlı tüm senaryolar (aktifler işaretli). */
export function scenariosEmbed(res) {
  if (!res?.ok) return errEmbed(`❌ ${res?.error ?? 'Sunucuya ulaşılamadı.'}`);
  const list = res.scenarios ?? [];
  const active = list.filter((s) => s.active);
  const e = baseEmbed(Colors.main)
    .setTitle('🎲 Senaryolar')
    .setDescription(active.length
      ? `Şu an aktif: ${active.map((s) => `**${clean(s.name, 30)}**`).join(', ')}`
      : 'Şu an aktif senaryo yok. Tüm liste aşağıda:');
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
  if (!res?.ok) return errEmbed(`❌ ${res?.error ?? 'Sunucuya ulaşılamadı.'}`);
  const players = res.players ?? [];
  const e = baseEmbed(Colors.info)
    .setTitle(`📋 Maç Kuyruğu — ${res.size ?? players.length} oyuncu`)
    .setDescription(players.length
      ? players.map((n) => `\`${clean(n, 20)}\``).join(', ').slice(0, 3900)
      : 'Kuyruk boş. Oyun içinde `/maç katıl` ile kaydolunur.');
  e.addFields(
    { name: 'Hesap bağlama', value: res.requireLink ? 'Zorunlu' : 'Serbest', inline: true },
    { name: 'Kayıt şartı', value: res.requireJoin ? 'Zorunlu (/maç katıl)' : 'Serbest', inline: true },
  );
  return e;
}

/** `/sunucuperf`: TPS/MSPT/bellek/uptime. */
export function perfEmbed(res) {
  if (!res?.ok) return errEmbed(`❌ ${res?.error ?? 'Sunucuya ulaşılamadı.'}`);
  const tps = res.tps ?? {};
  const tpsIcon = (v) => (v >= 19.5 ? '🟢' : v >= 17 ? '🟡' : '🔴');
  const mem = res.memory ?? {};
  return baseEmbed(Colors.main)
    .setTitle('📈 Sunucu Performansı')
    .addFields(
      { name: 'TPS (1dk / 5dk / 15dk)', value: `${tpsIcon(tps.m1 ?? 0)} ${tps.m1 ?? '?'} / ${tps.m5 ?? '?'} / ${tps.m15 ?? '?'}`, inline: false },
      { name: 'MSPT', value: `${res.mspt ?? '?'} ms`, inline: true },
      { name: 'Bellek', value: `${mem.usedMb ?? '?'} / ${mem.maxMb ?? '?'} MB`, inline: true },
      { name: 'Uptime', value: formatSeconds(res.uptimeSecs ?? 0), inline: true },
      { name: 'Çevrimiçi', value: String(res.onlineCount ?? '?'), inline: true },
    );
}

/** `/mcsicil`: oyuncunun kalıcı MC ceza geçmişi. */
export function modHistoryEmbed(player, res) {
  if (!res?.ok) return errEmbed(`❌ ${res?.error ?? 'Sunucuya ulaşılamadı.'}`);
  const entries = res.entries ?? [];
  const ICONS = { ban: '🔨', unban: '🔓', mute: '🔇', unmute: '🔊', kick: '👢', warn: '⚠️' };
  const e = baseEmbed(Colors.warn)
    .setTitle(`📜 MC Sicil — ${clean(player, 30)} (${entries.length} kayıt)`);
  if (!entries.length) {
    return e.setDescription('Bu oyuncunun ceza geçmişi temiz. 🎉');
  }
  e.setDescription(entries.slice(0, 20).map((r) => {
    const dur = r.durationMs > 0 ? ` (${formatDuration(r.durationMs)})` : '';
    const reason = r.reason ? ` — ${clean(r.reason, 60)}` : '';
    return `${ICONS[r.action] ?? '•'} **${r.action}**${dur} • ${clean(r.staff ?? '?', 25)} • ${trDateTime(r.createdAt)}${reason}`;
  }).join('\n').slice(0, 3900));
  return e;
}

/** `/mcbanlist` & `/mcmutelist`: aktif ceza listesi. */
export function modListEmbed(res) {
  if (!res?.ok) return errEmbed(`❌ ${res?.error ?? 'Sunucuya ulaşılamadı.'}`);
  const entries = res.entries ?? [];
  const isBan = res.type !== 'mute';
  const e = baseEmbed(isBan ? Colors.danger : Colors.warn)
    .setTitle(`${isBan ? '🔨 Aktif Banlar' : '🔇 Aktif Susturmalar'} — ${entries.length}`);
  if (!entries.length) {
    return e.setDescription(isBan ? 'Aktif ban yok.' : 'Aktif susturma yok.');
  }
  e.setDescription(entries.slice(0, 20).map((r) => {
    const expiry = r.expiresAt > 0 ? `bitiş: ${trDateTime(r.expiresAt)}` : '**kalıcı**';
    const reason = r.reason ? ` — ${clean(r.reason, 50)}` : '';
    return `• **${clean(r.player, 25)}** (${clean(r.staff ?? '?', 20)}, ${expiry})${reason}`;
  }).join('\n').slice(0, 3900));
  if (entries.length > 20) {
    e.addFields({ name: 'Not', value: `İlk 20 gösteriliyor; toplam ${entries.length} kayıt var.` });
  }
  return e;
}

/** Durum panosu embed'i (60 sn'de bir düzenlenen sabit mesaj). */
export function statusBoardEmbed(status, perf) {
  if (!status?.ok) {
    return baseEmbed(Colors.danger)
      .setTitle('🔌 Sunucuya ulaşılamıyor')
      .setDescription('Minecraft sunucusuyla bağlantı kurulamadı. '
        + 'Bağlantı gelince bu pano otomatik güncellenir.');
  }
  const match = status.match ?? {};
  const e = baseEmbed(match.active ? Colors.success : Colors.main)
    .setTitle('🌊 Nautilus PvP — Canlı Durum')
    .addFields(
      { name: 'Sunucu', value: '🟢 Çevrimiçi', inline: true },
      { name: 'Oyuncular', value: String(status.count ?? 0), inline: true },
      { name: 'Maç', value: match.active ? `⚔️ ${match.state}` : '💤 Aktif maç yok', inline: true },
    );
  if (match.active) {
    e.addFields(
      { name: 'Hayatta', value: `${match.aliveCount ?? '?'} / ${match.participantCount ?? '?'}`, inline: true },
      { name: 'Geçen Süre', value: formatSeconds(match.elapsedSecs ?? 0), inline: true },
      { name: 'Border', value: match.borderSize != null ? `±${match.borderSize}` : '—', inline: true },
    );
  }
  if (perf?.ok) {
    e.addFields({
      name: 'Performans',
      value: `TPS ${perf.tps?.m1 ?? '?'} • ${perf.mspt ?? '?'} ms • ${perf.memory?.usedMb ?? '?'}/${perf.memory?.maxMb ?? '?'} MB`,
      inline: false,
    });
  }
  e.addFields({ name: 'IP', value: '`nautilusuhc.com`', inline: false });
  return e;
}
