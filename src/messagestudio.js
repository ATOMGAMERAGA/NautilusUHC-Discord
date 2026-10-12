import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  UserSelectMenuBuilder, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} from 'discord.js';
import { Tier, hasTier } from './permissions.js';
import { baseEmbed, Colors, errEmbed } from './embeds.js';
import { addCase } from './db.js';
import { createMessageDraft, renderMessage, validateDraft } from './messagecore.js';
import { messageTemplates } from './messagetemplates.js';
import { resolveRecipients, deliverMessage } from './messagedelivery.js';

const sessions = new Map();
const TTL = 30 * 60_000;
const nonce = () => randomBytes(12).toString('base64url');
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const privateError = error => ({ embeds: [errEmbed(error.message, 'Mesaj Düzenleyici')], flags: MessageFlags.Ephemeral });

export function createStudioSession({ ownerId, guildId, kind = 'dm', test = false, draft, channelId, now = Date.now() }) {
  for (const [id, s] of sessions) if (s.expiresAt <= now && !s.sending) sessions.delete(id);
  if (sessions.size >= 100) throw new Error('Açık panel sınırına ulaşıldı. Eski bir paneli kapat.');
  const session = { id: nonce(), ownerId, guildId, kind, test: !!test,
    draft: createMessageDraft(draft), target: { kind: 'self' }, channelId,
    expiresAt: now + TTL, version: 0, pending: null, sending: false };
  sessions.set(session.id, session); return session;
}

export function getStudioSession(id, userId, guildId, { now = Date.now() } = {}) {
  const s = sessions.get(id);
  if (!s || s.expiresAt <= now) throw new Error('Panelin süresi doldu. Komutu yeniden çalıştır.');
  if (s.ownerId !== userId) throw new Error('Bu panel sana ait değil. Komutu kendin çalıştır.');
  if (s.guildId !== guildId) throw new Error('Bu panel başka bir sunucuya ait.');
  return s;
}

function touch(s) { s.version++; s.pending = null; s.expiresAt = Date.now() + TTL; }
const idFor = (s, action) => `studio:${s.id}:${action}`;
function button(s, action, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(idFor(s, action)).setLabel(label).setStyle(style);
}

function audienceLabel(s) {
  if (s.test) return 'Test modu • bütün gönderimler yalnız sana';
  if (s.kind === 'channel') return s.channelId ? `<#${s.channelId}>` : 'Kanal seç';
  return { self: 'Yalnız kendim', all: 'Sunucudaki bütün insan üyeler', subscribers: 'Maç bildirimi aboneleri',
    users: `Seçilen üyeler (${s.target.userIds?.length ?? 0})`, role: s.target.roleId ? `<@&${s.target.roleId}> rolü` : 'Rol seç' }[s.target.kind];
}

function templateMenu(s, deleting = false) {
  const templates = messageTemplates.list(s.guildId, s.ownerId);
  return row(new StringSelectMenuBuilder().setCustomId(idFor(s, deleting ? 'template_delete' : 'template_load'))
    .setPlaceholder(deleting ? 'Silinecek şablonu seç' : `Kişisel şablonlar (${templates.length}/5)`)
    .setDisabled(!templates.length).addOptions(templates.length ? templates.map(t => ({ label: t.name, value: t.id }))
      : [{ label: 'Henüz şablon kaydetmedin', value: 'empty' }]));
}

