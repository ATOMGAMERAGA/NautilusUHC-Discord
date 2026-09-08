import {
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { Tier, hasTier } from '../permissions.js';
import {
  baseEmbed, errEmbed, emptyEmbed, bridgeErrorEmbed, Colors, Assets, Brand,
} from '../embeds.js';
import { mcapi } from '../mcapi.js';
import {
  liveMatchEmbed, teamsEmbed, scenariosEmbed, queueEmbed, nameList,
} from '../liveembeds.js';
import {
  formatSeconds, trDateTime, discordTime, clean, codeText,
} from '../util.js';

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
  const section = (list) => (list.length ? list.map((i) => `• ${itemLine(i)}`).join('\n') : '*boş*');
  return [
    { name: 'Zırh & Ek El', value: section([...groups.armor, ...groups.offhand]), inline: false },
    { name: 'Hotbar (1-9)', value: section(groups.hotbar), inline: false },
    { name: 'Envanter', value: section(groups.main), inline: false },
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

/** Program satırı: saat + durum, tek biçimde. */
function slotLine(s) {
  const state = s.played
    ? '✅ oynandı'
    : s.reserved
      ? `📌 planlandı${s.host ? ` — host **${clean(s.host, 30)}**` : ''}`
      : '🟢 boş';
  return `**${clean(s.time ?? '?', 10)}** — ${state}`;
}

async function macBilgi(interaction) {
  const res = await mcapi.currentMatch();
  if (!res.ok) return interaction.editReply({ embeds: [bridgeErrorEmbed(res, { context: 'aktif maç' })] });

  if (!res.active) {
    const sched = await mcapi.schedule();
    const embed = emptyEmbed(
      'Aktif Maç Yok',
      'Şu anda devam eden bir UHC maçı bulunmuyor.',
      sched.ok && sched.slots?.length ? null : 'Maç saatlerini `/maç program` ile görebilirsin.',
    );
    if (sched.ok && sched.slots?.length) {
      embed.addFields({ name: 'Bugünkü program', value: sched.slots.map(slotLine).join('\n') });
    }
    return interaction.editReply({ embeds: [embed] });
  }

  const embed = baseEmbed(Colors.success)
    .setTitle('⚔️ Aktif Maç')
    .setThumbnail(Assets.item.diamondSword)
    .addFields(
      { name: 'Aşama', value: clean(res.state ?? '—', 40), inline: true },
      { name: 'Hayatta', value: `**${res.aliveCount ?? '?'}** / ${res.participantCount ?? '?'}`, inline: true },
      { name: 'Geçen Süre', value: formatSeconds(res.elapsedSecs ?? 0), inline: true },
      { name: 'Border', value: res.borderSize ? `±${res.borderSize}` : '—', inline: true },
      { name: 'Mod', value: res.teamSize > 1 ? `To${res.teamSize}` : 'FFA (Solo)', inline: true },
      { name: 'Senaryolar', value: res.scenarios?.length ? clean(res.scenarios.join(', '), 300) : '—', inline: true },
    );
  if (res.alive?.length) {
    embed.addFields({ name: `Hayatta Kalanlar (${res.alive.length})`, value: nameList(res.alive) });
  }
  return interaction.editReply({ embeds: [embed] });
}

async function macProgram(interaction) {
  const res = await mcapi.schedule();
  if (!res.ok) return interaction.editReply({ embeds: [bridgeErrorEmbed(res, { context: 'maç programı' })] });

  if (!res.slots?.length) {
    return interaction.editReply({
      embeds: [emptyEmbed('Program Henüz Belli Değil', 'Bugün için tanımlı bir maç saati yok.',
        'Yeni saatler açıldığında maç kanalında duyurulur.')],
    });
  }
  const open = res.slots.filter((s) => !s.played && !s.reserved).length;
  const embed = baseEmbed(Colors.info)
    .setTitle('📅 Bugünkü Maç Programı')
    .setDescription(res.slots.map(slotLine).join('\n'))
    .setFooter({
      text: `Saatler Türkiye saatidir • ${open} boş slot • ${Brand.community}`,
      iconURL: Assets.mark,
    });
  return interaction.editReply({ embeds: [embed] });
}

async function macGecmis(interaction) {
  const res = await mcapi.matches(10);
  if (!res.ok) return interaction.editReply({ embeds: [bridgeErrorEmbed(res, { context: 'maç geçmişi' })] });

  const matches = res.matches ?? [];
  if (!matches.length) {
    return interaction.editReply({
      embeds: [emptyEmbed('Henüz Maç Oynanmadı', 'Kayıtlı bir UHC maçı bulunmuyor.',
        'İlk maç oynandığında burada listelenecek.')],
    });
  }
  const embed = baseEmbed(Colors.brand)
    .setTitle('📜 Son Maçlar')
    .setThumbnail(Assets.item.goldenApple)
    .setDescription(matches.map((m) =>
      `**#${m.id}** • 🏆 ${clean(m.winner ?? '—', 30)} • ${m.participantCount} oyuncu • `
      + `${formatSeconds(m.durationSecs)} • ${discordTime(m.endedAt, 'R')}`).join('\n'))
    .setFooter({ text: `Ayrıntı için /maç detay <no> • ${Brand.community}`, iconURL: Assets.mark });
  return interaction.editReply({ embeds: [embed] });
}

async function macDetay(interaction) {
  const id = interaction.options.getInteger('maç-no', true);
  const res = await mcapi.matchDetail(id);
  if (!res.ok) return interaction.editReply({ embeds: [bridgeErrorEmbed(res, { context: 'maç detayı' })] });

  const m = res.match;
  if (!m) {
    return interaction.editReply({
      embeds: [errEmbed(`**#${id}** numaralı bir maç kaydı yok.\nOynanan maçları \`/maç geçmiş\` ile listeleyebilirsin.`,
        'Maç Bulunamadı')],
    });
  }

  const embed = baseEmbed(Colors.brand)
    .setTitle(`🏆 Maç #${id} — ${clean(m.winner ?? 'Kazanan yok', 60)}`)
    .setThumbnail(Assets.item.goldenApple)
    .addFields(
      { name: 'Süre', value: formatSeconds(m.durationSecs ?? 0), inline: true },
      { name: 'Katılımcı', value: String(m.participantCount ?? '?'), inline: true },
      { name: 'Senaryolar', value: clean(m.scenarios || '—', 300), inline: true },
    );

  const parts = res.participants ?? [];
  if (parts.length) {
    const sorted = [...parts].sort((a, b) => (a.placement ?? 99) - (b.placement ?? 99));
    embed.addFields({
      name: 'Sıralama',
      value: sorted.slice(0, 15).map((p) => {
        const medal = ['🥇', '🥈', '🥉'][(p.placement ?? 0) - 1] ?? `**${p.placement}.**`;
        const elo = p.eloDelta != null ? ` • ELO ${p.eloDelta >= 0 ? '+' : ''}${p.eloDelta}` : '';
        return `${medal} ${clean(p.name, 20)}${p.team ? ` [${clean(p.team, 12)}]` : ''} — ${p.kills} kill${elo}`;
      }).join('\n'),
    });
  }
  embed.addFields({ name: 'Bitiş', value: `${discordTime(m.endedAt, 'f')} • Seed \`${codeText(m.seed ?? '?', 24)}\``, inline: false });
  return interaction.editReply({ embeds: [embed] });
}

async function macEnvanter(interaction) {
  if (!hasTier(interaction.member, Tier.REHBER)) {
    return interaction.editReply({
      embeds: [errEmbed('Envanter kayıtlarını yalnızca yetkililer görüntüleyebilir.', 'Yetki Gerekli')],
    });
  }
  const id = interaction.options.getInteger('maç-no', true);
  const player = interaction.options.getString('oyuncu', true).trim();
  const res = await mcapi.matchInventory(id, player);
  if (!res.ok) return interaction.editReply({ embeds: [bridgeErrorEmbed(res, { context: 'envanter kaydı' })] });

  if (!res.found) {
    return interaction.editReply({
      embeds: [errEmbed(`**#${id}** numaralı maçta **${clean(player, 30)}** için envanter kaydı yok.\n`
        + 'Oyuncu adını ve maç numarasını kontrol et.', 'Kayıt Bulunamadı')],
    });
  }
  const capture = res.reason === 'death' ? 'ölüm anında' : 'maç sonunda (hayatta)';
  const embed = baseEmbed(Colors.info)
    .setTitle(`🎒 Envanter — ${clean(res.name, 30)}`)
    .setThumbnail(Assets.item.diamondChestplate)
    .setDescription(`Maç **#${id}** • ${capture} • ${trDateTime(res.capturedAt)}`)
    .addFields(
      { name: 'Can', value: `${(res.health ?? 0).toFixed(1)} / 20`, inline: true },
      { name: 'Açlık', value: `${res.food ?? 0} / 20`, inline: true },
      { name: 'Seviye', value: `${res.level ?? 0} (${res.totalExperience ?? 0} XP)`, inline: true },
      ...renderInventory(res.items),
    );
  const ender = res.enderChest ?? [];
  if (ender.length) {
    embed.addFields({ name: 'Ender Sandığı', value: ender.map((i) => `• ${itemLine(i)}`).join('\n') });
  }
  return interaction.editReply({ embeds: [embed] });
}

export default [
  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('maç')
      .setDescription('Maç durumu, program ve geçmiş kayıtları')
      .addSubcommand((s) => s.setName('bilgi').setDescription('Aktif maçın durumunu gösterir'))
      .addSubcommand((s) => s.setName('canlı').setDescription('Canlı maç panosunu açar (yenilenebilir)'))
      .addSubcommand((s) => s.setName('program').setDescription('Bugünkü maç saatlerini gösterir'))
      .addSubcommand((s) => s.setName('geçmiş').setDescription('Son oynanan maçları listeler'))
      .addSubcommand((s) => s.setName('detay').setDescription('Bir maçın sonucunu ve sıralamasını gösterir')
        .addIntegerOption((o) => o.setName('maç-no').setDescription('Maç numarası').setRequired(true)))
      .addSubcommand((s) => s.setName('envanter').setDescription('Maç kaydından oyuncu envanterini gösterir (yetkili)')
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
        default: return interaction.editReply({ embeds: [errEmbed('Bu alt komut tanınmıyor.', 'Bilinmeyen Komut')] });
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
      .setDescription('Maç katılım kuyruğunu gösterir'),
    async execute(interaction) {
      await interaction.deferReply();
      return interaction.editReply({ embeds: [queueEmbed(await mcapi.queue())] });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('senaryolar')
      .setDescription('UHC senaryolarını ve aktif olanları gösterir'),
    async execute(interaction) {
      await interaction.deferReply();
      return interaction.editReply({ embeds: [scenariosEmbed(await mcapi.scenarios())] });
    },
  },
];
