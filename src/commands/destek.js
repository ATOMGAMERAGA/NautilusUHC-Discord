import { SlashCommandBuilder } from 'discord.js';
import { Tier, tierOf } from '../permissions.js';
import {
  openTicket, closeTicket, reopenTicket, addUserToTicket, removeUserFromTicket, statusLine,
} from '../tickets.js';
import { ticketsV2, ticketNotes, ticketBlacklist, addCase } from '../db.js';
import {
  baseEmbed, okEmbed, errEmbed, emptyEmbed, brandFooter, Colors,
} from '../embeds.js';
import { sendLog } from '../modlog.js';
import { clean, trDateTime } from '../util.js';
import {
  ticketTypeLabel, STATUS_LABELS, PRIORITY_LABELS, PRIORITIES, applyTransition, slaState,
} from '../ticketcore.js';

/**
 * /destek — üye tarafı (aç/kapat) + Rehber+ yönetim alt komutları.
 * Komut tabanı MEMBER; yetkili alt komutları çalışma anında tier kontrol eder.
 */

const STATUS_CHOICES = [
  { name: 'açık', value: 'open' },
  { name: 'beklemede', value: 'pending' },
  { name: 'kapalı', value: 'closed' },
];

/** Liste satırı: numara, durum/öncelik, tür, konu, açan, kanal. */
function fmtTicketLine(t) {
  const chan = t.status !== 'closed' && t.channel_id ? ` • <#${t.channel_id}>` : '';
  return `**#${t.id}** \`${STATUS_LABELS[t.status]} / ${PRIORITY_LABELS[t.priority]}\` `
    + `${ticketTypeLabel(t.type)} — ${clean(t.subject ?? '—', 60)}\n`
    + `└ <@${t.user_id}>${chan}`;
}

