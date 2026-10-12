/** Discord message data shared by previews, tests and actual deliveries. */
export function createMessageDraft(initial = {}) {
  return {
    mode: initial.mode === 'text' ? 'text' : 'embed', content: String(initial.content ?? ''),
    embed: { title: '', description: 'Merhaba %etiket%!', color: '#00B3B3',
      url: '', image: '', thumbnail: '', author: { name: '', iconURL: '', url: '' },
      footer: { text: '', iconURL: '' }, timestamp: false, fields: [], ...initial.embed,
      author: { name: '', iconURL: '', url: '', ...initial.embed?.author },
      footer: { text: '', iconURL: '', ...initial.embed?.footer },
      fields: structuredClone(initial.embed?.fields ?? []),
    }, buttons: structuredClone(initial.buttons ?? []),
  };
}

function limit(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new Error(`${label}: ${required ? '1–' : '0–'}${max} karakter kullan.`);
  }
}

export function validateMessageURL(value, label = 'Bağlantı') {
  if (!value) return;
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label}: geçerli bir HTTP/HTTPS bağlantısı gir.`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || value.length > 2048) {
    throw new Error(`${label}: kimlik bilgisi içermeyen HTTP/HTTPS bağlantısı gir (en fazla 2048 karakter).`);
  }
}

export function validateDraft(draft) {
  if (!['text', 'embed'].includes(draft.mode)) throw new Error('Mesaj biçimi geçersiz.');
  limit(draft.content, 2000, 'Özel metin', draft.mode === 'text');
  if (!Array.isArray(draft.buttons) || draft.buttons.length > 5) throw new Error('En fazla 5 bağlantı butonu eklenebilir.');
  for (const b of draft.buttons) {
    limit(b.label, 80, 'Buton yazısı', true);
    if (!b.url) throw new Error('Buton bağlantısı boş olamaz.');
    validateMessageURL(b.url, 'Buton bağlantısı');
    if (b.emoji) limit(b.emoji, 100, 'Buton emojisi');
  }
  if (draft.mode === 'text') return draft;
  const e = draft.embed;
  limit(e.title, 256, 'Başlık'); limit(e.description, 4096, 'Açıklama');
  const color = typeof e.color === 'number' ? e.color : /^#?[\da-f]{6}$/i.test(e.color) ? parseInt(e.color.replace('#', ''), 16) : NaN;
  if (!Number.isInteger(color) || color < 0 || color > 0xffffff) throw new Error('Renk: #00B3B3 gibi 6 haneli HEX renk gir.');
  for (const [v, name] of [[e.url, 'Başlık bağlantısı'], [e.image, 'Resim'], [e.thumbnail, 'Küçük resim'],
    [e.author.iconURL, 'Yazar ikonu'], [e.author.url, 'Yazar bağlantısı'], [e.footer.iconURL, 'Alt yazı ikonu']]) validateMessageURL(v, name);
  limit(e.author.name, 256, 'Yazar'); limit(e.footer.text, 2048, 'Alt yazı');
  if ((e.author.iconURL || e.author.url) && !e.author.name) throw new Error('Yazar ikonunu/bağlantısını kullanmak için yazar adı gir.');
  if (e.footer.iconURL && !e.footer.text) throw new Error('Alt yazı ikonunu kullanmak için alt yazı gir.');
  if (!Array.isArray(e.fields) || e.fields.length > 25) throw new Error('En fazla 25 embed alanı eklenebilir.');
  let length = e.title.length + e.description.length + e.author.name.length + e.footer.text.length;
  for (const f of e.fields) {
    limit(f.name, 256, 'Alan başlığı', true); limit(f.value, 1024, 'Alan içeriği', true);
    length += f.name.length + f.value.length;
  }
  if (length > 6000) throw new Error('Embed metinlerinin toplamı en fazla 6000 karakter olabilir.');
  if (!length && !e.image && !e.thumbnail) throw new Error('Embed için başlık, açıklama, alan veya görsel ekle.');
  return draft;
}

function replace(value, user, context) {
  const values = {
    '%etiket%': `<@${user.id}>`, '%kullanici%': user.username ?? user.displayName ?? user.id,
    '%sunucu%': context.guildName ?? 'Nautilus',
    '%tarih%': new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Istanbul' }).format(context.now ?? Date.now()),
  };
  return value.replace(/%etiket%|%kullanici%|%sunucu%|%tarih%/g, key => values[key]);
}

function buttonEmoji(emoji) {
  const custom = /^<(a?):([\w]+):(\d+)>$/.exec(emoji);
  return custom ? { id: custom[3], name: custom[2], animated: custom[1] === 'a' } : { name: emoji };
}

export function renderMessage(source, recipient, context = {}) {
  validateDraft(source);
  const d = createMessageDraft(source);
  const sub = value => replace(value, recipient, context);
  d.content = sub(d.content);
  d.buttons = d.buttons.map(b => ({ ...b, label: sub(b.label) }));
  for (const key of ['title', 'description']) d.embed[key] = sub(d.embed[key]);
  d.embed.author.name = sub(d.embed.author.name); d.embed.footer.text = sub(d.embed.footer.text);
  d.embed.fields = d.embed.fields.map(f => ({ name: sub(f.name), value: sub(f.value), inline: !!f.inline }));
  validateDraft(d);
  const embeds = [];
  if (d.mode === 'embed') {
    const e = d.embed;
    const embed = { color: typeof e.color === 'number' ? e.color : parseInt(e.color.replace('#', ''), 16) };
    for (const key of ['title', 'description', 'url']) if (e[key]) embed[key] = e[key];
    for (const key of ['image', 'thumbnail']) if (e[key]) embed[key] = { url: e[key] };
    if (e.author.name) embed.author = { name: e.author.name, ...(e.author.iconURL ? { icon_url: e.author.iconURL } : {}), ...(e.author.url ? { url: e.author.url } : {}) };
    if (e.footer.text) embed.footer = { text: e.footer.text, ...(e.footer.iconURL ? { icon_url: e.footer.iconURL } : {}) };
    if (e.timestamp) embed.timestamp = new Date(context.now ?? Date.now()).toISOString();
    if (e.fields.length) embed.fields = e.fields;
    embeds.push(embed);
  }
  return {
    ...(d.content ? { content: d.content } : {}), embeds,
    components: d.buttons.length ? [{ type: 1, components: d.buttons.map(b => ({ type: 2, style: 5, label: b.label, url: b.url, ...(b.emoji ? { emoji: buttonEmoji(b.emoji) } : {}) })) }] : [],
    allowedMentions: { parse: [], users: [recipient.id], repliedUser: false },
  };
}