function panel(s, note = '') {
  const e = s.draft.embed;
  const description = [note, `**Biçim:** ${s.draft.mode === 'text' ? 'Düz metin' : 'Embed + isteğe bağlı özel metin'}`,
    `**Hedef:** ${audienceLabel(s)}`, `**Alanlar / butonlar:** ${e.fields.length}/25 · ${s.draft.buttons.length}/5`,
    '', 'Menüden metni, görünümü ve butonları düzenle. **Önizle** içeriği yalnız sana gösterir.',
    '**Kendime test** aynı içeriği yalnız senin DM’ine gönderir.',
    '`%etiket%` alıcıyı etiketler · `%kullanici%` adı · `%sunucu%` sunucu · `%tarih%` Türkiye tarihi',
    'Şablon adı aynıysa kaydetme mevcut şablonu günceller. Şablonlar hedef ve test modunu değiştirmez.',
  ].filter(Boolean).join('\n');
  const edit = new StringSelectMenuBuilder().setCustomId(idFor(s, 'edit')).setPlaceholder('Mesajını özelleştir')
    .addOptions([
      ['basic', 'Metin, başlık ve açıklama'], ['mode', 'Düz metin / embed değiştir'],
      ['appearance', 'Renk, görseller ve başlık bağlantısı'], ['author', 'Yazar bilgisi'],
      ['footer', 'Alt yazı ve ikonu'], ['timestamp', 'Zaman damgasını aç / kapat'],
      ['field', 'Embed alanı ekle / düzenle'], ['field_delete', 'Embed alanı sil'],
      ['button', 'Bağlantı butonu ekle / düzenle'], ['button_delete', 'Bağlantı butonu sil'],
      ['template_delete_menu', 'Kişisel şablon sil'], ['reset', 'İçeriği sıfırla'],
    ].map(([value, label]) => ({ value, label })));
  const components = [row(edit), templateMenu(s)];
  if (s.kind === 'dm') {
    components.push(row(new StringSelectMenuBuilder().setCustomId(idFor(s, 'audience')).setPlaceholder('DM alıcılarını seç')
      .addOptions([
        ['self', 'Yalnız kendim'], ['users', 'Belirli üyeler'], ['role', 'Bir roldeki üyeler'],
        ['subscribers', 'Maç bildirimi aboneleri'], ['all', 'Bütün insan üyeler'],
      ].map(([value, label]) => ({ value, label, default: value === s.target.kind })))));
    if (s.target.kind === 'users') components.push(row(new UserSelectMenuBuilder()
      .setCustomId(idFor(s, 'target_users')).setPlaceholder('En fazla 25 üye seç').setMinValues(1).setMaxValues(25)));
    if (s.target.kind === 'role') components.push(row(new RoleSelectMenuBuilder()
      .setCustomId(idFor(s, 'target_role')).setPlaceholder('DM gönderilecek rolü seç').setMinValues(1).setMaxValues(1)));
  } else {
    components.push(row(new ChannelSelectMenuBuilder().setCustomId(idFor(s, 'target_channel'))
      .setPlaceholder('Gönderim kanalı').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)));
  }
  components.push(row(button(s, 'preview', 'Önizle'), button(s, 'test', 'Kendime test', ButtonStyle.Primary),
    button(s, 'save', 'Şablon kaydet'), button(s, 'send', s.test ? 'Test gönder' : 'Gönder', ButtonStyle.Success),
    button(s, 'close', 'Kapat', ButtonStyle.Danger)));
  return { embeds: [baseEmbed(Colors.brand).setTitle(s.kind === 'dm' ? '✉️ Özel DM Düzenleyici' : '🎨 Mesaj ve Embed Düzenleyici')
    .setDescription(description)], components, allowedMentions: { parse: [] } };
}

export async function openMessageStudio(interaction, options = {}) {
  const s = createStudioSession({ ownerId: interaction.user.id, guildId: interaction.guildId ?? interaction.guild.id,
    channelId: interaction.channelId, ...options });
  await interaction.reply({ ...panel(s), flags: MessageFlags.Ephemeral }); return s;
}

function modal(s, action, title, fields) {
  const m = new ModalBuilder().setCustomId(idFor(s, `modal:${action}`)).setTitle(title);
  for (const f of fields) {
    const input = new TextInputBuilder().setCustomId(f.id).setLabel(f.label).setRequired(!!f.required)
      .setStyle(f.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short).setMaxLength(f.max ?? 4000);
    if (f.value) input.setValue(String(f.value));
    if (f.placeholder) input.setPlaceholder(f.placeholder);
    m.addComponents(row(input));
  }
  return m;
}