export default [
  {
    tier: Tier.MEMBER,
    data: new SlashCommandBuilder()
      .setName('destek')
      .setDescription('Destek talebi açar ve yönetir')
      .addSubcommand((s) => s.setName('aç').setDescription('Yeni bir destek talebi açar'))
      .addSubcommand((s) => s.setName('kapat').setDescription('Bulunduğun destek talebini kapatır'))
      .addSubcommand((s) => s.setName('listele').setDescription('Destek taleplerini listeler (Rehber+)')
        .addStringOption((o) => o.setName('durum').setDescription('Duruma göre filtrele')
          .addChoices(...STATUS_CHOICES)))
      .addSubcommand((s) => s.setName('bilgi').setDescription('Bir talebin ayrıntılarını gösterir (Rehber+)')
        .addIntegerOption((o) => o.setName('no').setDescription('Talep numarası').setRequired(true).setMinValue(1)))
      .addSubcommand((s) => s.setName('not').setDescription('Talebe dahili yetkili notu ekler (Rehber+)')
        .addIntegerOption((o) => o.setName('no').setDescription('Talep numarası').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('metin').setDescription('Not metni').setRequired(true).setMaxLength(500)))
      .addSubcommand((s) => s.setName('ata').setDescription('Talebi bir yetkiliye atar (Rehber+)')
        .addIntegerOption((o) => o.setName('no').setDescription('Talep numarası').setRequired(true).setMinValue(1))
        .addUserOption((o) => o.setName('yetkili').setDescription('Atanacak yetkili').setRequired(true)))
      .addSubcommand((s) => s.setName('öncelik').setDescription('Talebin önceliğini ayarlar (Rehber+)')
        .addIntegerOption((o) => o.setName('no').setDescription('Talep numarası').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('seviye').setDescription('Öncelik seviyesi').setRequired(true)
          .addChoices(
            { name: 'düşük', value: 'low' }, { name: 'normal', value: 'normal' },
            { name: 'yüksek', value: 'high' }, { name: 'acil', value: 'urgent' },
          )))
      .addSubcommand((s) => s.setName('ekle').setDescription('Talep kanalına kullanıcı ekler (Rehber+)')
        .addIntegerOption((o) => o.setName('no').setDescription('Talep numarası').setRequired(true).setMinValue(1))
        .addUserOption((o) => o.setName('kullanıcı').setDescription('Eklenecek kullanıcı').setRequired(true)))
      .addSubcommand((s) => s.setName('çıkar').setDescription('Talep kanalından kullanıcı çıkarır (Rehber+)')
        .addIntegerOption((o) => o.setName('no').setDescription('Talep numarası').setRequired(true).setMinValue(1))
        .addUserOption((o) => o.setName('kullanıcı').setDescription('Çıkarılacak kullanıcı').setRequired(true)))
      .addSubcommand((s) => s.setName('yenidenaç').setDescription('Kapalı bir talebi yeniden açar (Rehber+)')
        .addIntegerOption((o) => o.setName('no').setDescription('Talep numarası').setRequired(true).setMinValue(1)))
      .addSubcommandGroup((g) => g.setName('karaliste')
        .setDescription('Destek kara listesi (Baş Mod+)')
        .addSubcommand((s) => s.setName('ekle').setDescription('Kullanıcıyı destek kara listesine ekler (Baş Mod+)')
          .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true))
          .addStringOption((o) => o.setName('sebep').setDescription('Sebep').setMaxLength(300)))
        .addSubcommand((s) => s.setName('çıkar').setDescription('Kullanıcıyı destek kara listesinden çıkarır (Baş Mod+)')
          .addUserOption((o) => o.setName('kullanıcı').setDescription('Kullanıcı').setRequired(true)))),

    async execute(interaction) {
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();
      const tier = tierOf(interaction.member);

      /* ---------- üye tarafı ---------- */
      if (!group && sub === 'aç') return openTicket(interaction);
      if (!group && sub === 'kapat') return closeTicket(interaction);

      /* ---------- kara liste (BMOD+) ---------- */
      if (group === 'karaliste') {
        if (tier < Tier.BMOD) {
          return interaction.reply({
            embeds: [errEmbed('Destek kara listesi **Baş Mod** ve üzeri yetkililere açıktır.', 'Yetki Gerekli')],
            ephemeral: true,
          });
        }
        const user = interaction.options.getUser('kullanıcı', true);
        if (sub === 'ekle') {
          const reason = interaction.options.getString('sebep') ?? null;
          ticketBlacklist.add(user.id, reason, interaction.user.id);
          addCase('ticket_blacklist_add', user.id, interaction.user.id, reason, null);
          await sendLog(interaction.client, {
            title: 'Destek Kara Listesine Eklendi',
            color: Colors.danger,
            fields: [
              { name: 'Kullanıcı', value: `${user}`, inline: true },
              { name: 'Yetkili', value: `${interaction.user}`, inline: true },
              { name: 'Sebep', value: clean(reason ?? 'Belirtilmedi', 300), inline: false },
            ],
          });
          return interaction.reply({
            embeds: [okEmbed(`${user} artık destek talebi açamayacak.`, '🚫 Kara Listeye Eklendi')],
            ephemeral: true,
          });
        }
        if (!ticketBlacklist.remove(user.id)) {
          return interaction.reply({
            embeds: [errEmbed(`${user} zaten destek kara listesinde değil.`, 'Kayıt Bulunamadı')],
            ephemeral: true,
          });
        }
        addCase('ticket_blacklist_remove', user.id, interaction.user.id, null, null);
        await sendLog(interaction.client, {
          title: 'Destek Kara Listesinden Çıkarıldı',
          color: Colors.success,
          fields: [
            { name: 'Kullanıcı', value: `${user}`, inline: true },
            { name: 'Yetkili', value: `${interaction.user}`, inline: true },
          ],
        });
        return interaction.reply({
          embeds: [okEmbed(`${user} yeniden destek talebi açabilir.`, '✅ Kara Listeden Çıkarıldı')],
          ephemeral: true,
        });
      }

      /* ---------- yetkili alt komutları (REHBER+) ---------- */
      if (tier < Tier.REHBER) {
        return interaction.reply({
          embeds: [errEmbed('Bu alt komut **Rehber** ve üzeri yetkililere açıktır.', 'Yetki Gerekli')],
          ephemeral: true,
        });
      }

      if (sub === 'listele') {
        const status = interaction.options.getString('durum');
        const rows = ticketsV2.listByStatus(status, 20);
        if (!rows.length) {
          return interaction.reply({
            embeds: [emptyEmbed('Talep Yok', status
              ? `**${STATUS_LABELS[status]}** durumunda bir destek talebi bulunmuyor.`
              : 'Kayıtlı bir destek talebi bulunmuyor.')],
            ephemeral: true,
          });
        }
        return interaction.reply({
          embeds: [baseEmbed(Colors.info)
            .setTitle(`🎫 Destek Talepleri${status ? ` — ${STATUS_LABELS[status]}` : ''}`)
            .setDescription(rows.map(fmtTicketLine).join('\n'))
            .setFooter(brandFooter(`Son ${rows.length} kayıt`))],
          ephemeral: true,
        });
      }

      const no = interaction.options.getInteger('no', false);
      const ticket = no != null ? ticketsV2.get(no) : null;
      if (no != null && !ticket) {
        return interaction.reply({
          embeds: [errEmbed(`**#${no}** numaralı bir talep kaydı yok. Açık talepleri \`/destek listele\` ile görebilirsin.`,
            'Talep Bulunamadı')],
          ephemeral: true,
        });
      }

      if (sub === 'bilgi') {
        const sla = slaState(ticket);
        const notes = ticketNotes.of(ticket.id);
        const embed = baseEmbed(Colors.info)
          .setTitle(`🎫 Talep #${ticket.id} — ${clean(ticket.subject ?? '—', 100)}`)
          .setDescription(ticket.description ? clean(ticket.description, 1000) : '_Açıklama girilmemiş._')
          .addFields(
            { name: 'Durum', value: statusLine(ticket.status), inline: true },
            { name: 'Öncelik', value: PRIORITY_LABELS[ticket.priority] ?? ticket.priority, inline: true },
            { name: 'Tür', value: ticketTypeLabel(ticket.type), inline: true },
            { name: 'Açan', value: `<@${ticket.user_id}>`, inline: true },
            { name: 'İlgilenen yetkili', value: ticket.assignee_id ? `<@${ticket.assignee_id}>` : '—', inline: true },
            { name: 'Açılış', value: trDateTime(ticket.created_at), inline: true },
            {
              name: 'İlk yanıt (SLA)',
              value: sla.responded
                ? (sla.breached ? '🔴 Yanıtlandı — hedef aşılmıştı' : '🟢 Hedefte yanıtlandı')
                : (sla.breached ? '🔴 Hedef aşıldı' : `🟡 ${Math.ceil(sla.remainingMs / 60000)} dk kaldı`),
              inline: true,
            },
            { name: 'Yeniden açılma', value: `${ticket.reopen_count} kez`, inline: true },
            { name: 'Memnuniyet', value: ticket.satisfaction ? `${ticket.satisfaction}/5 ⭐` : '—', inline: true },
          );
        if (ticket.status === 'closed') {
          embed.addFields({
            name: 'Kapanış',
            value: `${ticket.closed_at ? trDateTime(ticket.closed_at) : '—'} • `
              + `${ticket.closed_by ? `<@${ticket.closed_by}>` : 'sistem'}\n`
              + `Sebep: ${clean(ticket.close_reason ?? '—', 200)}`,
          });
        }
        if (notes.length) {
          embed.addFields({
            name: `Notlar (${notes.length})`,
            value: notes.slice(-5)
              .map((n) => `• ${trDateTime(n.created_at)} — <@${n.author_id}>: ${clean(n.note, 150)}`)
              .join('\n'),
          });
        }
        return interaction.reply({
          embeds: [embed.setFooter(brandFooter(`Talep #${ticket.id}`))],
          ephemeral: true,
        });
      }

      if (sub === 'not') {
        const metin = interaction.options.getString('metin', true);
        ticketNotes.add(ticket.id, interaction.user.id, metin);
        addCase('ticket_note', ticket.user_id, interaction.user.id, null, `#${ticket.id}`);
        return interaction.reply({
          embeds: [okEmbed(`Notun **#${ticket.id}** talebine kaydedildi. Notları yalnız yetkililer görür.`,
            '📝 Not Eklendi')],
          ephemeral: true,
        });
      }

      if (sub === 'ata') {
        if (ticket.status === 'closed') {
          return interaction.reply({
            embeds: [errEmbed('Kapalı bir talep atanamaz. Önce `/destek yenidenaç` ile talebi yeniden aç.',
              'Talep Kapalı')],
            ephemeral: true,
          });
        }
        const yetkili = interaction.options.getUser('yetkili', true);
        const member = await interaction.guild.members.fetch(yetkili.id).catch(() => null);
        if (!member || tierOf(member) < Tier.REHBER) {
          return interaction.reply({
            embeds: [errEmbed('Talep yalnızca **Rehber** ve üzeri bir yetkiliye atanabilir.', 'Atama Yapılamadı')],
            ephemeral: true,
          });
        }
        ticketsV2.claim(ticket.id, yetkili.id);
        ticketsV2.setFirstResponse(ticket.id);
        addCase('ticket_assign', ticket.user_id, interaction.user.id, null, `#${ticket.id} → ${yetkili.id}`);
        await sendLog(interaction.client, {
          title: 'Talep Atandı',
          color: Colors.info,
          fields: [
            { name: 'Talep', value: `**#${ticket.id}**`, inline: true },
            { name: 'Atanan yetkili', value: `${yetkili}`, inline: true },
            { name: 'Atayan', value: `${interaction.user}`, inline: true },
          ],
        });
        return interaction.reply({
          embeds: [okEmbed(`**#${ticket.id}** talebi ${yetkili} yetkilisine atandı.`, '✋ Talep Atandı')],
          ephemeral: true,
        });
      }

      if (sub === 'öncelik') {
        const seviye = interaction.options.getString('seviye', true);
        if (!PRIORITIES.includes(seviye)) {
          return interaction.reply({
            embeds: [errEmbed('Geçerli öncelikler: düşük, normal, yüksek, acil.', 'Geçersiz Öncelik')],
            ephemeral: true,
          });
        }
        ticketsV2.setPriority(ticket.id, seviye);
        addCase('ticket_priority', ticket.user_id, interaction.user.id, null, `#${ticket.id} → ${seviye}`);
        return interaction.reply({
          embeds: [okEmbed(`**#${ticket.id}** artık **${PRIORITY_LABELS[seviye]}** öncelikli.`, '⚡ Öncelik Güncellendi')],
          ephemeral: true,
        });
      }

      if (sub === 'ekle' || sub === 'çıkar') {
        if (ticket.status === 'closed' || !ticket.channel_id) {
          return interaction.reply({
            embeds: [errEmbed('Bu talebin aktif bir kanalı yok.', 'Kanal Bulunamadı')],
            ephemeral: true,
          });
        }
        const user = interaction.options.getUser('kullanıcı', true);
        const res = sub === 'ekle'
          ? await addUserToTicket(interaction.client, ticket, user.id)
          : await removeUserFromTicket(interaction.client, ticket, user.id);
        if (!res.ok) return interaction.reply({ embeds: [errEmbed(res.error, 'İşlem Yapılamadı')], ephemeral: true });
        addCase(sub === 'ekle' ? 'ticket_user_add' : 'ticket_user_remove',
          user.id, interaction.user.id, null, `#${ticket.id}`);
        return interaction.reply({
          embeds: [okEmbed(sub === 'ekle'
            ? `${user} artık **#${ticket.id}** talep kanalını görebilir ve yazabilir.`
            : `${user} **#${ticket.id}** talep kanalından çıkarıldı.`,
          sub === 'ekle' ? '➕ Kullanıcı Eklendi' : '➖ Kullanıcı Çıkarıldı')],
          ephemeral: true,
        });
      }

      if (sub === 'yenidenaç') {
        const tr = applyTransition(ticket, 'open');
        if (!tr.ok && ticket.status !== 'closed') {
          return interaction.reply({
            embeds: [errEmbed(`**#${ticket.id}** hâlâ açık, yeniden açmaya gerek yok.`, 'Talep Zaten Açık')],
            ephemeral: true,
          });
        }
        if (!tr.ok) return interaction.reply({ embeds: [errEmbed(tr.error, 'Talep Açılamadı')], ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const res = await reopenTicket(interaction.client, ticket.id, interaction.user);
        if (!res.ok) return interaction.editReply({ embeds: [errEmbed(res.error, 'Talep Açılamadı')] });
        return interaction.editReply({
          embeds: [okEmbed(`**#${ticket.id}** için yeni bir kanal açıldı: ${res.channel}`, '🔓 Talep Yeniden Açıldı')],
        });
      }

      return interaction.reply({ embeds: [errEmbed('Bu alt komut tanınmıyor.', 'Bilinmeyen Komut')], ephemeral: true });
    },
  },
];
