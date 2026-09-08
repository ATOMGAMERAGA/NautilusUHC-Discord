import {
  ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  AttachmentBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  Events,
} from 'discord.js';
import { config } from './config.js';
import {
  ticketsV2, ticketMessages, ticketBlacklist, getSetting, addCase,
} from './db.js';
import {
  baseEmbed, okEmbed, errEmbed, warnEmbed, neutralEmbed, brandFooter, failureEmbed, Colors,
} from './embeds.js';
import { Tier, tierOf } from './permissions.js';
import { sendLog, logChannelId } from './modlog.js';
import { trDateTime, clean, mentionUsers } from './util.js';
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

/** Öncelik, talebin rengini belirler — acil bir talep listede hemen ayrışır. */
const PRIORITY_COLORS = {
  urgent: Colors.danger,
  high: Colors.warn,
  normal: Colors.brand,
  low: Colors.info,
};

/** Durum satırı: nokta + etiket, her yüzeyde aynı biçimde. */
export function statusLine(status) {
  const dot = status === 'open' ? '🟢' : status === 'pending' ? '🟡' : '⚫';
  return `${dot} ${STATUS_LABELS[status] ?? status}`;
}

/**
 * Talep kanalının ilk mesajı — bir kontrol paneli gibi çalışır: talebin
 * kim tarafından, hangi konuda açıldığı ve şu anki durumu tek bakışta okunur.
 * Alanlar sabit sıradadır ki farklı taleplerde göz aynı yerden okusun.
 */
export function buildTicketEmbed(ticket) {
  const t = TICKET_TYPES[ticket.type] ?? TICKET_TYPES.genel;
  const embed = baseEmbed(ticket.status === 'closed'
    ? Colors.neutral
    : PRIORITY_COLORS[ticket.priority] ?? Colors.brand)
    .setTitle(`${t.emoji} #${ticket.id} — ${clean(ticket.subject ?? t.label, 100)}`)
    .setDescription(ticket.description ? clean(ticket.description, 1500) : '_Açıklama girilmemiş._')
    .addFields(
      { name: 'Durum', value: statusLine(ticket.status), inline: true },
      { name: 'Öncelik', value: PRIORITY_LABELS[ticket.priority] ?? ticket.priority, inline: true },
      { name: 'Tür', value: t.label, inline: true },
      { name: 'Açan', value: `<@${ticket.user_id}>`, inline: true },
      {
        name: 'İlgilenen yetkili',
        value: ticket.assignee_id ? `<@${ticket.assignee_id}>` : '_Henüz üstlenilmedi_',
        inline: true,
      },
      { name: 'Açılış', value: trDateTime(ticket.created_at), inline: true },
    );
  if (ticket.reopen_count > 0) {
    embed.addFields({ name: 'Yeniden açılma', value: `${ticket.reopen_count} kez`, inline: true });
  }
  return embed.setFooter(brandFooter(`Talep #${ticket.id}`));
}

/**
 * Talep kontrolleri. Buton stilleri anlam taşır: ana yetkili eylemi Primary,
 * yardımcı eylemler Secondary, yıkıcı (kapatma) eylem Danger.
 */
