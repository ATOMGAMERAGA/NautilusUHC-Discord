import {
  SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { Tier } from '../permissions.js';
import { okEmbed, errEmbed, baseEmbed, Colors } from '../embeds.js';
import { giveaways, polls, scheduleTask, addCase } from '../db.js';
import { endGiveaway, endPoll, pollResultEmbed } from '../scheduler.js';
import { parseDuration, formatDuration, discordTime, clean } from '../util.js';

const MAX_POLL_OPTIONS = 4;

export default [
  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('çekiliş')
      .setDescription('Çekiliş yönetimi')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addSubcommand((s) => s.setName('başlat').setDescription('Yeni bir çekiliş başlatır')
        .addStringOption((o) => o.setName('süre').setDescription('Örn: 30dk, 2sa, 1g').setRequired(true))
        .addStringOption((o) => o.setName('ödül').setDescription('Çekiliş ödülü').setRequired(true))
        .addIntegerOption((o) => o.setName('kazanan').setDescription('Kazanan sayısı (varsayılan 1)')
          .setMinValue(1).setMaxValue(10)))
      .addSubcommand((s) => s.setName('bitir').setDescription('Bir çekilişi hemen bitirir')
        .addIntegerOption((o) => o.setName('çekiliş-no').setDescription('Çekiliş numarası').setRequired(true)))
      .addSubcommand((s) => s.setName('yenidençek').setDescription('Bitmiş çekilişte yeniden kazanan çeker')
        .addIntegerOption((o) => o.setName('çekiliş-no').setDescription('Çekiliş numarası').setRequired(true))),
    async execute(interaction) {
      const sub = interaction.options.getSubcommand();

      if (sub === 'başlat') {
        const durationMs = parseDuration(interaction.options.getString('süre', true));
        if (!durationMs) {
          return interaction.reply({ embeds: [errEmbed('Süre anlaşılamadı. Örnek: `30dk`, `2sa`, `1g`.')], ephemeral: true });
        }
        const prize = interaction.options.getString('ödül', true);
        const winnerCount = interaction.options.getInteger('kazanan') ?? 1;
        const endsAt = Date.now() + durationMs;

        const id = giveaways.create(interaction.channel.id, prize, winnerCount, endsAt, interaction.user.id);
        const embed = baseEmbed(Colors.main)
          .setTitle(`🎉 ÇEKİLİŞ — ${clean(prize, 100)}`)
          .setDescription(`Katılmak için 🎉 butonuna tıkla!\n\n`
            + `**Bitiş:** ${discordTime(endsAt, 'R')} (${discordTime(endsAt, 'f')})\n`
            + `**Kazanan sayısı:** ${winnerCount}\n**Başlatan:** ${interaction.user}`)
          .setFooter({ text: `Çekiliş #${id} • Nautilus PvP` });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`gw:join:${id}`).setEmoji('🎉')
            .setLabel('Katıl').setStyle(ButtonStyle.Primary),
        );
        const msg = await interaction.channel.send({ embeds: [embed], components: [row] });
        giveaways.setMessage(id, msg.id);
        scheduleTask('giveaway_end', endsAt, { giveawayId: id });
        addCase('giveaway', null, interaction.user.id, prize, `#${id} / ${formatDuration(durationMs)}`);
        return interaction.reply({ embeds: [okEmbed(`🎉 **#${id}** numaralı çekiliş başlatıldı!`)], ephemeral: true });
      }

      const id = interaction.options.getInteger('çekiliş-no', true);
      const gw = giveaways.get(id);
      if (!gw) return interaction.reply({ embeds: [errEmbed(`#${id} numaralı çekiliş bulunamadı.`)], ephemeral: true });

      if (sub === 'bitir') {
        if (gw.ended) return interaction.reply({ embeds: [errEmbed('Bu çekiliş zaten bitmiş.')], ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        await endGiveaway(interaction.client, id);
        return interaction.editReply({ embeds: [okEmbed(`🎉 #${id} çekilişi bitirildi.`)] });
      }

      // yenidençek
      if (!gw.ended) return interaction.reply({ embeds: [errEmbed('Çekiliş henüz bitmedi.')], ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const winners = await endGiveaway(interaction.client, id, { reroll: true });
      return interaction.editReply({
        embeds: [okEmbed(winners?.length ? `🎲 Yeniden çekildi: ${winners.map((w) => `<@${w}>`).join(', ')}`
          : 'Katılımcı olmadığı için kazanan çekilemedi.')],
      });
    },
  },

  {
    tier: Tier.REHBER,
    data: new SlashCommandBuilder()
      .setName('anket')
      .setDescription('Anket yönetimi')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addSubcommand((s) => s.setName('başlat').setDescription('Butonlu anket başlatır')
        .addStringOption((o) => o.setName('soru').setDescription('Anket sorusu').setRequired(true))
        .addStringOption((o) => o.setName('seçenekler')
          .setDescription('Seçenekleri ; ile ayır (2-4 adet). Örn: Evet;Hayır;Kararsızım').setRequired(true))
        .addStringOption((o) => o.setName('süre').setDescription('Otomatik bitiş (örn: 1sa, 1g) — boş = manuel')))
      .addSubcommand((s) => s.setName('bitir').setDescription('Bir anketi bitirir ve sonuçları gösterir')
        .addIntegerOption((o) => o.setName('anket-no').setDescription('Anket numarası').setRequired(true))),
    async execute(interaction) {
      const sub = interaction.options.getSubcommand();

      if (sub === 'başlat') {
        const question = interaction.options.getString('soru', true);
        const options = interaction.options.getString('seçenekler', true)
          .split(';').map((s) => s.trim()).filter(Boolean).slice(0, MAX_POLL_OPTIONS);
        if (options.length < 2) {
          return interaction.reply({ embeds: [errEmbed('En az 2 seçenek gerekli (`;` ile ayır).')], ephemeral: true });
        }
        const rawDuration = interaction.options.getString('süre');
        let endsAt = null;
        if (rawDuration) {
          const ms = parseDuration(rawDuration);
          if (!ms) return interaction.reply({ embeds: [errEmbed('Süre anlaşılamadı. Örnek: `1sa`, `1g`.')], ephemeral: true });
          endsAt = Date.now() + ms;
        }

        const id = polls.create(interaction.channel.id, question, options, endsAt);
        const embed = baseEmbed(Colors.info)
          .setTitle(`📊 ${clean(question, 200)}`)
          .setDescription(options.map((o, i) => `**${i + 1}.** ${clean(o, 80)}`).join('\n')
            + (endsAt ? `\n\nBitiş: ${discordTime(endsAt, 'R')}` : ''))
          .setFooter({ text: `Anket #${id} • Oy vermek için butonları kullan` });
        const row = new ActionRowBuilder().addComponents(
          options.map((o, i) => new ButtonBuilder()
            .setCustomId(`poll:vote:${id}:${i}`)
            .setLabel(`${i + 1}`)
            .setStyle(ButtonStyle.Secondary)),
        );
        const msg = await interaction.channel.send({ embeds: [embed], components: [row] });
        polls.setMessage(id, msg.id);
        if (endsAt) scheduleTask('poll_end', endsAt, { pollId: id });
        return interaction.reply({ embeds: [okEmbed(`📊 **#${id}** numaralı anket başlatıldı.`)], ephemeral: true });
      }

      const id = interaction.options.getInteger('anket-no', true);
      const poll = polls.get(id);
      if (!poll) return interaction.reply({ embeds: [errEmbed(`#${id} numaralı anket bulunamadı.`)], ephemeral: true });
      if (poll.ended) return interaction.reply({ embeds: [errEmbed('Bu anket zaten bitmiş.')], ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      await endPoll(interaction.client, id);
      return interaction.editReply({ embeds: [okEmbed(`📊 #${id} anketi bitirildi, sonuçlar yayınlandı.`)] });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('hatırlat')
      .setDescription('Belirtilen süre sonra seni bu kanalda etiketleyerek hatırlatır')
      .addStringOption((o) => o.setName('süre').setDescription('Örn: 10dk, 2sa, 1g').setRequired(true))
      .addStringOption((o) => o.setName('mesaj').setDescription('Hatırlatılacak şey').setRequired(true)),
    async execute(interaction) {
      const ms = parseDuration(interaction.options.getString('süre', true));
      if (!ms) return interaction.reply({ embeds: [errEmbed('Süre anlaşılamadı. Örnek: `10dk`, `2sa`, `1g`.')], ephemeral: true });
      if (ms > 30 * 86_400_000) {
        return interaction.reply({ embeds: [errEmbed('En fazla 30 gün sonrası için hatırlatıcı kurabilirsin.')], ephemeral: true });
      }
      const message = interaction.options.getString('mesaj', true);
      const dueAt = Date.now() + ms;
      scheduleTask('reminder', dueAt, {
        userId: interaction.user.id,
        channelId: interaction.channel.id,
        message,
      });
      return interaction.reply({
        embeds: [okEmbed(`⏰ Tamamdır! ${discordTime(dueAt, 'R')} (${discordTime(dueAt, 'f')}) hatırlatacağım:\n> ${clean(message, 200)}`)],
        ephemeral: true,
      });
    },
  },
];
