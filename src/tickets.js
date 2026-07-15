import {
  ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  AttachmentBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  Events,
} from 'discord.js';
import { config } from './config.js';
import {
  ticketsV2, ticketMessages, ticketNotes, ticketBlacklist, getSetting, addCase,
} from './db.js';
import { baseEmbed, okEmbed, errEmbed, Colors } from './embeds.js';
import { Tier, tierOf } from './permissions.js';
import { sendLog, logChannelId } from './modlog.js';
import { trDateTime, clean } from './util.js';
import {
  TICKET_TYPES, ticketTypeLabel, STATUS_LABELS, PRIORITY_LABELS, PRIORITIES,
  applyTransition, nextPriority, slaState, renderTranscript, checkOpenAllowed,
  findOrphanTickets, DEFAULT_MAX_OPEN, DEFAULT_COOLDOWN_MINUTES,
} from './ticketcore.js';

/**
 * Destek sistemi 2.0 (Faz 5). İş mantığı ticketcore.js'te (bağımlılıksız,
 * test edilir); burada yalnız Discord tarafı var: panel select menüsü, tür
 * bazlı modal, numaralı kanallar, claim/öncelik/beklet/kapat akışı, tam
 * transcript deposu, SLA uyarıları ve reconciliation.
 *
 * Eski customId'ler çalışmaya devam eder:
 *   ticket:open  → 'genel' türü için oluşturma modalı
 *   ticket:close → kapatma onayı akışı
 */

const STAFF_ROLE_IDS = () => [
  config.roles.kurucu, config.roles.admin, config.roles.bmod, config.roles.mod, config.roles.rehber,
];

const INACTIVITY_MS = 48 * 3600 * 1000;

/* ------------------------------------------------------------------ */
/* Ayarlar                                                             */
/* ------------------------------------------------------------------ */

export function ticketsEnabled() {
  return getSetting('tickets_enabled', '1') === '1';
}

function intSetting(key, fallback) {
  const v = Number.parseInt(getSetting(key, ''), 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function slaOverrides() {
  const out = {};
  for (const p of PRIORITIES) {
    const v = Number.parseInt(getSetting(`ticket_sla_${p}`, ''), 10);
    if (Number.isFinite(v) && v > 0) out[p] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Ortak yapı taşları                                                  */
/* ------------------------------------------------------------------ */

function safeName(username) {
  return String(username).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'uye';
}

function channelNameFor(ticket, username, claimed = Boolean(ticket.assignee_id)) {
  return `${claimed ? '✋-' : ''}destek-${ticket.id}-${safeName(username)}`;
}

function buildOverwrites(guild, openerId) {
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: openerId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
    },
  ];
  for (const roleId of STAFF_ROLE_IDS()) {
    if (guild.roles.cache.has(roleId)) {
      overwrites.push({
        id: roleId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
      });
    }
  }
  return overwrites;
}

export function buildTicketEmbed(ticket) {
  const t = TICKET_TYPES[ticket.type] ?? TICKET_TYPES.genel;
  const embed = baseEmbed(Colors.main)
    .setTitle(`${t.emoji} Destek Talebi #${ticket.id} — ${clean(ticket.subject ?? t.label, 100)}`)
    .setDescription(ticket.description ? clean(ticket.description, 1500) : '_Açıklama yok._')
    .addFields(
      { name: 'Tür', value: t.label, inline: true },
      { name: 'Durum', value: STATUS_LABELS[ticket.status] ?? ticket.status, inline: true },
      { name: 'Öncelik', value: PRIORITY_LABELS[ticket.priority] ?? ticket.priority, inline: true },
      { name: 'Açan', value: `<@${ticket.user_id}>`, inline: true },
      { name: 'İlgilenen', value: ticket.assignee_id ? `<@${ticket.assignee_id}>` : '_Henüz üstlenilmedi_', inline: true },
    );
  if (ticket.reopen_count > 0) {
    embed.addFields({ name: 'Yeniden açılma', value: `${ticket.reopen_count} kez`, inline: true });
  }
  return embed;
}

export function ticketButtonRows(ticket) {
  const staff = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`)
      .setLabel(ticket.assignee_id ? 'Bırak' : 'Üstlen').setEmoji('✋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ticket:prio:${ticket.id}`)
      .setLabel('Öncelik').setEmoji('⚡').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket:hold:${ticket.id}`)
      .setLabel(ticket.status === 'pending' ? 'Devam Et' : 'Beklet').setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
  );
  const user = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:close2:${ticket.id}`)
      .setLabel('Talebi Kapat').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );
  return [staff, user];
}

