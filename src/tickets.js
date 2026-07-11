import {
  ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  AttachmentBuilder,
} from 'discord.js';
import { config } from './config.js';
import { tickets, getSetting, addCase } from './db.js';
import { baseEmbed, okEmbed, errEmbed, Colors } from './embeds.js';
import { Tier, tierOf } from './permissions.js';
import { sendLog, logChannelId } from './modlog.js';
import { trDateTime } from './util.js';

/**
 * Support ticket system. The panel button opens a private channel visible to
 * the opener + staff; closing produces a text transcript in the log channel.
 * Link düzeltmeleri ("değişiklik için destek talebi aç") de buradan yürür.
 */

const STAFF_ROLE_IDS = () => [
  config.roles.kurucu, config.roles.admin, config.roles.bmod, config.roles.mod, config.roles.rehber,
];

function closeRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Talebi Kapat')
      .setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );
}

export async function openTicket(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild;

  // Tek kullanıcı — tek açık talep.
  for (const t of tickets.openByUser(interaction.user.id)) {
    const existing = await guild.channels.fetch(t.channel_id).catch(() => null);
    if (existing) {
      return interaction.editReply({ embeds: [errEmbed(`Zaten açık bir destek talebin var: ${existing}`)] });
    }
    tickets.close(t.channel_id); // kanal elle silinmiş — kaydı temizle
  }

  const categoryId = getSetting('ticket_category');
  const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'uye';
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
    },
  ];
  for (const roleId of STAFF_ROLE_IDS()) {
    if (guild.roles.cache.has(roleId)) {
      overwrites.push({
        id: roleId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory],
      });
    }
  }

  let channel;
  try {
    channel = await guild.channels.create({
      name: `destek-${safeName}`,
      type: ChannelType.GuildText,
      parent: categoryId || undefined,
      permissionOverwrites: overwrites,
      reason: `Destek talebi: ${interaction.user.tag}`,
    });
  } catch (err) {
    return interaction.editReply({
      embeds: [errEmbed(`Talep kanalı oluşturulamadı: ${err.message}\n`
        + 'Kategori ayarını (`/admin ticketkategori`) ve bot izinlerini kontrol edin.')],
    });
  }

  tickets.create(channel.id, interaction.user.id);
  addCase('ticket_open', interaction.user.id, interaction.user.id, null, channel.id);

  await channel.send({
    content: `${interaction.user}`,
    embeds: [baseEmbed(Colors.main)
      .setTitle('🎫 Destek Talebi')
      .setDescription('Talebini ayrıntılı yaz — ekip en kısa sürede ilgilenecek.\n\n'
        + '• Hesap bağlantısı düzeltmesi için: mevcut MC adını, doğru hesabı ve sebebini yaz.\n'
        + '• İşin bitince aşağıdaki **Talebi Kapat** butonunu kullanabilirsin.')],
    components: [closeRow()],
  });
  await sendLog(interaction.client, {
    title: '🎫 Destek Talebi Açıldı',
    color: Colors.info,
    description: `${interaction.user} → ${channel}`,
  });
  return interaction.editReply({ embeds: [okEmbed(`🎫 Destek talebin açıldı: ${channel}`)] });
}

/** Builds a plain-text transcript of the ticket channel (newest 100 messages). */
async function transcriptOf(channel) {
  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return 'Transcript alınamadı.';
  const lines = [...messages.values()]
    .reverse()
    .map((m) => {
      const stamp = trDateTime(m.createdTimestamp);
      const attachments = m.attachments.size ? ` [${m.attachments.size} dosya]` : '';
      const embeds = m.embeds.length ? ' [embed]' : '';
      return `[${stamp}] ${m.author.tag}: ${m.content || ''}${attachments}${embeds}`;
    });
  return `NautilusUHC destek transcript — #${channel.name}\n\n${lines.join('\n')}`;
}

export async function closeTicket(interaction) {
  const ticket = tickets.get(interaction.channel.id);
  if (!ticket) {
    return interaction.reply({ embeds: [errEmbed('Bu kanal bir destek talebi değil.')], ephemeral: true });
  }
  const isOwner = ticket.user_id === interaction.user.id;
  if (!isOwner && tierOf(interaction.member) < Tier.REHBER) {
    return interaction.reply({ embeds: [errEmbed('Talebi yalnızca açan kişi veya yetkililer kapatabilir.')], ephemeral: true });
  }

  await interaction.reply({ embeds: [okEmbed('🔒 Talep kapatılıyor, transcript kaydediliyor…')] });

  const transcript = await transcriptOf(interaction.channel);
  const logId = logChannelId();
  if (logId) {
    const logChannel = await interaction.client.channels.fetch(logId).catch(() => null);
    if (logChannel?.isTextBased()) {
      await logChannel.send({
        embeds: [baseEmbed(Colors.dark)
          .setTitle('🎫 Destek Talebi Kapatıldı')
          .setDescription(`Açan: <@${ticket.user_id}> • Kapatan: ${interaction.user} • Kanal: #${interaction.channel.name}`)],
        files: [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: `${interaction.channel.name}.txt` })],
      }).catch(() => null);
    }
  }

  tickets.close(interaction.channel.id);
  addCase('ticket_close', ticket.user_id, interaction.user.id, null, interaction.channel.name);
  setTimeout(() => interaction.channel.delete('Destek talebi kapatıldı').catch(() => null), 3000);
}