export function ticketButtonRows(ticket) {
  const staff = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`)
      .setLabel(ticket.assignee_id ? 'Talebi Bırak' : 'Talebi Üstlen').setEmoji('✋')
      .setStyle(ticket.assignee_id ? ButtonStyle.Secondary : ButtonStyle.Primary),
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
    .setPlaceholder('Konu seç ve talebini aç')
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
    return {
      ok: false,
      reason: 'disabled',
      message: 'Destek sistemi şu anda kapalı. Kısa süre sonra tekrar dener veya bir yetkiliye yazabilirsin.',
    };
  }
  return checkOpenAllowed({
    blacklisted: Boolean(ticketBlacklist.get(userId)),
    openCount: ticketsV2.openByUser(userId).length,
    maxOpen: intSetting('ticket_max_open', DEFAULT_MAX_OPEN),
    lastOpenAt: ticketsV2.lastCreatedAt(userId),
    cooldownMinutes: intSetting('ticket_cooldown_minutes', DEFAULT_COOLDOWN_MINUTES),
  });
}

/** Açma engelinin türüne göre doğru tonda kart üretir. */
function gateEmbed(gate) {
  const titles = {
    blacklist: 'Destek Erişimin Kapalı',
    limit: 'Zaten Açık Talebin Var',
    cooldown: 'Biraz Beklemen Gerekiyor',
    disabled: 'Destek Sistemi Kapalı',
  };
  const title = titles[gate.reason] ?? 'Talep Açılamadı';
  return gate.reason === 'blacklist'
    ? errEmbed(gate.message, title)
    : warnEmbed(gate.message, title);
}

async function showCreateModal(interaction, type) {
  const t = TICKET_TYPES[type] ?? TICKET_TYPES.genel;
  const gate = openGate(interaction.user.id);
  if (!gate.ok) {
    return interaction.reply({ embeds: [gateEmbed(gate)], ephemeral: true });
  }
  const modal = new ModalBuilder()
    .setCustomId(`ticket:create:${TICKET_TYPES[type] ? type : 'genel'}`)
    .setTitle(`Destek Talebi — ${t.label}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('konu').setLabel('Konu')
          .setPlaceholder(t.subjectHint ?? 'Örn: Hesabımı bağlayamıyorum')
          .setStyle(TextInputStyle.Short).setMinLength(5).setMaxLength(100).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('aciklama').setLabel('Açıklama')
          .setPlaceholder('Ne oldu, ne zaman oldu, hangi adımları denedin?')
          .setStyle(TextInputStyle.Paragraph).setMinLength(10).setMaxLength(1000).setRequired(true),
      ),
    );
  if (t.extraField) {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('hedef').setLabel(t.extraField)
        .setPlaceholder(t.extraHint ?? 'Örn: Atom veya #124')
        .setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true),
    ));
  }
  return interaction.showModal(modal);
}

