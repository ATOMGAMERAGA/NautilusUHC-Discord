import {
  SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { Tier } from '../permissions.js';
import { okEmbed, errEmbed, baseEmbed, neutralEmbed, brandFooter, Colors } from '../embeds.js';
import { giveaways, polls, scheduleTask, addCase } from '../db.js';
import { endGiveaway, endPoll, pollResultEmbed } from '../scheduler.js';
import { parseDuration, formatDuration, discordTime, clean } from '../util.js';

const MAX_POLL_OPTIONS = 4;

export default [
  {
    tier: Tier.MOD,
    data: new SlashCommandBuilder()
      .setName('çekiliş')
      .setDescription('Çekiliş başlatır ve yönetir')
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
          return interaction.reply({
            embeds: [errEmbed('Süreyi anlayamadım. Örnek: `30dk`, `2sa`, `1g`.', 'Geçersiz Süre')],
            flags: MessageFlags.Ephemeral,
          });
        }
        const prize = interaction.options.getString('ödül', true);
        const winnerCount = interaction.options.getInteger('kazanan') ?? 1;
        const endsAt = Date.now() + durationMs;

        const id = giveaways.create(interaction.channel.id, prize, winnerCount, endsAt, interaction.user.id);
        const embed = baseEmbed(Colors.brand)
          .setTitle(`🎉 Çekiliş — ${clean(prize, 100)}`)
          .setDescription(`Katılmak için aşağıdaki butona tıkla. Kazananlar ${discordTime(endsAt, 'R')} açıklanacak.`)
          .addFields(
            { name: 'Ödül', value: clean(prize, 200), inline: true },
            { name: 'Kazanan sayısı', value: String(winnerCount), inline: true },
            { name: 'Bitiş', value: discordTime(endsAt, 'f'), inline: true },
            { name: 'Düzenleyen', value: `${interaction.user}`, inline: true },
          )
          .setFooter(brandFooter(`Çekiliş #${id}`))
          .setTimestamp();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`gw:join:${id}`).setEmoji('🎉')
            .setLabel('Katıl').setStyle(ButtonStyle.Primary),
        );
        const msg = await interaction.channel.send({
          embeds: [embed], components: [row], allowedMentions: { parse: [] },
        });
        giveaways.setMessage(id, msg.id);
        scheduleTask('giveaway_end', endsAt, { giveawayId: id });
        addCase('giveaway', null, interaction.user.id, prize, `#${id} / ${formatDuration(durationMs)}`);
        return interaction.reply({
          embeds: [okEmbed(`**#${id}** numaralı çekiliş bu kanalda yayında. Kazananlar ${discordTime(endsAt, 'R')} otomatik çekilecek.`,
            '🎉 Çekiliş Başladı')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const id = interaction.options.getInteger('çekiliş-no', true);
      const gw = giveaways.get(id);
      if (!gw) {
        return interaction.reply({
          embeds: [errEmbed(`**#${id}** numaralı bir çekiliş yok.`, 'Çekiliş Bulunamadı')],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === 'bitir') {
        if (gw.ended) {
          return interaction.reply({
            embeds: [neutralEmbed('Bu çekiliş zaten sonuçlandı.', 'Çekiliş Kapalı')], flags: MessageFlags.Ephemeral,
          });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await endGiveaway(interaction.client, id);
        return interaction.editReply({
          embeds: [okEmbed(`**#${id}** çekilişi erken bitirildi ve kazananlar duyuruldu.`, '🎉 Çekiliş Sonuçlandı')],
        });
      }

      // yenidençek
      if (!gw.ended) {
        return interaction.reply({
          embeds: [errEmbed('Bu çekiliş hâlâ devam ediyor. Önce `/çekiliş bitir` kullan.', 'Çekiliş Sürüyor')],
          flags: MessageFlags.Ephemeral,
        });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const winners = await endGiveaway(interaction.client, id, { reroll: true });
      return interaction.editReply({
        embeds: [winners?.length
          ? okEmbed(`Yeni kazanan: ${winners.map((w) => `<@${w}>`).join(', ')}`, '🎲 Yeniden Çekildi')
          : neutralEmbed('Çekilişe kimse katılmadığı için kazanan belirlenemedi.', 'Katılımcı Yok')],
      });
    },
  },

  {
    tier: Tier.REHBER,
    data: new SlashCommandBuilder()
      .setName('anket')
      .setDescription('Anket başlatır ve yönetir')
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
          return interaction.reply({
            embeds: [errEmbed('Anket için en az 2 seçenek gerekiyor. Seçenekleri `;` ile ayır.\n'
              + 'Örnek: `Evet;Hayır;Kararsızım`', 'Seçenekler Eksik')],
            flags: MessageFlags.Ephemeral,
          });
        }
        const rawDuration = interaction.options.getString('süre');
        let endsAt = null;
        if (rawDuration) {
          const ms = parseDuration(rawDuration);
          if (!ms) {
            return interaction.reply({
              embeds: [errEmbed('Süreyi anlayamadım. Örnek: `1sa`, `1g`.', 'Geçersiz Süre')],
              flags: MessageFlags.Ephemeral,
            });
          }
          endsAt = Date.now() + ms;
        }

        const id = polls.create(interaction.channel.id, question, options, endsAt);
        const embed = baseEmbed(Colors.info)
          .setTitle(`📊 ${clean(question, 200)}`)
          .setDescription(options.map((o, i) => `**${i + 1}.** ${clean(o, 80)}`).join('\n')
            + (endsAt ? `\n\nOylama ${discordTime(endsAt, 'R')} kapanıyor.` : ''))
          .setFooter(brandFooter(`Anket #${id}`, 'Oy vermek için numaralara tıkla'));
        const row = new ActionRowBuilder().addComponents(
          options.map((o, i) => new ButtonBuilder()
            .setCustomId(`poll:vote:${id}:${i}`)
            .setLabel(`${i + 1}`)
            .setStyle(ButtonStyle.Secondary)),
        );
        const msg = await interaction.channel.send({
          embeds: [embed], components: [row], allowedMentions: { parse: [] },
        });
        polls.setMessage(id, msg.id);
        if (endsAt) scheduleTask('poll_end', endsAt, { pollId: id });
        return interaction.reply({
          embeds: [okEmbed(`**#${id}** numaralı anket bu kanalda yayında.`
            + (endsAt ? ` Sonuçlar ${discordTime(endsAt, 'R')} otomatik açıklanacak.` : ' Bitirmek için `/anket bitir` kullan.'),
          '📊 Anket Başladı')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const id = interaction.options.getInteger('anket-no', true);
      const poll = polls.get(id);
      if (!poll) {
        return interaction.reply({
          embeds: [errEmbed(`**#${id}** numaralı bir anket yok.`, 'Anket Bulunamadı')], flags: MessageFlags.Ephemeral,
        });
      }
      if (poll.ended) {
        return interaction.reply({
          embeds: [neutralEmbed('Bu anket zaten sonuçlandı.', 'Anket Kapalı')], flags: MessageFlags.Ephemeral,
        });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await endPoll(interaction.client, id);
      return interaction.editReply({
        embeds: [okEmbed(`**#${id}** anketi kapatıldı, sonuçlar anket mesajında yayınlandı.`, '📊 Anket Bitti')],
      });
    },
  },

  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('hatırlat')
      .setDescription('Belirttiğin süre sonra bu kanalda seni etiketleyerek hatırlatır')
      .addStringOption((o) => o.setName('süre').setDescription('Örn: 10dk, 2sa, 1g').setRequired(true))
      .addStringOption((o) => o.setName('mesaj').setDescription('Hatırlatılacak not').setRequired(true)),
    async execute(interaction) {
      const ms = parseDuration(interaction.options.getString('süre', true));
      if (!ms) {
        return interaction.reply({
          embeds: [errEmbed('Süreyi anlayamadım. Örnek: `10dk`, `2sa`, `1g`.', 'Geçersiz Süre')],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (ms > 30 * 86_400_000) {
        return interaction.reply({
          embeds: [errEmbed('Hatırlatıcı en fazla 30 gün sonrasına kurulabilir.', 'Süre Çok Uzun')],
          flags: MessageFlags.Ephemeral,
        });
      }
      const message = interaction.options.getString('mesaj', true);
      const dueAt = Date.now() + ms;
      scheduleTask('reminder', dueAt, {
        userId: interaction.user.id,
        channelId: interaction.channel.id,
        message,
      });
      return interaction.reply({
        embeds: [okEmbed(`${discordTime(dueAt, 'R')} bu kanalda seni etiketleyeceğim.\n> ${clean(message, 200)}`,
          '⏰ Hatırlatıcı Kuruldu')],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];
