import { randomUUID } from 'node:crypto';
import { getSetting, setSetting } from './db.js';
import { createMessageDraft, validateDraft } from './messagecore.js';

const key = (guildId, ownerId) => `message_templates:${guildId}:${ownerId}`;
function list(guildId, ownerId) {
  const templates = JSON.parse(getSetting(key(guildId, ownerId), '[]'));
  if (!Array.isArray(templates) || templates.length > 5) throw new Error('Şablon kayıtları okunamadı.');
  return templates;
}
export const messageTemplates = {
  list,
  save(guildId, ownerId, name, source) {
    name = String(name).trim();
    if (!name || name.length > 60) throw new Error('Şablon adı 1–60 karakter olmalı.');
    const draft = createMessageDraft(source); validateDraft(draft);
    const templates = list(guildId, ownerId);
    const index = templates.findIndex(t => t.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr'));
    if (index < 0 && templates.length === 5) throw new Error('En fazla 5 şablon kaydedebilirsin. Önce bir şablonu sil.');
    const template = { id: index >= 0 ? templates[index].id : randomUUID(), name, draft, updatedAt: Date.now() };
    if (index >= 0) templates[index] = template; else templates.push(template);
    setSetting(key(guildId, ownerId), JSON.stringify(templates));
    return template;
  },
  remove(guildId, ownerId, id) {
    const templates = list(guildId, ownerId);
    const remaining = templates.filter(t => t.id !== id);
    if (remaining.length === templates.length) return false;
    setSetting(key(guildId, ownerId), JSON.stringify(remaining)); return true;
  },
};
