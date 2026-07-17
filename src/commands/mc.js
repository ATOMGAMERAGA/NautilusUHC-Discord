import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { Tier } from '../permissions.js';
import { okEmbed, errEmbed, baseEmbed, Colors } from '../embeds.js';
import { mcapi } from '../mcapi.js';
import { addCase } from '../db.js';
import { parseDuration, formatDuration, formatSeconds, clean } from '../util.js';
import { perfEmbed, modHistoryEmbed, modListEmbed } from '../liveembeds.js';
import { sendLog } from '../modlog.js';

/**
 * Minecraft-side moderation & status. Every command talks to the NautilusUHC
 * plugin bridge over HTTP, so Discord staff can moderate the game server
 * without touching the console.
 */

async function runModAction(interaction, action, { needDuration = false, allowDuration = false, needReason = false } = {}) {
  const player = interaction.options.getString('oyuncu', true).trim();
  const rawDuration = allowDuration || needDuration ? interaction.options.getString('süre') : null;
  const reason = interaction.options.getString('sebep') ?? (needReason ? null : 'Discord üzerinden');

  let durationMs;
  if (rawDuration) {
    durationMs = parseDuration(rawDuration);
    if (!durationMs) {
      return interaction.reply({ embeds: [errEmbed('Süre anlaşılamadı. Örnek: `10dk`, `2sa`, `7g`.')], ephemeral: true });
    }
  }

  await interaction.deferReply();
  const res = await mcapi.mod(action, player, { reason, durationMs });
  if (!res.ok) {
    return interaction.editReply({ embeds: [errEmbed(`❌ ${res.error}`)] });
  }

  addCase(`mc_${action}`, null, interaction.user.id, reason, `${player}${durationMs ? ` / ${formatDuration(durationMs)}` : ''}`);
  await sendLog(interaction.client, {
    title: `⛏️ MC ${action.toUpperCase()}`,
    color: Colors.warn,
    fields: [
      { name: 'Oyuncu', value: `\`${clean(player, 40)}\``, inline: true },
      { name: 'Yetkili', value: `${interaction.user}`, inline: true },
      { name: 'Süre', value: durationMs ? formatDuration(durationMs) : 'kalıcı/—', inline: true },
      { name: 'Sebep', value: clean(reason || '—'), inline: false },
    ],
  });

  const durText = durationMs ? ` (**${formatDuration(durationMs)}**)` : '';
  return interaction.editReply({
    embeds: [okEmbed(`✅ **${clean(player, 40)}** için Minecraft'ta **${action}** uygulandı${durText}.`
      + (reason ? `\n**Sebep:** ${clean(reason)}` : ''))],
  });
}

function playerCmd(name, description, { duration = false, reason = true } = {}) {
  const b = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft oyuncu adı').setRequired(true));
  if (duration) b.addStringOption((o) => o.setName('süre').setDescription('Örn: 10dk, 2sa, 7g (boş = kalıcı)'));
  if (reason) b.addStringOption((o) => o.setName('sebep').setDescription('Sebep'));
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
      if (!res.ok) return interaction.editReply({ embeds: [errEmbed(`❌ ${res.error}`)] });
      const online = res.online ?? [];
      const embed = baseEmbed(Colors.main)
        .setTitle(`🟢 Çevrimiçi Oyuncular — ${online.length}`)
        .setDescription(online.length
          ? online.map((n) => `\`${n}\``).join(', ').slice(0, 3900)
          : 'Şu anda çevrimiçi oyuncu yok.');
      return interaction.editReply({ embeds: [embed] });
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
      if (!res.ok) {
        return interaction.editReply({
          embeds: [baseEmbed(Colors.danger).setTitle('🔴 Sunucu Durumu')
            .setDescription(`Sunucuya ulaşılamadı: ${res.error}`)],
        });
      }
      const match = res.match ?? {};
      const embed = baseEmbed(Colors.main)
        .setTitle('🌊 Nautilus PvP — Sunucu Durumu')
        .addFields(
          { name: 'Durum', value: '🟢 Çevrimiçi', inline: true },
          { name: 'Oyuncular', value: String(res.count ?? (res.online?.length ?? 0)), inline: true },
          { name: 'Maç', value: match.active ? `⚔️ ${match.state}` : '💤 Aktif maç yok', inline: true },
        );
      if (match.active) {
        embed.addFields(
          { name: 'Hayatta', value: `${match.aliveCount ?? '?'} / ${match.participantCount ?? '?'}`, inline: true },
          { name: 'Geçen Süre', value: formatSeconds(match.elapsedSecs ?? 0), inline: true },
          { name: 'Senaryolar', value: match.scenarios?.length ? match.scenarios.join(', ') : 'yok', inline: true },
        );
      }
      // Performans satırı — eski plugin sürümünde endpoint yoksa sessiz atlanır.
      const perf = await mcapi.perf();
      if (perf.ok) {
        embed.addFields({
          name: 'Performans',
          value: `TPS ${perf.tps?.m1 ?? '?'} • ${perf.mspt ?? '?'} ms • ${perf.memory?.usedMb ?? '?'}/${perf.memory?.maxMb ?? '?'} MB`,
          inline: false,
        });
      }
      return interaction.editReply({ embeds: [embed] });
    },
  },

  {
    tier: Tier.REHBER,
    data: new SlashCommandBuilder()
      .setName('sunucuperf')
      .setDescription('Minecraft sunucusunun performansını gösterir (TPS/MSPT/bellek)'),
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
      .setDescription('Minecraft sunucusundaki aktif banları listeler')
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