/** /admin ticketpanel'in gönderdiği tür seçme menüsü. */
export function ticketPanelComponents() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket:type')
    .setPlaceholder('Bir destek konusu seç…')
    .addOptions(Object.entries(TICKET_TYPES).map(([value, t]) => ({
      value, label: t.label, description: t.desc, emoji: t.emoji,
    })));
  return [new ActionRowBuilder().addComponents(menu)];
}

/* ------------------------------------------------------------------ */
/* Açma kontrolleri + oluşturma modalı                                 */
/* ------------------------------------------------------------------ */

function openGate(userId) {
  if (!ticketsEnabled()) {
    return { ok: false, message: 'Destek sistemi şu anda **devre dışı**. Daha sonra tekrar dene.' };
  }
  return checkOpenAllowed({
    blacklisted: Boolean(ticketBlacklist.get(userId)),
    openCount: ticketsV2.openByUser(userId).length,
    maxOpen: intSetting('ticket_max_open', DEFAULT_MAX_OPEN),
    lastOpenAt: ticketsV2.lastCreatedAt(userId),
    cooldownMinutes: intSetting('ticket_cooldown_minutes', DEFAULT_COOLDOWN_MINUTES),
  });
}

async function showCreateModal(interaction, type) {
  const t = TICKET_TYPES[type] ?? TICKET_TYPES.genel;
  const gate = openGate(interaction.user.id);
  if (!gate.ok) {
    return interaction.reply({ embeds: [errEmbed(gate.message)], ephemeral: true });
  }
  const modal = new ModalBuilder()
    .setCustomId(`ticket:create:${TICKET_TYPES[type] ? type : 'genel'}`)
    .setTitle(`Destek Talebi — ${t.label}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('konu').setLabel('Konu')
          .setPlaceholder('Sorununu tek cümleyle özetle')
          .setStyle(TextInputStyle.Short).setMinLength(5).setMaxLength(100).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('aciklama').setLabel('Açıklama')
          .setPlaceholder('Sorununu ayrıntılı anlat: ne oldu, ne zaman, hata mesajı vs.')
          .setStyle(TextInputStyle.Paragraph).setMinLength(10).setMaxLength(1000).setRequired(true),
      ),
    );
  if (t.extraField) {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('hedef').setLabel(t.extraField)
        .setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true),
    ));
  }
  return interaction.showModal(modal);
}

async function createTicket(interaction, type) {
  await interaction.deferReply({ ephemeral: true });
  const gate = openGate(interaction.user.id);
  if (!gate.ok) return interaction.editReply({ embeds: [errEmbed(gate.message)] });

  const guild = interaction.guild;
  const subject = interaction.fields.getTextInputValue('konu').trim();
  let description = interaction.fields.getTextInputValue('aciklama').trim();
  if (TICKET_TYPES[type]?.extraField) {
    const hedef = interaction.fields.getTextInputValue('hedef').trim();
    description = `**${TICKET_TYPES[type].extraField}:** ${hedef}\n\n${description}`;
  }

  const id = ticketsV2.create({ userId: interaction.user.id, type, subject, description });
  const ticket = ticketsV2.get(id);

  const categoryId = getSetting(`ticket_category_${type}`) || getSetting('ticket_category');
  let channel;
  try {
    channel = await guild.channels.create({
      name: channelNameFor(ticket, interaction.user.username),
      type: ChannelType.GuildText,
      parent: categoryId || undefined,
      permissionOverwrites: buildOverwrites(guild, interaction.user.id),
      reason: `Destek talebi #${id}: ${interaction.user.tag}`,
    });
  } catch (err) {
    ticketsV2.close(id, { reason: `kanal oluşturulamadı: ${err.message}` });
    return interaction.editReply({
      embeds: [errEmbed(`Talep kanalı oluşturulamadı: ${err.message}\n`
        + 'Kategori ayarını (`/admin ticketkategori`) ve bot izinlerini kontrol edin.')],
    });
  }

  ticketsV2.setChannel(id, channel.id);
  // Açılış açıklaması transcript'in ilk kaydı olur.
  ticketMessages.add(id, {
    authorId: interaction.user.id,
    authorTag: interaction.user.tag,
    content: `[Talep açılışı] Konu: ${subject}\n${description}`,
  });
  addCase('ticket_open', interaction.user.id, interaction.user.id, subject, `#${id} (${type})`);

  const fresh = ticketsV2.get(id);
  await channel.send({
    content: `${interaction.user}`,
    embeds: [buildTicketEmbed(fresh)],
    components: ticketButtonRows(fresh),
  });
  await sendLog(interaction.client, {
    title: '🎫 Destek Talebi Açıldı',
    color: Colors.info,
    description: `**#${id}** • ${ticketTypeLabel(type)} • ${interaction.user} → ${channel}\nKonu: ${clean(subject, 150)}`,
  });
  return interaction.editReply({ embeds: [okEmbed(`🎫 **#${id}** numaralı destek talebin açıldı: ${channel}`)] });
}

