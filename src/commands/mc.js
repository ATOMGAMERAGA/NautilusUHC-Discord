import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Tier } from '../permissions.js';
import {
  okEmbed, errEmbed, baseEmbed, emptyEmbed, bridgeErrorEmbed, Colors, Brand,
} from '../embeds.js';
import { mcapi } from '../mcapi.js';
import { addCase } from '../db.js';
import { parseDuration, formatDuration, formatSeconds, clean, codeText } from '../util.js';
import { perfEmbed, modHistoryEmbed, modListEmbed, nameList } from '../liveembeds.js';
import { sendLog } from '../modlog.js';

/**
 * Minecraft-side moderation & status. Every command talks to the NautilusUHC
 * plugin bridge, so Discord staff can moderate the game server without touching
 * the console.
 *
 * Yaptırım sonucu iki yüzeyde farklı görünür: yetkiliye kısa bir onay kartı,
 * log kanalına sabit alan düzeninde ayrıntılı kayıt.
 */

/** Yaptırımın kullanıcıya görünen adı — "mute" gibi teknik anahtar gösterilmez. */
const ACTION_LABELS = {
  ban: { done: 'Sunucudan Yasaklandı', log: 'MC Ban' },
  unban: { done: 'Yasak Kaldırıldı', log: 'MC Ban Kaldırma' },
  mute: { done: 'Sohbette Susturuldu', log: 'MC Susturma' },
  unmute: { done: 'Susturma Kaldırıldı', log: 'MC Susturma Kaldırma' },
  kick: { done: 'Sunucudan Atıldı', log: 'MC Kick' },
  warn: { done: 'Uyarı Verildi', log: 'MC Uyarı' },
};

async function runModAction(interaction, action, { needDuration = false, allowDuration = false, needReason = false } = {}) {
  const player = interaction.options.getString('oyuncu', true).trim();
  const rawDuration = allowDuration || needDuration ? interaction.options.getString('süre') : null;
  const reason = interaction.options.getString('sebep') ?? (needReason ? null : 'Discord üzerinden');

  let durationMs;
  if (rawDuration) {
    durationMs = parseDuration(rawDuration);
    if (!durationMs) {
      return interaction.reply({
        embeds: [errEmbed('Süreyi anlayamadım. Örnek: `10dk`, `2sa`, `7g`.', 'Geçersiz Süre')],
        ephemeral: true,
      });
    }
  }

  await interaction.deferReply();
  const res = await mcapi.mod(action, player, { reason, durationMs });
  if (!res.ok) {
    return interaction.editReply({ embeds: [bridgeErrorEmbed(res, { context: `MC ${action}` })] });
  }

  const labels = ACTION_LABELS[action] ?? { done: 'İşlem Uygulandı', log: `MC ${action}` };
  addCase(`mc_${action}`, null, interaction.user.id, reason, `${player}${durationMs ? ` / ${formatDuration(durationMs)}` : ''}`);
  await sendLog(interaction.client, {
    title: labels.log,
    color: action === 'ban' ? Colors.danger : Colors.warn,
    fields: [
      { name: 'Oyuncu', value: `\`${codeText(player, 40)}\``, inline: true },
      { name: 'Yetkili', value: `${interaction.user}`, inline: true },
      { name: 'Süre', value: durationMs ? formatDuration(durationMs) : 'Kalıcı / —', inline: true },
      { name: 'Sebep', value: clean(reason || 'Belirtilmedi'), inline: false },
    ],
  });

  return interaction.editReply({
    embeds: [okEmbed(
      `**${clean(player, 40)}** için işlem uygulandı${durationMs ? ` — süre **${formatDuration(durationMs)}**` : ''}.`
      + (reason ? `\nSebep: ${clean(reason, 300)}` : ''),
      labels.done,
    )],
  });
}

function playerCmd(name, description, { duration = false, reason = true } = {}) {
  const b = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft oyuncu adı').setRequired(true));
  if (duration) b.addStringOption((o) => o.setName('süre').setDescription('Örn: 10dk, 2sa, 7g (boş = kalıcı)'));
  if (reason) b.addStringOption((o) => o.setName('sebep').setDescription('İşlem sebebi'));
  return b;
}

