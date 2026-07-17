import {
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { Tier, hasTier } from '../permissions.js';
import { errEmbed, baseEmbed, Colors, Assets } from '../embeds.js';
import { mcapi } from '../mcapi.js';
import { liveMatchEmbed, teamsEmbed, scenariosEmbed, queueEmbed } from '../liveembeds.js';
import { formatSeconds, trDateTime, discordTime, clean } from '../util.js';

/** "IRON_SWORD" -> "Iron Sword" */
function pretty(materialName) {
  return String(materialName ?? '?')
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function itemLine(item) {
  let line = `${item.amount > 1 ? `${item.amount}× ` : ''}${pretty(item.type)}`;
  if (item.name) line += ` "${clean(item.name, 40)}"`;
  if (item.enchants?.length) line += ` (${item.enchants.join(', ')})`;
  if (item.durability) line += ` [${item.durability}]`;
  return line;
}

/** Renders a slot-indexed item list into grouped, readable sections. */
function renderInventory(items) {
  const groups = { armor: [], offhand: [], hotbar: [], main: [] };
  for (const item of items ?? []) {
    if (item.slot >= 36 && item.slot <= 39) groups.armor.push(item);
    else if (item.slot === 40) groups.offhand.push(item);
    else if (item.slot >= 0 && item.slot <= 8) groups.hotbar.push(item);
    else groups.main.push(item);
  }
  const section = (list) =>
    (list.length ? list.map((i) => `• ${itemLine(i)}`).join('\n').slice(0, 1020) : '*boş*');
  return [
    { name: '🛡️ Zırh & Ek El', value: section([...groups.armor, ...groups.offhand]), inline: false },
    { name: '🗡️ Hotbar (1-9)', value: section(groups.hotbar), inline: false },
    { name: '🎒 Envanter', value: section(groups.main), inline: false },
  ];
}

/** `/maç canlı` yenile butonu — components.js 'mac:yenile' handler'ı da kullanır. */
export function liveComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mac:yenile').setLabel('Yenile').setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
  )];
}

/** Canlı maç embed'ini taze veriyle kurar (komut + yenile butonu ortak yolu). */
export async function buildLivePayload() {
  const status = await mcapi.status();
  const current = status.ok && status.match?.active ? await mcapi.currentMatch() : null;
  return { embeds: [liveMatchEmbed(status, current)], components: liveComponents() };
}

async function macCanli(interaction) {
  return interaction.editReply(await buildLivePayload());
}

async function macBilgi(interaction) {
  const res = await mcapi.currentMatch();
  if (!res.ok) return interaction.editReply({ embeds: [errEmbed(`❌ ${res.error}`)] });
  if (!res.active) {
    const sched = await mcapi.schedule();
    const embed = baseEmbed(Colors.dark).setTitle('💤 Aktif maç yok');
    if (sched.ok && sched.slots?.length) {
      embed.setDescription('Bugünkü maç saatleri:\n' + sched.slots.map((s) =>
        `• **${s.time}** — ${s.reserved ? `📌 planlandı${s.host ? ` (host: ${s.host})` : ''}` : 'boş'}`).join('\n'));
    }
    return interaction.editReply({ embeds: [embed] });
  }
  const embed = baseEmbed(Colors.main)
    .setTitle('⚔️ Aktif Maç')
    .setThumbnail(Assets.item.diamondSword)
    .addFields(
      { name: 'Aşama', value: String(res.state ?? '?'), inline: true },
      { name: 'Geçen Süre', value: formatSeconds(res.elapsedSecs ?? 0), inline: true },
      { name: 'Hayatta', value: `${res.aliveCount ?? '?'} / ${res.participantCount ?? '?'}`, inline: true },
      { name: 'Border', value: res.borderSize ? `±${res.borderSize}` : '?', inline: true },
      { name: 'Senaryolar', value: res.scenarios?.length ? res.scenarios.join(', ') : 'yok', inline: true },
      { name: 'Takım Boyutu', value: String(res.teamSize ?? 'FFA'), inline: true },
    );
  if (res.alive?.length) {
    embed.addFields({ name: `🟢 Hayatta Kalanlar (${res.alive.length})`,
      value: res.alive.map((n) => `\`${n}\``).join(', ').slice(0, 1020) });
  }
  return interaction.editReply({ embeds: [embed] });
}