/* ------------------------------------------------------------------ */
/* Eski giriş noktaları (geri uyumluluk)                               */
/* ------------------------------------------------------------------ */

/** Eski `ticket:open` butonu ve `/destek aç` — 'genel' türünde modal açar. */
export async function openTicket(interaction) {
  return showCreateModal(interaction, 'genel');
}

/** Eski `ticket:close` butonu ve `/destek kapat` — kapatma onayı akışı. */
export async function closeTicket(interaction) {
  const ticket = ticketsV2.getByChannel(interaction.channel?.id);
  if (!ticket) {
    return interaction.reply({ embeds: [errEmbed('Bu kanal bir destek talebi değil.')], ephemeral: true });
  }
  return startCloseConfirm(interaction, ticket);
}

/* ------------------------------------------------------------------ */
/* Kapatma akışı: onay → sebep modalı → kapanış                        */
/* ------------------------------------------------------------------ */

function canClose(interaction, ticket) {
  return ticket.user_id === interaction.user.id || tierOf(interaction.member) >= Tier.REHBER;
}

async function startCloseConfirm(interaction, ticket) {
  if (!canClose(interaction, ticket)) {
    return interaction.reply({
      embeds: [errEmbed('Talebi yalnızca açan kişi veya yetkililer kapatabilir.')], ephemeral: true,
    });
  }
  return interaction.reply({
    embeds: [baseEmbed(Colors.warn)
      .setTitle('🔒 Talep kapatılsın mı?')
      .setDescription(`**#${ticket.id}** numaralı talep kapatılacak, transcript kaydedilecek ve kanal silinecek.`)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket:closeok:${ticket.id}`)
        .setLabel('Evet, kapat').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`ticket:closecancel:${ticket.id}`)
        .setLabel('Vazgeç').setStyle(ButtonStyle.Secondary),
    )],
    ephemeral: true,
  });
}

function ratingRow(ticketId) {
  return new ActionRowBuilder().addComponents(
    [1, 2, 3, 4, 5].map((n) => new ButtonBuilder()
      .setCustomId(`ticket:rate:${ticketId}:${n}`)
      .setLabel('⭐'.repeat(n))
      .setStyle(n >= 4 ? ButtonStyle.Success : ButtonStyle.Secondary)),
  );
}

async function performClose(interaction, ticket, reason) {
  const tr = applyTransition(ticket, 'closed');
  if (!tr.ok) {
    return interaction.reply({ embeds: [errEmbed(tr.error)], ephemeral: true });
  }
  await interaction.deferReply().catch(() => null);

  ticketsV2.close(ticket.id, { closedBy: interaction.user.id, reason });
  const fresh = ticketsV2.get(ticket.id);
  const rows = ticketMessages.of(ticket.id);
  const transcript = renderTranscript(fresh, rows, { formatTime: trDateTime });
  const fileName = `destek-${ticket.id}.txt`;

  addCase('ticket_close', ticket.user_id, interaction.user.id, reason, `#${ticket.id}`);

  // 1) Log kanalına transcript.
  const logId = logChannelId();
  if (logId) {
    const logChannel = await interaction.client.channels.fetch(logId).catch(() => null);
    if (logChannel?.isTextBased()) {
      await logChannel.send({
        embeds: [baseEmbed(Colors.dark)
          .setTitle(`🎫 Destek Talebi Kapatıldı — #${ticket.id}`)
          .setDescription(`Açan: <@${ticket.user_id}> • Kapatan: ${interaction.user}\n`
            + `Tür: ${ticketTypeLabel(ticket.type)} • Konu: ${clean(ticket.subject ?? '-', 150)}\n`
            + `Sebep: ${clean(reason, 300)} • Mesaj: ${rows.length}`)],
        files: [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: fileName })],
      }).catch(() => null);
    }
  }

  // 2) Açan kişiye DM: kapanış özeti + transcript + memnuniyet anketi.
  try {
    const opener = await interaction.client.users.fetch(ticket.user_id);
    const dmPayload = {
      embeds: [baseEmbed(Colors.main)
        .setTitle(`🎫 Destek talebin kapatıldı — #${ticket.id}`)
        .setDescription(`Konu: ${clean(ticket.subject ?? '-', 150)}\n`
          + `Kapanış sebebi: ${clean(reason, 300)}\n\n`
          + 'Transcript ektedir. Destek deneyimini aşağıdan puanlayabilirsin (1-5 yıldız).')],
      files: [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: fileName })],
    };
    if (fresh.satisfaction == null) dmPayload.components = [ratingRow(ticket.id)];
    await opener.send(dmPayload);
  } catch {
    /* DM kapalı — transcript log kanalında zaten duruyor */
  }

  await interaction.editReply({
    embeds: [okEmbed(`🔒 **#${ticket.id}** kapatıldı. Kanal 5 saniye içinde silinecek — transcript kalıcı olarak saklandı.`)],
  }).catch(() => null);

  const channel = interaction.channel;
  setTimeout(() => channel?.delete(`Destek talebi #${ticket.id} kapatıldı`).catch(() => null), 5000);
}