function editorModal(s, action, index) {
  const d = s.draft; const e = d.embed;
  const field = Number.isInteger(index) ? e.fields[index] : undefined;
  const link = Number.isInteger(index) ? d.buttons[index] : undefined;
  const definitions = {
    basic: ['Metin ve Embed İçeriği', [
      { id: 'content', label: 'Özel metin (embed dışında / düz mesaj)', value: d.content, max: 2000, paragraph: true },
      { id: 'title', label: 'Embed başlığı', value: e.title, max: 256 },
      { id: 'description', label: 'Embed açıklaması (satır sonu destekli)', value: e.description, paragraph: true, max: 4000 },
    ]],
    appearance: ['Renk ve Görseller', [
      { id: 'color', label: 'HEX renk', value: e.color, required: true, max: 7 },
      { id: 'image', label: 'Büyük resim URL (boş = kaldır)', value: e.image, max: 2048 },
      { id: 'thumbnail', label: 'Küçük resim URL (boş = kaldır)', value: e.thumbnail, max: 2048 },
      { id: 'url', label: 'Başlığa tıklanınca açılacak URL', value: e.url, max: 2048 },
    ]],
    author: ['Yazar Bilgisi', [
      { id: 'name', label: 'Yazar adı', value: e.author.name, max: 256 },
      { id: 'icon', label: 'Yazar ikonu URL', value: e.author.iconURL, max: 2048 },
      { id: 'url', label: 'Yazar bağlantısı URL', value: e.author.url, max: 2048 },
    ]],
    footer: ['Alt Yazı', [
      { id: 'text', label: 'Alt yazı', value: e.footer.text, max: 2048, paragraph: true },
      { id: 'icon', label: 'Alt yazı ikonu URL', value: e.footer.iconURL, max: 2048 },
    ]],
    field: ['Embed Alanı', [
      { id: 'slot', label: `Sıra (1–${Math.min(25, e.fields.length + 1)})`, required: true, max: 2, value: String((index ?? e.fields.length) + 1) },
      { id: 'name', label: 'Alan başlığı', required: true, max: 256, value: field?.name },
      { id: 'value', label: 'Alan içeriği', required: true, max: 1024, paragraph: true, value: field?.value },
      { id: 'inline', label: 'Yan yana göster? evet / hayır', max: 5, value: field?.inline ? 'evet' : 'hayır' },
    ]],
    button: ['Bağlantı Butonu', [
      { id: 'slot', label: `Sıra (1–${Math.min(5, d.buttons.length + 1)})`, required: true, max: 1, value: String((index ?? d.buttons.length) + 1) },
      { id: 'label', label: 'Buton yazısı', required: true, max: 80, value: link?.label },
      { id: 'url', label: 'Tıklanınca açılacak URL', required: true, max: 2048, value: link?.url },
      { id: 'emoji', label: 'Emoji (isteğe bağlı)', max: 100, value: link?.emoji },
    ]],
    save: ['Kişisel Şablon Kaydet', [
      { id: 'name', label: 'Şablon adı (aynı ad = güncelle)', required: true, max: 60 },
    ]],
  };
  const definition = definitions[action];
  if (!definition) throw new Error('Düzenleme seçeneği geçersiz.');
  return modal(s, action, ...definition);
}

