import {
  SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { Tier } from '../permissions.js';
import { errEmbed, baseEmbed, Colors, Assets } from '../embeds.js';
import { mcapi } from '../mcapi.js';
import { casesOf, casesOfPage, caseCount } from '../db.js';
import { rankFor, rankLabel } from '../ranks.js';
import { clean, discordTime, formatDuration } from '../util.js';

/** Skin renders by username (works for offline-mode names too; unknown → Steve). */
const skinHead = (name) => `https://minotar.net/helm/${encodeURIComponent(name)}/128.png`;
const skinBody = (name) => `https://mc-heads.net/body/${encodeURIComponent(name)}/right`;

const MEDALS = ['🥇', '🥈', '🥉'];

const ACTION_LABELS = {
  ban: '🔨 Ban', unban: '🔓 Unban', kick: '👢 Kick', mute: '🔇 Mute', unmute: '🔊 Unmute',
  warn: '⚠️ Uyarı', warn_delete: '🧹 Uyarı silme', warn_clear: '🧹 Uyarı temizleme',
  purge: '🧹 Mesaj silme', mc_ban: '⛏️ MC Ban', mc_unban: '⛏️ MC Unban', mc_mute: '⛏️ MC Mute',
  mc_unmute: '⛏️ MC Unmute', mc_kick: '⛏️ MC Kick', mc_warn: '⛏️ MC Uyarı',
  link_create: '🔗 Hesap bağlama', link_delete: '🗑️ Bağlantı silme',
  softban: '🧽 Softban', nick: '✏️ Takma ad', note_add: '📝 Not', note_delete: '🗑️ Not silme',
  lockdown: '🔒 Lockdown', lockdown_end: '🔓 Lockdown bitişi',
  warn_auto_timeout: '⏱️ Otomatik timeout (uyarı eşiği)', warn_auto_ban: '🔨 Otomatik ban (uyarı eşiği)',
  elorank_sync: '🎨 Tier rol senkronu',
};

function kd(kills, deaths) {
  return deaths === 0 ? kills.toFixed(2) : (kills / deaths).toFixed(2);
}

function winrate(wins, games) {
  return games === 0 ? '0%' : `${Math.round((wins / games) * 100)}%`;
}

async function profil(interaction) {
  const mcName = interaction.options.getString('oyuncu')?.trim();
  const user = interaction.options.getUser('kullanıcı');

  let query;
  if (mcName) query = `name=${encodeURIComponent(mcName)}`;
  else if (user) query = `discord=${user.id}`;
  else query = `discord=${interaction.user.id}`;

  const res = await mcapi.statsPlayer(query);
  if (!res.ok) return interaction.editReply({ embeds: [errEmbed(`❌ ${res.error}`)] });
  if (!res.found) {
    const hint = mcName
      ? `**${clean(mcName, 30)}** adında kayıtlı bir oyuncu bulunamadı (en az bir maç oynamış olmalı).`
      : user
        ? `${user} bağlı bir Minecraft hesabına sahip değil.`
        : 'Hesabın bir Minecraft hesabına bağlı değil. Oyun içinde `/link` yaz, koda panel üzerinden gir.';
    return interaction.editReply({ embeds: [errEmbed(hint)] });
  }

  const rank = rankFor(res.elo);
  const losses = res.games - res.wins;
  const embed = baseEmbed(rank.color ?? Colors.main)
    .setTitle(`${rank.emoji ?? '🏅'} ${clean(res.name, 30)} — Oyuncu Profili`)
    .setThumbnail(skinHead(res.name))
    .setImage(skinBody(res.name))
    .addFields(
      {
        name: '🏆 ELO',
        value: `**${res.elo}** — ${rankLabel(res.elo)}\nZirve: ${res.peakElo}\nSıralama: **#${res.rank}** / ${res.totalPlayers}`,
        inline: true,
      },
      {
        name: '⚔️ Maçlar',
        value: `Oynanan: **${res.games}**\nKazanılan: **${res.wins}** (${winrate(res.wins, res.games)})\nKaybedilen: ${Math.max(0, losses)}`,
        inline: true,
      },
      {
        name: '🗡️ Dövüş',
        value: `Kill: **${res.kills}**\nÖlüm: ${res.deaths}\nK/D: **${kd(res.kills, res.deaths)}**`,
        inline: true,
      },
      {
        name: '🔥 Seri',
        value: `Aktif galibiyet serisi: **${res.winStreak}**\nEn iyi seri: ${res.bestStreak}`,
        inline: true,
      },
      {
        name: '🔗 Discord',
        value: res.discordId ? `<@${res.discordId}>` : 'Bağlı değil',
        inline: true,
      },
    );

  const flags = [];
  if (res.ban) {
    flags.push(`🔨 **Banlı** — ${clean(res.ban.reason || 'sebep yok', 80)}`
      + (res.ban.expiresAt > 0 ? ` (bitiş: ${discordTime(res.ban.expiresAt, 'f')})` : ' (kalıcı)'));
  }
  if (res.mute) {
    flags.push(`🔇 **Susturulmuş** — ${clean(res.mute.reason || 'sebep yok', 80)}`
      + (res.mute.expiresAt > 0 ? ` (bitiş: ${discordTime(res.mute.expiresAt, 'f')})` : ' (kalıcı)'));
  }
  if (flags.length) embed.addFields({ name: '🚫 Aktif Cezalar', value: flags.join('\n'), inline: false });

  return interaction.editReply({ embeds: [embed] });
}

async function siralama(interaction) {
  const by = interaction.options.getString('tür') ?? 'elo';
  const res = await mcapi.statsTop(by, 10);
  if (!res.ok) return interaction.editReply({ embeds: [errEmbed(`❌ ${res.error}`)] });
  const players = res.players ?? [];
  if (!players.length) {
    return interaction.editReply({ embeds: [baseEmbed(Colors.dark).setDescription('Henüz kayıtlı istatistik yok.')] });
  }
  const titles = { elo: '🏆 ELO Sıralaması', wins: '🥇 Galibiyet Sıralaması', kills: '🗡️ Kill Sıralaması' };
  const lines = players.map((p, i) => {
    const medal = MEDALS[i] ?? `**${i + 1}.**`;
    const value = by === 'wins' ? `${p.wins} galibiyet`
      : by === 'kills' ? `${p.kills} kill`
        : `${p.elo} ELO — ${rankLabel(p.elo)}`;
    return `${medal} \`${clean(p.name, 20)}\` — ${value}`;
  });
  const thumb = by === 'kills' ? Assets.item.diamondSword : Assets.item.goldenApple;
  const embed = baseEmbed(Colors.main)
    .setTitle(titles[by] ?? titles.elo)
    .setThumbnail(thumb)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Toplam ${res.totalPlayers} kayıtlı oyuncu • Nautilus PvP` });
  return interaction.editReply({ embeds: [embed] });
}

export default [
  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('profil')
      .setDescription('Bir oyuncunun Nautilus PvP profilini gösterir (skin, ELO, rank, maçlar)')
      .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft oyuncu adı'))
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Discord kullanıcısı (bağlı hesabı gösterilir)')),
    async execute(interaction) {
      await interaction.deferReply();
      return profil(interaction);
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('sıralama')
      .setDescription('Nautilus PvP liderlik tablosu')
      .addStringOption((o) => o.setName('tür').setDescription('Sıralama türü')
        .addChoices(
          { name: 'ELO', value: 'elo' },
          { name: 'Galibiyet', value: 'wins' },
          { name: 'Kill', value: 'kills' },
        )),
    async execute(interaction) {
      await interaction.deferReply();
      return siralama(interaction);
    },
  },

  {
    tier: Tier.REHBER,
    data: new SlashCommandBuilder()
      .setName('sicil')
      .setDescription('Bir kullanıcının bot moderasyon geçmişini gösterir (sayfalı)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true)),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const payload = sicilPayload(user.id, user.tag, 0);
      return interaction.reply({ ...payload, ephemeral: true });
    },
  },
];

/* ------------------------------------------------------------------ */
/* /sicil sayfalaması — components.js 'sicil' handler'ı da kullanır    */
/* ------------------------------------------------------------------ */

const SICIL_PAGE_SIZE = 10;

/** Sayfalı sicil embed'i + gezinme butonları. page 0 tabanlıdır. */
export function sicilPayload(userId, userTag, page) {
  const total = caseCount(userId);
  if (!total) {
    return {
      embeds: [baseEmbed(Colors.success)
        .setDescription(`<@${userId}> için kayıtlı bir işlem yok — sicili temiz. ✅`)],
      components: [],
    };
  }
  const pages = Math.max(1, Math.ceil(total / SICIL_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const cases = casesOfPage(userId, SICIL_PAGE_SIZE, safePage * SICIL_PAGE_SIZE);
  const lines = cases.map((c) => {
    const label = ACTION_LABELS[c.action] ?? c.action;
    const extra = [c.reason, c.detail].filter(Boolean).map((t) => clean(t, 60)).join(' • ');
    return `**#${c.id}** ${label} — ${discordTime(c.created_at, 'd')}${c.mod_id ? ` — <@${c.mod_id}>` : ''}`
      + (extra ? `\n└ ${extra}` : '');
  });
  const embed = baseEmbed(Colors.warn)
    .setTitle(`📋 Sicil — ${clean(userTag ?? userId, 40)}`)
    .setDescription(lines.join('\n').slice(0, 3900))
    .setFooter({ text: `Sayfa ${safePage + 1}/${pages} — toplam ${total} kayıt • Nautilus PvP` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sicil:${userId}:${safePage - 1}`).setLabel('◀ Önceki')
      .setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
    new ButtonBuilder().setCustomId(`sicil:${userId}:${safePage + 1}`).setLabel('Sonraki ▶')
      .setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pages - 1),
  );
  return { embeds: [embed], components: pages > 1 ? [row] : [] };
}