/* ------------------------------------------------------------------ */
/* Yeniden açma                                                        */
/* ------------------------------------------------------------------ */

export async function reopenTicket(client, ticketId, actor) {
  const ticket = ticketsV2.get(ticketId);
  if (!ticket) return { ok: false, error: `#${ticketId} numaralı talep bulunamadı.` };
  const tr = applyTransition(ticket, 'open');
  if (!tr.ok) return { ok: false, error: tr.error };

  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return { ok: false, error: 'Sunucu bulunamadı.' };
  const openerUser = await client.users.fetch(ticket.user_id).catch(() => null);
  const username = openerUser?.username ?? 'uye';

  let channel;
  try {
    channel = await guild.channels.create({
      name: `destek-${ticket.id}-${safeName(username)}`,
      type: ChannelType.GuildText,
      parent: getSetting(`ticket_category_${ticket.type}`) || getSetting('ticket_category') || undefined,
      permissionOverwrites: buildOverwrites(guild, ticket.user_id),
      reason: `Destek talebi #${ticket.id} yeniden açıldı (${actor.tag ?? actor.id})`,
    });
  } catch (err) {
    return { ok: false, error: `Kanal oluşturulamadı: ${err.message}` };
  }

  ticketsV2.reopen(ticket.id, channel.id);
  ticketsV2.unclaim(ticket.id);
  const fresh = ticketsV2.get(ticket.id);
  ticketMessages.add(ticket.id, {
    authorId: actor.id, authorTag: actor.tag ?? String(actor.id),
    content: `[Talep yeniden açıldı — ${fresh.reopen_count}. kez]`,
  });
  await channel.send({
    content: `<@${ticket.user_id}>`,
    embeds: [buildTicketEmbed(fresh)],
    components: ticketButtonRows(fresh),
  });
  addCase('ticket_reopen', ticket.user_id, actor.id, null, `#${ticket.id}`);
  await sendLog(client, {
    title: '🎫 Destek Talebi Yeniden Açıldı',
    color: Colors.warn,
    description: `**#${ticket.id}** • <@${actor.id}> tarafından → ${channel}`,
  });
  return { ok: true, channel, ticket: fresh };
}