async function macProgram(interaction) {
  const res = await mcapi.schedule();
  if (!res.ok) return interaction.editReply({ embeds: [errEmbed(`❌ ${res.error}`)] });
  const embed = baseEmbed(Colors.info).setTitle('📅 Bugünkü Maç Programı (TR saati)');
  if (!res.slots?.length) {
    embed.setDescription('Tanımlı maç saati yok.');
  } else {
    embed.setDescription(res.slots.map((s) => {
      const status = s.played ? '✅ oynandı'
        : s.reserved ? `📌 planlandı${s.host ? ` — host: **${clean(s.host, 30)}**` : ''}`
          : '🟢 boş';
      return `**${s.time}** — ${status}`;
    }).join('\n') + '\n\nGünde en fazla **3 maç** oynanır; saatler host tarafından seçilir.');
  }
  return interaction.editReply({ embeds: [embed] });
}

async function macGecmis(interaction) {
  const res = await mcapi.matches(10);
  if (!res.ok) return interaction.editReply({ embeds: [errEmbed(`❌ ${res.error}`)] });
  const matches = res.matches ?? [];
  if (!matches.length) {
    return interaction.editReply({ embeds: [baseEmbed(Colors.dark).setDescription('Henüz kayıtlı maç yok.')] });
  }
  const embed = baseEmbed(Colors.main)
    .setTitle('📜 Son Maçlar')
    .setDescription(matches.map((m) =>
      `**#${m.id}** • 🏆 ${clean(m.winner ?? '—', 30)} • ${m.participantCount} oyuncu • `
      + `${formatSeconds(m.durationSecs)} • ${discordTime(m.endedAt, 'f')}`).join('\n'))
    .addFields({ name: 'Detay', value: 'Ayrıntı için `/maç detay <no>`, envanter için `/maç envanter <no> <oyuncu>`.' });
  return interaction.editReply({ embeds: [embed] });
}

async function macDetay(interaction) {
  const id = interaction.options.getInteger('maç-no', true);
  const res = await mcapi.matchDetail(id);
  if (!res.ok) return interaction.editReply({ embeds: [errEmbed(`❌ ${res.error}`)] });
  const m = res.match;
  if (!m) return interaction.editReply({ embeds: [errEmbed(`#${id} numaralı maç bulunamadı.`)] });
  const embed = baseEmbed(Colors.main)
    .setTitle(`📊 Maç #${id}`)
    .setThumbnail(Assets.item.goldenApple)
    .addFields(
      { name: '🏆 Kazanan', value: clean(m.winner ?? '—', 60), inline: true },
      { name: '⏱️ Süre', value: formatSeconds(m.durationSecs ?? 0), inline: true },
      { name: '👥 Katılımcı', value: String(m.participantCount ?? '?'), inline: true },
      { name: '📅 Bitiş', value: `${discordTime(m.endedAt, 'f')}\n(${trDateTime(m.endedAt)} TR)`, inline: true },
      { name: '🎲 Senaryolar', value: m.scenarios || 'yok', inline: true },
      { name: '🌱 Seed', value: `\`${m.seed ?? '?'}\``, inline: true },
    );
  const parts = res.participants ?? [];
  if (parts.length) {
    const sorted = [...parts].sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99));
    embed.addFields({
      name: '🥇 Sıralama',
      value: sorted.slice(0, 15).map((p) =>
        `**${p.placement}.** ${clean(p.name, 20)}${p.team ? ` [${clean(p.team, 12)}]` : ''} — `
        + `${p.kills} kill${p.eloDelta != null ? `, ELO ${p.eloDelta >= 0 ? '+' : ''}${p.eloDelta}` : ''}`).join('\n').slice(0, 1020),
    });
  }
  return interaction.editReply({ embeds: [embed] });
}