async function createTicket(interaction, type) {
  await interaction.deferReply({ ephemeral: true });
  const gate = openGate(interaction.user.id);
  if (!gate.ok) return interaction.editReply({ embeds: [gateEmbed(gate)] });

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
    // Ham Discord API hatası kullanıcıya gösterilmez; yetkili konsolda görür.
    console.error('[ticket] kanal oluşturulamadı:', err.message);
    ticketsV2.close(id, { reason: `kanal oluşturulamadı: ${err.message}` });
    return interaction.editReply({
      embeds: [failureEmbed('Destek kanalın açılamadı. Bir yetkiliye haber verirsen hemen ilgilenilir.')],
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
    allowedMentions: mentionUsers(interaction.user.id),
  });
  await sendLog(interaction.client, {
    title: 'Destek Talebi Açıldı',
    color: Colors.info,
    fields: [
      { name: 'Talep', value: `**#${id}** • ${ticketTypeLabel(type)}`, inline: true },
      { name: 'Açan', value: `${interaction.user}`, inline: true },
      { name: 'Kanal', value: `${channel}`, inline: true },
      { name: 'Konu', value: clean(subject, 200), inline: false },
    ],
  });
  return interaction.editReply({
    embeds: [okEmbed(
      `**#${id}** numaralı talebin oluşturuldu.\nKanal → ${channel}\n\n`
      + 'Bir yetkili en kısa sürede talebini inceleyecek. Ayrıntıları o kanala yazabilirsin.',
      '🎫 Destek Talebi Açıldı',
    )] });
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
    return interaction.reply({
      embeds: [errEmbed('Bu komut yalnızca destek talebi kanallarında çalışır.\n'
        + 'Yeni bir talep açmak için `/destek aç` kullanabilirsin.', 'Destek Kanalı Değil')],
      ephemeral: true,
    });
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
      embeds: [errEmbed('Bir talebi yalnızca onu açan kişi veya yetkililer kapatabilir.', 'Talep Kapatılamaz')],
      ephemeral: true,
    });
  }
  return interaction.reply({
    embeds: [warnEmbed(
      `**#${ticket.id}** kapatılacak: kanal silinecek, konuşma kaydı arşivlenip sana DM olarak gönderilecek.\n`
      + 'Devam etmek için kapatma sebebini soracağım.',
      'Talep Kapatılsın mı?',
    )],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket:closeok:${ticket.id}`)
        .setLabel('Talebi Kapat').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`ticket:closecancel:${ticket.id}`)
        .setLabel('Vazgeç').setStyle(ButtonStyle.Secondary),
    )],
    ephemeral: true,
  });
}

/** Kapanış DM'indeki 1-5 yıldız değerlendirme satırı. */
function ratingRow(ticketId) {
  return new ActionRowBuilder().addComponents(
    [1, 2, 3, 4, 5].map((n) => new ButtonBuilder()
      .setCustomId(`ticket:rate:${ticketId}:${n}`)
      .setLabel(`${n}`)
      .setEmoji('⭐')
      .setStyle(n >= 4 ? ButtonStyle.Success : ButtonStyle.Secondary)),
  );
}

async function performClose(interaction, ticket, reason) {
  const tr = applyTransition(ticket, 'closed');
  if (!tr.ok) {
    return interaction.reply({ embeds: [errEmbed(tr.error, 'Talep Kapatılamadı')], ephemeral: true });
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
        embeds: [baseEmbed(Colors.neutral)
          .setTitle('Destek Talebi Kapatıldı')
          .addFields(
            { name: 'Talep', value: `**#${ticket.id}** • ${ticketTypeLabel(ticket.type)}`, inline: true },
            { name: 'Açan', value: `<@${ticket.user_id}>`, inline: true },
            { name: 'Kapatan', value: `${interaction.user}`, inline: true },
            { name: 'Konu', value: clean(ticket.subject ?? '—', 200), inline: false },
            { name: 'Kapanış sebebi', value: clean(reason, 300), inline: true },
            { name: 'Mesaj sayısı', value: String(rows.length), inline: true },
          )
          .setTimestamp()],
        files: [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: fileName })],
        allowedMentions: { parse: [] },
      }).catch(() => null);
    }
  }

  // 2) Açan kişiye DM: kapanış özeti + transcript + memnuniyet anketi.
  try {
    const opener = await interaction.client.users.fetch(ticket.user_id);
    const dmPayload = {
      embeds: [baseEmbed(Colors.brand)
        .setTitle('🎫 Destek Talebin Kapatıldı')
        .setDescription(`**#${ticket.id}** — ${clean(ticket.subject ?? '—', 150)}`)
        .addFields(
          { name: 'Kapanış sebebi', value: clean(reason, 300), inline: false },
          {
            name: 'Konuşma kaydı',
            value: 'Talebin tam kaydı bu mesajın ekinde. Aynı konu tekrar ederse yeni bir talep açman yeterli.',
            inline: false,
          },
        )
        .setFooter(brandFooter(`Talep #${ticket.id}`))
        .setTimestamp()],
      files: [new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: fileName })],
    };
    if (fresh.satisfaction == null) {
      dmPayload.embeds[0].addFields({
        name: 'Nasıl gitti?',
        value: 'Aldığın desteği 1-5 yıldız arasında puanlayabilirsin.',
      });
      dmPayload.components = [ratingRow(ticket.id)];
    }
    await opener.send(dmPayload);
  } catch {
    /* DM kapalı — transcript log kanalında zaten duruyor */
  }

  await interaction.editReply({
    embeds: [okEmbed(`**#${ticket.id}** kapatıldı ve konuşma kaydı arşivlendi.\n`
      + 'Bu kanal 5 saniye içinde silinecek.', '🔒 Talep Kapatıldı')],
  }).catch(() => null);

  const channel = interaction.channel;
  setTimeout(() => channel?.delete(`Destek talebi #${ticket.id} kapatıldı`).catch(() => null), 5000);
}

/* ------------------------------------------------------------------ */
/* Yeniden açma                                                        */
/* ------------------------------------------------------------------ */