/* ------------------------------------------------------------------ */
/* Kanala kullanıcı ekleme / çıkarma                                   */
/* ------------------------------------------------------------------ */

export async function addUserToTicket(client, ticket, userId) {
  const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel) return { ok: false, error: 'Talep kanalı bulunamadı.' };
  await channel.permissionOverwrites.edit(userId, {
    ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
  });
  return { ok: true, channel };
}

export async function removeUserFromTicket(client, ticket, userId) {
  if (userId === ticket.user_id) return { ok: false, error: 'Talebi açan kişi kanaldan çıkarılamaz.' };
  const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel) return { ok: false, error: 'Talep kanalı bulunamadı.' };
  await channel.permissionOverwrites.delete(userId).catch(() => null);
  return { ok: true, channel };
}

/* ------------------------------------------------------------------ */
/* Buton / modal / menü işleyicileri                                   */
/* ------------------------------------------------------------------ */

function ticketFromId(interaction) {
  const id = Number.parseInt(interaction.customId.split(':')[2], 10);
  return Number.isInteger(id) ? ticketsV2.get(id) : null;
}

async function refreshTicketMessage(interaction, ticket) {
  // Buton, talep embed'inin olduğu mesajda — embed'i güncel satırla tazele.
  await interaction.update({
    embeds: [buildTicketEmbed(ticket)],
    components: ticketButtonRows(ticket),
  }).catch(() => null);
}

