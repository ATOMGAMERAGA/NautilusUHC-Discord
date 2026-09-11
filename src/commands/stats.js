import {
  SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { Tier } from '../permissions.js';
import {
  baseEmbed, emptyEmbed, bridgeErrorEmbed, brandFooter, Colors, Assets,
} from '../embeds.js';
import { mcapi } from '../mcapi.js';
import { casesOfPage, caseCount } from '../db.js';
import { rankFor, rankLabel } from '../ranks.js';
import { clean, codeText, discordTime } from '../util.js';

/** Skin renders by username (works for offline-mode names too; unknown → Steve). */
const skinHead = (name) => `https://minotar.net/helm/${encodeURIComponent(name)}/128.png`;
const skinBody = (name) => `https://mc-heads.net/body/${encodeURIComponent(name)}/right`;

const MEDALS = ['🥇', '🥈', '🥉'];

const ACTION_LABELS = {
  ban: 'Ban', unban: 'Ban kaldırma', kick: 'Kick', mute: 'Susturma', unmute: 'Susturma kaldırma',
  warn: 'Uyarı', warn_delete: 'Uyarı silme', warn_clear: 'Uyarı temizleme',
  purge: 'Mesaj silme', mc_ban: 'MC ban', mc_unban: 'MC ban kaldırma', mc_mute: 'MC susturma',
  mc_unmute: 'MC susturma kaldırma', mc_kick: 'MC kick', mc_warn: 'MC uyarı',
  link_create: 'Hesap bağlama', link_delete: 'Bağlantı silme',
  softban: 'Softban', nick: 'Takma ad', note_add: 'Not', note_delete: 'Not silme',
  lockdown: 'Lockdown', lockdown_end: 'Lockdown bitişi',
  warn_auto_timeout: 'Otomatik susturma (uyarı eşiği)', warn_auto_ban: 'Otomatik ban (uyarı eşiği)',
  elorank_sync: 'Tier rol senkronu',
  ticket_open: 'Talep açıldı', ticket_close: 'Talep kapatıldı', ticket_reopen: 'Talep yeniden açıldı',
  ticket_claim: 'Talep üstlenildi', ticket_unclaim: 'Talep bırakıldı', ticket_assign: 'Talep atandı',
  ticket_priority: 'Talep önceliği', ticket_status: 'Talep durumu', ticket_note: 'Talep notu',
  ticket_rate: 'Talep değerlendirmesi',
};

function kd(kills, deaths) {
  return deaths === 0 ? kills.toFixed(2) : (kills / deaths).toFixed(2);
}

function winrate(wins, games) {
  return games === 0 ? '%0' : `%${Math.round((wins / games) * 100)}`;
}

async function profil(interaction) {
  const mcName = interaction.options.getString('oyuncu')?.trim();
  const user = interaction.options.getUser('kullanıcı');

  let query;
  if (mcName) query = `name=${encodeURIComponent(mcName)}`;
  else if (user) query = `discord=${user.id}`;
  else query = `discord=${interaction.user.id}`;

  const res = await mcapi.statsPlayer(query);
  if (!res.ok) return interaction.editReply({ embeds: [bridgeErrorEmbed(res, { context: 'oyuncu profili' })] });

  if (!res.found) {
    if (mcName) {
      return interaction.editReply({
        embeds: [emptyEmbed('Oyuncu Bulunamadı',
          `**${clean(mcName, 30)}** adına kayıtlı bir istatistik yok.`,
          'Oyuncunun en az bir maç oynamış olması gerekir.')],
      });
    }
    if (user) {
      return interaction.editReply({
        embeds: [emptyEmbed('Hesap Bağlı Değil',
          `${user} henüz bir Minecraft hesabı bağlamamış.`)],
      });
    }
    return interaction.editReply({
      embeds: [emptyEmbed('Hesabın Bağlı Değil',
        'Profil oluşturmak için önce Minecraft hesabını bağlaman gerekiyor.',
        'Minecraft sunucusunda `/link` yaz, sonra Discord\'daki `/link` komutundaki adımları izle.')],
    });
  }

  const rank = rankFor(res.elo);
  const losses = Math.max(0, res.games - res.wins);
  const embed = baseEmbed(rank.color ?? Colors.brand)
    .setTitle(`${rank.emoji ?? '🏅'} ${clean(res.name, 30)}`)
    .setDescription(`**${res.elo} ELO** • ${rankLabel(res.elo)} • Sıralama **#${res.rank}** / ${res.totalPlayers}`)
    .setThumbnail(skinHead(res.name))
    .setImage(skinBody(res.name))
    .addFields(
      {
        name: 'Maçlar',
        value: `Oynanan **${res.games}**\nKazanılan **${res.wins}** (${winrate(res.wins, res.games)})\nKaybedilen ${losses}`,
        inline: true,
      },
      {
        name: 'Dövüş',
        value: `Kill **${res.kills}**\nÖlüm ${res.deaths}\nK/D **${kd(res.kills, res.deaths)}**`,
        inline: true,
      },
      {
        name: 'Seri',
        value: `Güncel **${res.winStreak}**\nEn iyi ${res.bestStreak}\nZirve ELO ${res.peakElo}`,
        inline: true,
      },
    );

  if (res.discordId) {
    embed.addFields({ name: 'Discord', value: `<@${res.discordId}>`, inline: false });
  }

  const flags = [];
  if (res.ban) {
    flags.push(`🔨 **Yasaklı** — ${clean(res.ban.reason || 'sebep belirtilmemiş', 80)}`
      + (res.ban.expiresAt > 0 ? ` (bitiş ${discordTime(res.ban.expiresAt, 'f')})` : ' (kalıcı)'));
  }
  if (res.mute) {
    flags.push(`🔇 **Susturulmuş** — ${clean(res.mute.reason || 'sebep belirtilmemiş', 80)}`
      + (res.mute.expiresAt > 0 ? ` (bitiş ${discordTime(res.mute.expiresAt, 'f')})` : ' (kalıcı)'));
  }
  if (flags.length) embed.addFields({ name: 'Aktif Cezalar', value: flags.join('\n'), inline: false });

  return interaction.editReply({ embeds: [embed] });
}

async function siralama(interaction) {
  const by = interaction.options.getString('tür') ?? 'elo';
  const res = await mcapi.statsTop(by, 10);
  if (!res.ok) return interaction.editReply({ embeds: [bridgeErrorEmbed(res, { context: 'liderlik tablosu' })] });

  const players = res.players ?? [];
  if (!players.length) {
    return interaction.editReply({
      embeds: [emptyEmbed('Tablo Henüz Boş', 'Sıralama için yeterli maç oynanmamış.',
        'İlk maçlar tamamlandığında tablo dolmaya başlar.')],
    });
  }
  const titles = {
    elo: '🏆 ELO Sıralaması',
    wins: '🥇 Galibiyet Sıralaması',
    kills: '🗡️ Kill Sıralaması',
  };
  const lines = players.map((p, i) => {
    const place = MEDALS[i] ?? `\`${String(i + 1).padStart(2, ' ')}.\``;
    const value = by === 'wins' ? `${p.wins} galibiyet`
      : by === 'kills' ? `${p.kills} kill`
        : `${p.elo} ELO — ${rankLabel(p.elo)}`;
    return `${place} **${clean(p.name, 20)}** — ${value}`;
  });
  const embed = baseEmbed(Colors.brand)
    .setTitle(titles[by] ?? titles.elo)
    .setThumbnail(by === 'kills' ? Assets.item.diamondSword : Assets.item.goldenApple)
    .setDescription(lines.join('\n'))
    .setFooter(brandFooter(`İlk 10 / ${res.totalPlayers} oyuncu`));
  return interaction.editReply({ embeds: [embed] });
}

export default [
  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('profil')
      .setDescription('Bir oyuncunun ELO, rank ve maç istatistiklerini gösterir')
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
      .setDescription('Liderlik tablosunu gösterir (ELO, galibiyet veya kill)')
      .addStringOption((o) => o.setName('tür').setDescription('Sıralama ölçütü')
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
      .setDescription('Bir kullanıcının moderasyon geçmişini gösterir')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true)),
    async execute(interaction) {
      const user = interaction.options.getUser('kullanıcı', true);
      const payload = sicilPayload(user.id, user.tag, 0);
      return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
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
      embeds: [emptyEmbed('Sicil Temiz', `<@${userId}> için kayıtlı bir moderasyon işlemi yok.`)],
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
    .setTitle(`📋 Sicil — ${codeText(userTag ?? userId, 40)}`)
    .setDescription(lines.join('\n'))
    .setFooter(brandFooter(`Sayfa ${safePage + 1}/${pages}`, `${total} kayıt`));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sicil:${userId}:${safePage - 1}`).setLabel('Önceki')
      .setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
    new ButtonBuilder().setCustomId(`sicil:${userId}:${safePage + 1}`).setLabel('Sonraki')
      .setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pages - 1),
  );
  return { embeds: [embed], components: pages > 1 ? [row] : [] };
}