function applyModal(s, action, fields) {
  const get = key => fields.getTextInputValue(key).replace(/\\n/g, '\n').trim();
  if (action === 'save') {
    const saved = messageTemplates.save(s.guildId, s.ownerId, get('name'), s.draft);
    return `**${saved.name.replace(/[\*_`]/g, '')}** kaydedildi.`;
  }
  const d = createMessageDraft(s.draft); const e = d.embed;
  switch (action) {
    case 'basic': d.content = get('content'); e.title = get('title'); e.description = get('description'); break;
    case 'appearance': e.color = get('color'); e.image = get('image'); e.thumbnail = get('thumbnail'); e.url = get('url'); break;
    case 'author': e.author = { name: get('name'), iconURL: get('icon'), url: get('url') }; break;
    case 'footer': e.footer = { text: get('text'), iconURL: get('icon') }; break;
    case 'field':
    case 'button': {
      const list = action === 'field' ? e.fields : d.buttons;
      const max = action === 'field' ? 25 : 5;
      const raw = get('slot'); const index = Number(raw) - 1;
      if (!/^\d+$/.test(raw) || index < 0 || index >= max || index > list.length) throw new Error(`Sıra 1–${Math.min(max, list.length + 1)} arasında olmalı.`);
      const value = action === 'field' ? { name: get('name'), value: get('value'), inline: /^(evet|e|true|1)$/i.test(get('inline')) }
        : { label: get('label'), url: get('url'), emoji: get('emoji') };
      if (index === list.length) list.push(value); else list[index] = value;
      break;
    }
    default: throw new Error('Form geçersiz.');
  }
  validateDraft(d); s.draft = d; touch(s); return 'Değişiklikler kaydedildi. Önizleme veya DM testi yapabilirsin.';
}

export async function prepareStudioSend(s, interaction, { now = Date.now() } = {}) {
  getStudioSession(s.id, interaction.user.id, interaction.guildId ?? interaction.guild.id);
  if (s.sending) throw new Error('Gönderim zaten devam ediyor.');
  const version = s.version;
  const draft = createMessageDraft(s.draft);
  validateDraft(draft);
  renderMessage(draft, interaction.user, { guildName: interaction.guild.name, now });
  const recipientIds = s.test ? [s.ownerId] : s.kind === 'dm'
    ? await resolveRecipients(interaction.guild, s.target, s.ownerId) : [];
  if (s.kind === 'dm' && !recipientIds.length) throw new Error('Bu hedefte mesaj gönderilebilecek üye yok.');
  if (s.kind === 'channel' && !s.test && !s.channelId) throw new Error('Gönderim kanalı seç.');
  if (s.version !== version) throw new Error('Alıcılar hazırlanırken taslak değişti. Gönderimi yeniden başlat.');
  const pending = { token: nonce(), version, expiresAt: now + 120_000,
    draft, recipientIds, channelId: s.channelId };
  s.pending = pending; return pending;
}

export async function confirmStudioSend(s, token, interaction, { now = Date.now() } = {}) {
  getStudioSession(s.id, interaction.user.id, interaction.guildId ?? interaction.guild.id);
  const p = s.pending;
  if (s.sending || !p || p.token !== token || p.version !== s.version) throw new Error('Bu gönderim onayı artık geçerli değil.');
  if (p.expiresAt <= now) { s.pending = null; throw new Error('Gönderim onayının süresi doldu.'); }
  s.pending = null; s.sending = true;
  try {
    let result;
    if (s.kind === 'channel' && !s.test) {
      const channel = await interaction.guild.channels.fetch(p.channelId);
      if (!channel || channel.guildId !== s.guildId || !channel.isTextBased()) throw new Error('Gönderim kanalı artık kullanılamıyor.');
      await channel.send(renderMessage(p.draft, interaction.user, { guildName: interaction.guild.name, now }));
      result = { sent: 1, failed: 0, total: 1 };
    } else result = await deliverMessage({ client: interaction.client, guild: interaction.guild, ownerId: s.ownerId,
      draft: p.draft, target: s.target, test: s.test, recipientIds: p.recipientIds });
    addCase(s.test ? 'message_studio_test' : s.kind === 'dm' ? 'admin_dm' : 'embed', null, s.ownerId, null,
      `${result.sent} başarılı / ${result.failed} hata / ${result.total} hedef`);
    return result;
  } finally { s.sending = false; }
}

async function deleteMenu(interaction, s, action) {
  if (action === 'template_delete_menu') return interaction.update({ ...panel(s, 'Silmek istediğin kişisel şablonu aşağıdan seç.'),
    components: [templateMenu(s, true), row(button(s, 'back', 'Düzenleyiciye dön'))] });
  const list = action === 'field_delete' ? s.draft.embed.fields : s.draft.buttons;
  if (!list.length) return interaction.update(panel(s, 'Silinecek öğe yok.'));
  const menu = new StringSelectMenuBuilder().setCustomId(idFor(s, action)).setPlaceholder('Silinecek öğeyi seç')
    .addOptions(list.map((item, index) => ({ label: `${index + 1}. ${item.name ?? item.label}`.slice(0, 100), value: String(index) })));
  return interaction.update({ embeds: panel(s).embeds, components: [row(menu), row(button(s, 'back', 'Düzenleyiciye dön'))], allowedMentions: { parse: [] } });
}

export async function handleMessageStudio(interaction) {
  try {
    if (!hasTier(interaction.member, Tier.ADMIN)) throw new Error('Bu panel için admin yetkisi gerekiyor.');
    const [, sessionId, action, detail] = interaction.customId.split(':');
    const s = getStudioSession(sessionId, interaction.user.id, interaction.guildId ?? interaction.guild?.id);
    if (s.sending) throw new Error('Gönderim devam ediyor; bitmesini bekle.');
    if (action === 'close') {
      sessions.delete(s.id);
      return interaction.update({ embeds: [baseEmbed(Colors.neutral).setDescription('Mesaj paneli kapatıldı.')], components: [] });
    }
    if (action === 'preview') return interaction.reply({ ...renderMessage(s.draft, interaction.user, { guildName: interaction.guild.name }), flags: MessageFlags.Ephemeral });
    if (action === 'test') {
      s.sending = true;
      try {
        await interaction.deferUpdate();
        const result = await deliverMessage({ client: interaction.client, guild: interaction.guild, ownerId: s.ownerId,
          draft: createMessageDraft(s.draft), test: true });
        return interaction.editReply(panel(s, result.sent ? 'Test mesajı yalnız senin DM’ine gönderildi.' : 'DM testi başarısız. Sunucudan gelen özel mesajlara izin verdiğini kontrol et.'));
      } finally { s.sending = false; }
    }
    if (action === 'send') {
      await interaction.deferUpdate();
      const p = await prepareStudioSend(s, interaction);
      return interaction.editReply({ embeds: [baseEmbed(Colors.warn).setTitle('Gönderimi Onayla')
        .setDescription(`**Hedef:** ${audienceLabel(s)}\n**Teslimat sayısı:** ${s.kind === 'channel' && !s.test ? 1 : p.recipientIds.length}\n`
          + `**Biçim:** ${s.draft.mode === 'text' ? 'Düz metin' : 'Embed'}\n\nİçerik ve hedefler sabitlendi. Onay 2 dakika geçerli.`)],
        components: [row(button(s, `confirm:${p.token}`, s.test ? 'Yalnız bana gönder' : 'Gönderimi onayla', ButtonStyle.Success),
          button(s, 'back', 'Düzenlemeye dön'))], allowedMentions: { parse: [] } });
    }
    if (action === 'confirm') {
      await interaction.deferUpdate();
      const result = await confirmStudioSend(s, detail, interaction);
      return interaction.editReply(panel(s, `Gönderim tamamlandı: **${result.sent} başarılı**, **${result.failed} başarısız**.`));
    }
    if (action === 'back') { s.pending = null; return interaction.update(panel(s)); }
    if (action === 'save') return interaction.showModal(editorModal(s, 'save'));
    if (action === 'field_edit' || action === 'button_edit') {
      const index = Number(interaction.values[0]);
      const list = action === 'field_edit' ? s.draft.embed.fields : s.draft.buttons;
      const max = action === 'field_edit' ? 25 : 5;
      if (!Number.isInteger(index) || index < 0 || index > list.length || index >= max) throw new Error('Düzenlenecek öğe bulunamadı.');
      return interaction.showModal(editorModal(s, action === 'field_edit' ? 'field' : 'button', index));
    }
    if (action === 'modal') return interaction.update(panel(s, applyModal(s, detail, interaction.fields)));
    if (action === 'template_load') {
      const template = messageTemplates.list(s.guildId, s.ownerId).find(t => t.id === interaction.values[0]);
      if (!template) throw new Error('Şablon bulunamadı.');
      const draft = createMessageDraft(template.draft); validateDraft(draft); s.draft = draft; touch(s);
      return interaction.update(panel(s, 'Şablon yüklendi. Hedef ve test modu korundu.'));
    }
    if (action === 'template_delete') {
      const templateId = interaction.values[0];
      const template = messageTemplates.list(s.guildId, s.ownerId).find(t => t.id === templateId);
      if (!template) throw new Error('Şablon bulunamadı.');
      return interaction.update({ embeds: [baseEmbed(Colors.warn).setTitle('Şablonu Sil')
        .setDescription(`**${template.name.replace(/[\*_`]/g, '')}** kişisel şablonunu silmek istiyor musun?`)],
        components: [row(button(s, `delete_confirm:${templateId}`, 'Şablonu sil', ButtonStyle.Danger), button(s, 'back', 'Vazgeç'))], allowedMentions: { parse: [] } });
    }
    if (action === 'delete_confirm') {
      messageTemplates.remove(s.guildId, s.ownerId, detail); return interaction.update(panel(s, 'Şablon silindi.'));
    }
    if (action === 'audience') { s.target = { kind: interaction.values[0] }; touch(s); return interaction.update(panel(s)); }
    if (action === 'target_users') { s.target = { kind: 'users', userIds: interaction.values.slice(0, 25) }; touch(s); return interaction.update(panel(s)); }
    if (action === 'target_role') { s.target = { kind: 'role', roleId: interaction.values[0] }; touch(s); return interaction.update(panel(s)); }
    if (action === 'target_channel') { s.channelId = interaction.values[0]; touch(s); return interaction.update(panel(s)); }
    if (action === 'field_delete' || action === 'button_delete') {
      const list = action === 'field_delete' ? s.draft.embed.fields : s.draft.buttons;
      const index = Number(interaction.values[0]);
      if (!Number.isInteger(index) || index < 0 || index >= list.length) throw new Error('Silinecek öğe bulunamadı.');
      list.splice(index, 1); touch(s); return interaction.update(panel(s, 'Öğe silindi.'));
    }
    if (action === 'edit') {
      const choice = interaction.values[0];
      if (['field_delete', 'button_delete', 'template_delete_menu'].includes(choice)) return deleteMenu(interaction, s, choice);
      if (choice === 'field' || choice === 'button') {
        const list = choice === 'field' ? s.draft.embed.fields : s.draft.buttons;
        const max = choice === 'field' ? 25 : 5;
        if (!list.length) return interaction.showModal(editorModal(s, choice));
        const options = list.map((item, index) => ({ label: `${index + 1}. ${item.name ?? item.label}`.slice(0, 100), value: String(index) }));
        if (list.length < max) options.push({ label: 'Yeni öğe ekle', value: String(list.length) });
        return interaction.update({ embeds: panel(s).embeds,
          components: [row(new StringSelectMenuBuilder().setCustomId(idFor(s, `${choice}_edit`)).setPlaceholder('Düzenlenecek öğeyi seç').addOptions(options)),
            row(button(s, 'back', 'Düzenleyiciye dön'))], allowedMentions: { parse: [] } });
      }
      if (choice === 'mode') {
        s.draft.mode = s.draft.mode === 'embed' ? 'text' : 'embed';
        if (s.draft.mode === 'text' && !s.draft.content) s.draft.content = s.draft.embed.description || 'Merhaba %etiket%!';
        touch(s); return interaction.update(panel(s));
      }
      if (choice === 'timestamp') { s.draft.embed.timestamp = !s.draft.embed.timestamp; touch(s); return interaction.update(panel(s)); }
      if (choice === 'reset') { s.draft = createMessageDraft(); touch(s); return interaction.update(panel(s, 'Mesaj içeriği sıfırlandı.')); }
      return interaction.showModal(editorModal(s, choice));
    }
    throw new Error('Panel işlemi geçersiz.');
  } catch (error) {
    if (interaction.deferred || interaction.replied) return interaction.followUp(privateError(error));
    return interaction.reply(privateError(error));
  }
}