export const ticketComponents = {
  'ticket:open': (interaction) => {
    if (!ticketsEnabled()) {
      return interaction.reply({ embeds: [errEmbed('Destek sistemi şu anda **devre dışı**.')], ephemeral: true });
    }
    return openTicket(interaction);
  },

  'ticket:type': async (interaction) => {
    if (!ticketsEnabled()) {
      return interaction.reply({ embeds: [errEmbed('Destek sistemi şu anda **devre dışı**.')], ephemeral: true });
    }
    const type = interaction.values?.[0];
    return showCreateModal(interaction, TICKET_TYPES[type] ? type : 'genel');
  },

  'ticket:create': async (interaction) => {
    const type = interaction.customId.split(':')[2] ?? 'genel';
    return createTicket(interaction, TICKET_TYPES[type] ? type : 'genel');
  },

  'ticket:claim': async (interaction) => {
    const ticket = ticketFromId(interaction);
    if (!ticket || ticket.status === 'closed') {
      return interaction.reply({ embeds: [errEmbed('Bu talep artık aktif değil.')], ephemeral: true });
    }
    const tier = tierOf(interaction.member);
    if (ticket.assignee_id) {
      // Bırakma: üstlenen kişi veya BMOD+.
      if (interaction.user.id !== ticket.assignee_id && tier < Tier.BMOD) {
        return interaction.reply({
          embeds: [errEmbed('Talebi yalnızca üstlenen yetkili veya Baş Mod+ bırakabilir.')], ephemeral: true,
        });
      }
      ticketsV2.unclaim(ticket.id);
      addCase('ticket_unclaim', ticket.user_id, interaction.user.id, null, `#${ticket.id}`);
      const fresh = ticketsV2.get(ticket.id);
      await refreshTicketMessage(interaction, fresh);
      await interaction.channel?.setName(channelNameFor(fresh, interaction.channel.name.split('-').pop() ?? 'uye', false)).catch(() => null);
      return interaction.followUp({ embeds: [okEmbed(`✋ **#${ticket.id}** bırakıldı — talep tekrar sahipsiz.`)] }).catch(() => null);
    }
    if (tier < Tier.REHBER) {
      return interaction.reply({ embeds: [errEmbed('Talepleri yalnızca yetkililer (Rehber+) üstlenebilir.')], ephemeral: true });
    }
    ticketsV2.claim(ticket.id, interaction.user.id);
    ticketsV2.setFirstResponse(ticket.id);
    addCase('ticket_claim', ticket.user_id, interaction.user.id, null, `#${ticket.id}`);
    const fresh = ticketsV2.get(ticket.id);
    await refreshTicketMessage(interaction, fresh);
    await interaction.channel?.setName(channelNameFor(fresh, interaction.channel.name.split('-').pop() ?? 'uye', true)).catch(() => null);
    return interaction.followUp({
      embeds: [okEmbed(`✋ **#${ticket.id}** talebini ${interaction.user} üstlendi.`)],
    }).catch(() => null);
  },

  'ticket:prio': async (interaction) => {
    const ticket = ticketFromId(interaction);
    if (!ticket || ticket.status === 'closed') {
      return interaction.reply({ embeds: [errEmbed('Bu talep artık aktif değil.')], ephemeral: true });
    }
    if (tierOf(interaction.member) < Tier.REHBER) {
      return interaction.reply({ embeds: [errEmbed('Önceliği yalnızca yetkililer (Rehber+) değiştirebilir.')], ephemeral: true });
    }
    const next = nextPriority(ticket.priority);
    ticketsV2.setPriority(ticket.id, next);
    addCase('ticket_priority', ticket.user_id, interaction.user.id, null, `#${ticket.id} → ${next}`);
    const fresh = ticketsV2.get(ticket.id);
    await refreshTicketMessage(interaction, fresh);
    return interaction.followUp({
      embeds: [okEmbed(`⚡ **#${ticket.id}** önceliği: **${PRIORITY_LABELS[next]}**`)],
    }).catch(() => null);
  },

  'ticket:hold': async (interaction) => {
    const ticket = ticketFromId(interaction);
    if (!ticket || ticket.status === 'closed') {
      return interaction.reply({ embeds: [errEmbed('Bu talep artık aktif değil.')], ephemeral: true });
    }
    if (tierOf(interaction.member) < Tier.REHBER) {
      return interaction.reply({ embeds: [errEmbed('Bekletmeyi yalnızca yetkililer (Rehber+) kullanabilir.')], ephemeral: true });
    }
    const target = ticket.status === 'pending' ? 'open' : 'pending';
    const tr = applyTransition(ticket, target);
    if (!tr.ok) return interaction.reply({ embeds: [errEmbed(tr.error)], ephemeral: true });
    ticketsV2.setStatus(ticket.id, target);
    addCase('ticket_status', ticket.user_id, interaction.user.id, null, `#${ticket.id} → ${target}`);
    const fresh = ticketsV2.get(ticket.id);
    await refreshTicketMessage(interaction, fresh);
    return interaction.followUp({
      embeds: [okEmbed(target === 'pending'
        ? `⏸️ **#${ticket.id}** beklemeye alındı.`
        : `▶️ **#${ticket.id}** tekrar aktif.`)],
    }).catch(() => null);
  },

  'ticket:close2': async (interaction) => {
    const ticket = ticketFromId(interaction);
    if (!ticket || ticket.status === 'closed') {
      return interaction.reply({ embeds: [errEmbed('Bu talep zaten kapalı.')], ephemeral: true });
    }
    return startCloseConfirm(interaction, ticket);
  },

  'ticket:close': (interaction) => closeTicket(interaction),

  'ticket:closeok': async (interaction) => {
    const ticket = ticketFromId(interaction);
    if (!ticket || ticket.status === 'closed') {
      return interaction.reply({ embeds: [errEmbed('Bu talep zaten kapalı.')], ephemeral: true });
    }
    if (!canClose(interaction, ticket)) {
      return interaction.reply({ embeds: [errEmbed('Talebi yalnızca açan kişi veya yetkililer kapatabilir.')], ephemeral: true });
    }
    const modal = new ModalBuilder()
      .setCustomId(`ticket:closemodal:${ticket.id}`)
      .setTitle(`Talep #${ticket.id} — Kapatma Sebebi`.slice(0, 45))
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('sebep').setLabel('Kapatma sebebi')
          .setPlaceholder('Örn: sorun çözüldü')
          .setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(300).setRequired(true),
      ));
    return interaction.showModal(modal);
  },

  'ticket:closecancel': (interaction) => interaction.update({
    embeds: [okEmbed('Kapatma iptal edildi — talep açık kalıyor.')],
    components: [],
  }),

  'ticket:closemodal': async (interaction) => {
    const ticket = ticketFromId(interaction);
    if (!ticket || ticket.status === 'closed') {
      return interaction.reply({ embeds: [errEmbed('Bu talep zaten kapalı.')], ephemeral: true });
    }
    if (!canClose(interaction, ticket)) {
      return interaction.reply({ embeds: [errEmbed('Talebi yalnızca açan kişi veya yetkililer kapatabilir.')], ephemeral: true });
    }
    const reason = interaction.fields.getTextInputValue('sebep').trim();
    return performClose(interaction, ticket, reason);
  },

  'ticket:rate': async (interaction) => {
    const [, , rawId, rawScore] = interaction.customId.split(':');
    const id = Number.parseInt(rawId, 10);
    const score = Number.parseInt(rawScore, 10);
    const ticket = Number.isInteger(id) ? ticketsV2.get(id) : null;
    if (!ticket || !(score >= 1 && score <= 5)) {
      return interaction.reply({ embeds: [errEmbed('Bu değerlendirme artık geçerli değil.')], ephemeral: true });
    }
    if (ticket.user_id !== interaction.user.id) {
      return interaction.reply({ embeds: [errEmbed('Bu değerlendirme sana ait değil.')], ephemeral: true });
    }
    if (!ticketsV2.rate(id, score)) {
      return interaction.reply({ embeds: [errEmbed('Bu talebi zaten puanladın — teşekkürler!')], ephemeral: true });
    }
    addCase('ticket_rate', ticket.user_id, ticket.user_id, null, `#${id} → ${score}/5`);
    await sendLog(interaction.client, {
      title: '⭐ Destek Değerlendirmesi',
      color: Colors.success,
      description: `**#${id}** • <@${ticket.user_id}> → **${score}/5** ${'⭐'.repeat(score)}`,
    });
    return interaction.update({
      embeds: [okEmbed(`Teşekkürler! **#${id}** için değerlendirmen kaydedildi: **${score}/5** ${'⭐'.repeat(score)}`)],
      components: [],
    }).catch(() => interaction.reply({
      embeds: [okEmbed(`Teşekkürler! Değerlendirmen kaydedildi: **${score}/5**`)], ephemeral: true,
    }));
  },
};