async function macEnvanter(interaction) {
  if (!hasTier(interaction.member, Tier.REHBER)) {
    return interaction.editReply({ embeds: [errEmbed('Envanter snapshot\'larını yalnızca yetkililer görüntüleyebilir.')] });
  }
  const id = interaction.options.getInteger('maç-no', true);
  const player = interaction.options.getString('oyuncu', true).trim();
  const res = await mcapi.matchInventory(id, player);
  if (!res.ok) return interaction.editReply({ embeds: [errEmbed(`❌ ${res.error}`)] });
  if (!res.found) {
    return interaction.editReply({ embeds: [errEmbed(`Maç #${id} içinde **${clean(player, 30)}** için snapshot bulunamadı.`)] });
  }
  const reasonText = res.reason === 'death' ? '💀 ölüm anında' : '🏁 maç sonunda (hayatta)';
  const embed = baseEmbed(Colors.info)
    .setTitle(`🎒 Envanter Snapshot — ${clean(res.name, 30)} (Maç #${id})`)
    .setThumbnail(Assets.item.diamondChestplate)
    .setDescription(`Kayıt: ${reasonText} • ${trDateTime(res.capturedAt)} TR`)
    .addFields(
      { name: '❤️ Can', value: `${(res.health ?? 0).toFixed(1)} / 20`, inline: true },
      { name: '🍗 Açlık', value: `${res.food ?? 0} / 20`, inline: true },
      { name: '✨ Seviye', value: `${res.level ?? 0} (${res.totalExperience ?? 0} XP)`, inline: true },
      ...renderInventory(res.items),
    );
  const ender = res.enderChest ?? [];
  if (ender.length) {
    embed.addFields({
      name: '🟣 Ender Sandığı',
      value: ender.map((i) => `• ${itemLine(i)}`).join('\n').slice(0, 1020),
    });
  }
  return interaction.editReply({ embeds: [embed] });
}

export default [
  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('maç')
      .setDescription('Nautilus PvP maç bilgileri')
      .addSubcommand((s) => s.setName('bilgi').setDescription('Aktif maçın durumunu gösterir'))
      .addSubcommand((s) => s.setName('canlı').setDescription('Canlı maç panosu (yenile butonlu)'))
      .addSubcommand((s) => s.setName('program').setDescription('Bugünkü maç saatlerini gösterir'))
      .addSubcommand((s) => s.setName('geçmiş').setDescription('Son oynanan maçları listeler'))
      .addSubcommand((s) => s.setName('detay').setDescription('Bir maçın tüm detaylarını gösterir')
        .addIntegerOption((o) => o.setName('maç-no').setDescription('Maç numarası').setRequired(true)))
      .addSubcommand((s) => s.setName('envanter').setDescription('Maç snapshot\'ından oyuncu envanterini gösterir (yetkili)')
        .addIntegerOption((o) => o.setName('maç-no').setDescription('Maç numarası').setRequired(true))
        .addStringOption((o) => o.setName('oyuncu').setDescription('Minecraft oyuncu adı').setRequired(true))),
    async execute(interaction) {
      await interaction.deferReply();
      switch (interaction.options.getSubcommand()) {
        case 'bilgi': return macBilgi(interaction);
        case 'canlı': return macCanli(interaction);
        case 'program': return macProgram(interaction);
        case 'geçmiş': return macGecmis(interaction);
        case 'detay': return macDetay(interaction);
        case 'envanter': return macEnvanter(interaction);
        default: return interaction.editReply({ embeds: [errEmbed('Bilinmeyen alt komut.')] });
      }
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('takımlar')
      .setDescription('Aktif maçın takım kadrolarını gösterir'),
    async execute(interaction) {
      await interaction.deferReply();
      return interaction.editReply({ embeds: [teamsEmbed(await mcapi.teams())] });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('sıra')
      .setDescription('Maç katılım kuyruğunu gösterir (/maç katıl kayıtları)'),
    async execute(interaction) {
      await interaction.deferReply();
      return interaction.editReply({ embeds: [queueEmbed(await mcapi.queue())] });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('senaryolar')
      .setDescription('Tüm UHC senaryolarını ve aktif olanları listeler'),
    async execute(interaction) {
      await interaction.deferReply();
      return interaction.editReply({ embeds: [scenariosEmbed(await mcapi.scenarios())] });
    },
  },
];