export async function reopenTicket(client, ticketId, actor) {
  const ticket = ticketsV2.get(ticketId);
  if (!ticket) return { ok: false, error: `**#${ticketId}** numaralı bir talep kaydı yok.` };
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
    console.error('[ticket] yeniden açma kanalı oluşturulamadı:', err.message);
    return { ok: false, error: 'Talep kanalı oluşturulamadı. Kategori ayarını ve bot izinlerini kontrol et.' };
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
    allowedMentions: mentionUsers(ticket.user_id),
  });
  addCase('ticket_reopen', ticket.user_id, actor.id, null, `#${ticket.id}`);
  await sendLog(client, {
    title: 'Destek Talebi Yeniden Açıldı',
    color: Colors.warn,
    fields: [
      { name: 'Talep', value: `**#${ticket.id}**`, inline: true },
      { name: 'Açan yetkili', value: `<@${actor.id}>`, inline: true },
      { name: 'Kanal', value: `${channel}`, inline: true },
    ],
  });
  return { ok: true, channel, ticket: fresh };
}

/* ------------------------------------------------------------------ */
/* Kanala kullanıcı ekleme / çıkarma                                   */
/* ------------------------------------------------------------------ */

export async function addUserToTicket(client, ticket, userId) {
  const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel) return { ok: false, error: 'Bu talebin kanalı artık mevcut değil.' };
  await channel.permissionOverwrites.edit(userId, {
    ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true,
  });
  return { ok: true, channel };
}

export async function removeUserFromTicket(client, ticket, userId) {
  if (userId === ticket.user_id) return { ok: false, error: 'Talebi açan kişi kendi kanalından çıkarılamaz.' };
  const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel) return { ok: false, error: 'Bu talebin kanalı artık mevcut değil.' };
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

/** Destek sistemi kapalıyken verilen tek tip yanıt. */
function systemOffEmbed() {
  return warnEmbed('Destek sistemi şu anda kapalı. Kısa süre sonra tekrar dene.', 'Destek Sistemi Kapalı');
}

/** Kapalı/silinmiş bir talebin butonuna basıldığında. */
function inactiveEmbed() {
  return neutralEmbed('Bu talep artık açık değil, üzerinde işlem yapılamıyor.', 'Talep Kapalı');
}

function alreadyClosedEmbed() {
  return neutralEmbed('Bu talep zaten kapatılmış.', 'Talep Kapalı');
}

/** Yetkili gerektiren talep işlemleri için tek tip ret. */
function staffOnlyEmbed(action) {
  return errEmbed(`${action} işlemi **Rehber** ve üzeri yetkililere açıktır.`, 'Yetki Gerekli');
}