export default [
  {
    tier: Tier.BMOD,
    data: playerCmd('mcban', 'Oyuncuyu Minecraft sunucusundan yasaklar', { duration: true }),
    execute: (i) => runModAction(i, 'ban', { allowDuration: true }),
  },
  {
    tier: Tier.BMOD,
    data: playerCmd('mcunban', 'Oyuncunun Minecraft yasağını kaldırır', { reason: false }),
    execute: (i) => runModAction(i, 'unban'),
  },
  {
    tier: Tier.MOD,
    data: playerCmd('mcmute', 'Oyuncuyu Minecraft sohbetinde susturur', { duration: true }),
    execute: (i) => runModAction(i, 'mute', { allowDuration: true }),
  },
  {
    tier: Tier.MOD,
    data: playerCmd('mcunmute', 'Oyuncunun Minecraft susturmasını kaldırır', { reason: false }),
    execute: (i) => runModAction(i, 'unmute'),
  },
  {
    tier: Tier.MOD,
    data: playerCmd('mckick', 'Oyuncuyu Minecraft sunucusundan atar'),
    execute: (i) => runModAction(i, 'kick'),
  },
  {
    tier: Tier.MOD,
    data: playerCmd('mcuyar', 'Oyuncuya Minecraft tarafında uyarı verir'),
    execute: (i) => runModAction(i, 'warn', { needReason: true }),
  },

  {
    tier: Tier.REHBER,
    data: new SlashCommandBuilder()
      .setName('mconline')
      .setDescription('Minecraft sunucusundaki çevrimiçi oyuncuları listeler'),
    async execute(interaction) {
      await interaction.deferReply();
      const res = await mcapi.status();
      if (!res.ok) return interaction.editReply({ embeds: [bridgeErrorEmbed(res, { context: 'çevrimiçi listesi' })] });

      const online = res.online ?? [];
      if (!online.length) {
        return interaction.editReply({
          embeds: [emptyEmbed('Sunucu Sessiz', 'Şu anda çevrimiçi oyuncu yok.')],
        });
      }
      return interaction.editReply({
        embeds: [baseEmbed(Colors.brand)
          .setTitle(`🟢 Çevrimiçi Oyuncular — ${online.length}`)
          .setDescription(nameList(online, { limit: 120, max: 3800 }))],
      });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('mcdurum')
      .setDescription('Minecraft sunucusunun ve aktif maçın durumunu gösterir'),
    async execute(interaction) {
      await interaction.deferReply();
      const res = await mcapi.status();
      if (!res.ok) return interaction.editReply({ embeds: [bridgeErrorEmbed(res, { context: 'sunucu durumu' })] });

      const match = res.match ?? {};
      const embed = baseEmbed(Colors.brand)
        .setTitle(`🌊 ${Brand.community} — Sunucu Durumu`)
        .addFields(
          { name: 'Sunucu', value: '🟢 Çevrimiçi', inline: true },
          { name: 'Oyuncular', value: String(res.count ?? (res.online?.length ?? 0)), inline: true },
          { name: 'Maç', value: match.active ? `⚔️ ${clean(match.state ?? 'devam ediyor', 30)}` : '💤 Aktif maç yok', inline: true },
        );
      if (match.active) {
        embed.addFields(
          { name: 'Hayatta', value: `**${match.aliveCount ?? '?'}** / ${match.participantCount ?? '?'}`, inline: true },
          { name: 'Geçen Süre', value: formatSeconds(match.elapsedSecs ?? 0), inline: true },
          { name: 'Senaryolar', value: match.scenarios?.length ? clean(match.scenarios.join(', '), 300) : '—', inline: true },
        );
      }
      // Performans satırı — eski plugin sürümünde endpoint yoksa sessiz atlanır.
      const perf = await mcapi.perf();
      if (perf.ok) {
        embed.addFields({
          name: 'Performans',
          value: `TPS ${perf.tps?.m1 ?? '?'} • ${perf.mspt ?? '?'} ms • `
            + `${perf.memory?.usedMb ?? '?'}/${perf.memory?.maxMb ?? '?'} MB`,
          inline: false,
        });
      }
      embed.addFields({ name: 'Sunucu adresi', value: `\`${Brand.domain}\``, inline: false });
      return interaction.editReply({ embeds: [embed] });
    },
  },

  {
    tier: Tier.REHBER,
    data: new SlashCommandBuilder()
      .setName('sunucuperf')
      .setDescription('Minecraft sunucusunun TPS, MSPT ve bellek durumunu gösterir'),
    async execute(interaction) {
      await interaction.deferReply();
      return interaction.editReply({ embeds: [perfEmbed(await mcapi.perf())] });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('mcsicil')
      .setDescription('Oyuncunun Minecraft ceza geçmişini gösterir')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft oyuncu adı').setRequired(true)),
    async execute(interaction) {
      const player = interaction.options.getString('oyuncu', true).trim();
      await interaction.deferReply();
      return interaction.editReply({ embeds: [modHistoryEmbed(player, await mcapi.modHistory(player))] });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('mcbanlist')
      .setDescription('Minecraft sunucusundaki aktif yasakları listeler')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    async execute(interaction) {
      await interaction.deferReply();
      return interaction.editReply({ embeds: [modListEmbed(await mcapi.modList('ban'))] });
    },
  },

  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('mcmutelist')
      .setDescription('Minecraft sunucusundaki aktif susturmaları listeler')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    async execute(interaction) {
      await interaction.deferReply();
      return interaction.editReply({ embeds: [modListEmbed(await mcapi.modList('mute'))] });
    },
  },
];