/* ------------------------------------------------------------------ */
/* Mesaj kaydı (tam transcript) + ilk yanıt tespiti                    */
/* ------------------------------------------------------------------ */

export function registerTicketMessages(client) {
  client.on(Events.MessageCreate, (message) => {
    try {
      if (!message.guild || message.guild.id !== config.guildId) return;
      const ticket = ticketsV2.getByChannel(message.channel.id);
      if (!ticket) return;
      ticketMessages.add(ticket.id, {
        messageId: message.id,
        authorId: message.author.id,
        authorTag: message.author.tag,
        content: message.content || null,
        embedsSummary: message.embeds.length
          ? message.embeds.map((e) => e.title || e.description || 'embed').join(' | ').slice(0, 300)
          : null,
        attachments: [...message.attachments.values()].map((a) => ({ name: a.name, url: a.url })),
        createdAt: message.createdTimestamp,
      });
      // İlk yetkili yanıtı SLA saatini durdurur (bot mesajları sayılmaz).
      if (!message.author.bot && ticket.first_response_at == null
        && message.author.id !== ticket.user_id && message.member
        && tierOf(message.member) >= Tier.REHBER) {
        ticketsV2.setFirstResponse(ticket.id, message.createdTimestamp);
      }
    } catch (err) {
      console.error('[ticket] mesaj kaydı hatası:', err.message);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Reconciliation + SLA / hareketsizlik gözcüsü                        */
/* ------------------------------------------------------------------ */

export async function reconcileTickets(client) {
  try {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return 0;
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) return 0;
    const orphans = findOrphanTickets(ticketsV2.active(), channels.keys());
    for (const id of orphans) {
      const ticket = ticketsV2.get(id);
      if (!ticketsV2.markOrphanClosed(id)) continue;
      addCase('ticket_close', ticket.user_id, client.user?.id ?? null,
        'kanal silinmiş (reconciliation)', `#${id}`);
      await sendLog(client, {
        title: '🎫 Talep Otomatik Kapatıldı',
        color: Colors.warn,
        description: `**#${id}** — kanalı elle silinmiş, kayıt kapalıya çekildi (reconciliation).`,
      });
    }
    if (orphans.length) console.log(`[ticket] reconciliation: ${orphans.length} sahipsiz talep kapatıldı`);
    return orphans.length;
  } catch (err) {
    console.error('[ticket] reconciliation hatası:', err.message);
    return 0;
  }
}

async function slaSweep(client) {
  const overrides = slaOverrides();
  const now = Date.now();
  for (const ticket of ticketsV2.active()) {
    // 1) SLA: sahiplenilmemiş + ilk yanıtsız + hedef aşılmış → tek seferlik uyarı.
    if (!ticket.sla_warned && !ticket.assignee_id && ticket.first_response_at == null
      && slaState(ticket, now, overrides).breached) {
      ticketsV2.markSlaWarned(ticket.id);
      await sendLog(client, {
        title: '⏰ Destek SLA Uyarısı',
        color: Colors.danger,
        description: `**#${ticket.id}** (${PRIORITY_LABELS[ticket.priority]}) hedef sürede yanıtlanmadı!\n`
          + `Açan: <@${ticket.user_id}> • Kanal: <#${ticket.channel_id}> • `
          + `Hedef: ${slaState(ticket, now, overrides).targetMinutes} dk`,
      });
    }
    // 2) Hareketsizlik: 48 saattir mesaj yok → kanala tek seferlik hatırlatma.
    if (!ticket.inactivity_warned_at) {
      const lastAt = ticketMessages.lastAt(ticket.id) ?? ticket.created_at;
      if (now - lastAt >= INACTIVITY_MS) {
        ticketsV2.markInactivityWarned(ticket.id, now);
        const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
        if (channel?.isTextBased()) {
          await channel.send({
            content: `<@${ticket.user_id}>`,
            embeds: [baseEmbed(Colors.warn)
              .setTitle('⏳ Bu talepte 48 saattir hareket yok')
              .setDescription('Sorunun çözüldüyse talebi kapatabilirsin; hâlâ yardım gerekiyorsa bir mesaj yaz.')],
          }).catch(() => null);
        }
      }
    }
  }
}

let watcherStarted = false;

/** ready'de çağrılır: önce reconciliation, sonra dakikalık SLA gözcüsü. */
export function startTicketWatcher(client) {
  if (watcherStarted) return;
  watcherStarted = true;
  reconcileTickets(client);
  setInterval(() => {
    slaSweep(client).catch((err) => console.error('[ticket] SLA taraması hatası:', err.message));
  }, 60_000).unref();
  console.log('[ticket] destek gözcüsü aktif (reconciliation + SLA, 60sn).');
}