export const ticketComponents = {
  'ticket:open': (interaction) => {
    if (!ticketsEnabled()) {
      return interaction.reply({ embeds: [systemOffEmbed()], ephemeral: true });
    }
    return openTicket(interaction);
  },

  'ticket:type': async (interaction) => {
    if (!ticketsEnabled()) {
      return interaction.reply({ embeds: [systemOffEmbed()], ephemeral: true });
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
      return interaction.reply({ embeds: [inactiveEmbed()], ephemeral: true });
    }
    const tier = tierOf(interaction.member);
    if (ticket.assignee_id) {
      // Bırakma: üstlenen kişi veya BMOD+.
      if (interaction.user.id !== ticket.assignee_id && tier < Tier.BMOD) {
        return interaction.reply({
          embeds: [errEmbed('Bir talebi yalnızca onu üstlenen yetkili ya da Baş Mod ve üzeri bırakabilir.',
            'Talep Bırakılamaz')],
          ephemeral: true,
        });
      }
      ticketsV2.unclaim(ticket.id);
      addCase('ticket_unclaim', ticket.user_id, interaction.user.id, null, `#${ticket.id}`);
      const fresh = ticketsV2.get(ticket.id);
      await refreshTicketMessage(interaction, fresh);
      await interaction.channel?.setName(channelNameFor(fresh, interaction.channel.name.split('-').pop() ?? 'uye', false)).catch(() => null);
      return interaction.followUp({
        embeds: [neutralEmbed(`**#${ticket.id}** yeniden sahipsiz. Başka bir yetkili üstlenebilir.`, 'Talep Bırakıldı')],
      }).catch(() => null);
    }
    if (tier < Tier.REHBER) {
      return interaction.reply({ embeds: [staffOnlyEmbed('Talep üstlenme')], ephemeral: true });
    }
    ticketsV2.claim(ticket.id, interaction.user.id);
    ticketsV2.setFirstResponse(ticket.id);
    addCase('ticket_claim', ticket.user_id, interaction.user.id, null, `#${ticket.id}`);
    const fresh = ticketsV2.get(ticket.id);
    await refreshTicketMessage(interaction, fresh);
    await interaction.channel?.setName(channelNameFor(fresh, interaction.channel.name.split('-').pop() ?? 'uye', true)).catch(() => null);
    return interaction.followUp({
      embeds: [okEmbed(`${interaction.user} bu talebi üstlendi ve seninle ilgilenecek.`, '✋ Talep Üstlenildi')],
    }).catch(() => null);
  },

  'ticket:prio': async (interaction) => {
    const ticket = ticketFromId(interaction);
    if (!ticket || ticket.status === 'closed') {
      return interaction.reply({ embeds: [inactiveEmbed()], ephemeral: true });
    }
    if (tierOf(interaction.member) < Tier.REHBER) {
      return interaction.reply({ embeds: [staffOnlyEmbed('Öncelik değiştirme')], ephemeral: true });
    }
    const next = nextPriority(ticket.priority);
    ticketsV2.setPriority(ticket.id, next);
    addCase('ticket_priority', ticket.user_id, interaction.user.id, null, `#${ticket.id} → ${next}`);
    const fresh = ticketsV2.get(ticket.id);
    await refreshTicketMessage(interaction, fresh);
    return interaction.followUp({
      embeds: [okEmbed(`**#${ticket.id}** artık **${PRIORITY_LABELS[next]}** öncelikli.`, '⚡ Öncelik Güncellendi')],
    }).catch(() => null);
  },

  'ticket:hold': async (interaction) => {
    const ticket = ticketFromId(interaction);
    if (!ticket || ticket.status === 'closed') {
      return interaction.reply({ embeds: [inactiveEmbed()], ephemeral: true });
    }
    if (tierOf(interaction.member) < Tier.REHBER) {
      return interaction.reply({ embeds: [staffOnlyEmbed('Bekletme')], ephemeral: true });
    }
    const target = ticket.status === 'pending' ? 'open' : 'pending';
    const tr = applyTransition(ticket, target);
    if (!tr.ok) return interaction.reply({ embeds: [errEmbed(tr.error, 'Durum Değiştirilemedi')], ephemeral: true });
    ticketsV2.setStatus(ticket.id, target);
    addCase('ticket_status', ticket.user_id, interaction.user.id, null, `#${ticket.id} → ${target}`);
    const fresh = ticketsV2.get(ticket.id);
    await refreshTicketMessage(interaction, fresh);
    return interaction.followUp({
      embeds: [target === 'pending'
        ? warnEmbed(`**#${ticket.id}** beklemeye alındı. Yeni bir gelişme olduğunda tekrar aktif edilecek.`,
          '⏸️ Talep Beklemede')
        : okEmbed(`**#${ticket.id}** yeniden aktif — yetkililer talebinle ilgileniyor.`, '▶️ Talep Aktif')],
    }).catch(() => null);
  },

  'ticket:close2': async (interaction) => {
    const ticket = ticketFromId(interaction);
    if (!ticket || ticket.status === 'closed') {
      return interaction.reply({ embeds: [alreadyClosedEmbed()], ephemeral: true });
    }
    return startCloseConfirm(interaction, ticket);
  },

  'ticket:close': (interaction) => closeTicket(interaction),

  'ticket:closeok': async (interaction) => {
    const ticket = ticketFromId(interaction);
    if (!ticket || ticket.status === 'closed') {
      return interaction.reply({ embeds: [alreadyClosedEmbed()], ephemeral: true });
    }
    if (!canClose(interaction, ticket)) {
      return interaction.reply({
        embeds: [errEmbed('Bir talebi yalnızca onu açan kişi veya yetkililer kapatabilir.', 'Talep Kapatılamaz')],
        ephemeral: true,
      });
    }
    const modal = new ModalBuilder()
      .setCustomId(`ticket:closemodal:${ticket.id}`)
      .setTitle(`Talep #${ticket.id} Kapatma`.slice(0, 45))
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('sebep').setLabel('Kapatma sebebi')
          .setPlaceholder('Örn: Sorun çözüldü')
          .setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(300).setRequired(true),
      ));
    return interaction.showModal(modal);
  },

  'ticket:closecancel': (interaction) => interaction.update({
    embeds: [neutralEmbed('Talep açık kalmaya devam ediyor.', 'Kapatma İptal Edildi')],
    components: [],
  }),

  'ticket:closemodal': async (interaction) => {
    const ticket = ticketFromId(interaction);
    if (!ticket || ticket.status === 'closed') {
      return interaction.reply({ embeds: [alreadyClosedEmbed()], ephemeral: true });
    }
    if (!canClose(interaction, ticket)) {
      return interaction.reply({
        embeds: [errEmbed('Bir talebi yalnızca onu açan kişi veya yetkililer kapatabilir.', 'Talep Kapatılamaz')],
        ephemeral: true,
      });
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
      return interaction.reply({
        embeds: [neutralEmbed('Bu değerlendirme artık geçerli değil.', 'Değerlendirme Kapandı')], ephemeral: true,
      });
    }
    if (ticket.user_id !== interaction.user.id) {
      return interaction.reply({
        embeds: [errEmbed('Bu değerlendirme başka bir kullanıcının talebine ait.', 'Bu Buton Sana Ait Değil')],
        ephemeral: true,
      });
    }
    if (!ticketsV2.rate(id, score)) {
      return interaction.reply({
        embeds: [neutralEmbed('Bu talebi zaten puanlamıştın. Teşekkürler!', 'Değerlendirme Alınmış')], ephemeral: true,
      });
    }
    addCase('ticket_rate', ticket.user_id, ticket.user_id, null, `#${id} → ${score}/5`);
    await sendLog(interaction.client, {
      title: 'Destek Değerlendirmesi',
      color: Colors.success,
      fields: [
        { name: 'Talep', value: `**#${id}**`, inline: true },
        { name: 'Puan', value: `${score}/5 ${'⭐'.repeat(score)}`, inline: true },
        { name: 'Değerlendiren', value: `<@${ticket.user_id}>`, inline: true },
      ],
    });
    return interaction.update({
      embeds: [okEmbed(`**#${id}** için puanın: **${score}/5** ${'⭐'.repeat(score)}\nGeri bildirimin için teşekkürler.`,
        '⭐ Değerlendirmen Kaydedildi')],
      components: [],
    }).catch(() => interaction.reply({
      embeds: [okEmbed(`Puanın kaydedildi: **${score}/5**`, '⭐ Değerlendirmen Kaydedildi')], ephemeral: true,
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
        title: 'Talep Otomatik Kapatıldı',
        color: Colors.warn,
        description: `**#${id}** talebinin kanalı elle silinmiş; kayıt kapalıya çekildi.`,
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
        title: 'Destek SLA Uyarısı',
        color: Colors.danger,
        description: 'Bu talep hedef sürede yanıtlanmadı ve hâlâ sahipsiz.',
        fields: [
          { name: 'Talep', value: `**#${ticket.id}** • ${PRIORITY_LABELS[ticket.priority]}`, inline: true },
          { name: 'Açan', value: `<@${ticket.user_id}>`, inline: true },
          { name: 'Kanal', value: `<#${ticket.channel_id}>`, inline: true },
          { name: 'Hedef', value: `${slaState(ticket, now, overrides).targetMinutes} dk`, inline: true },
        ],
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
              .setTitle('⏳ Bu Talepte 48 Saattir Hareket Yok')
              .setDescription('Sorunun çözüldüyse **Talebi Kapat** butonunu kullanabilirsin.\n'
                + 'Hâlâ yardıma ihtiyacın varsa buraya bir mesaj yazman yeterli.')],
            allowedMentions: mentionUsers(ticket.user_id),
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
