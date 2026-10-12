import { setTimeout as delay } from 'node:timers/promises';
import { dmSubscriptions } from './db.js';
import { renderMessage, validateDraft } from './messagecore.js';

export async function resolveRecipients(guild, target, ownerId) {
  if (target.kind === 'self') return [ownerId];
  if (!['all', 'role', 'users', 'subscribers'].includes(target.kind)) throw new Error('DM hedefi seç.');
  if (target.kind === 'users' && !target.userIds?.length) throw new Error('En az bir üye seç.');
  if (target.kind === 'role' && !target.roleId) throw new Error('Bir rol seç.');
  // Fetch the complete roster; never silently broadcast to an incomplete cache.
  const members = await guild.members.fetch();
  const selected = new Set(target.kind === 'subscribers' ? dmSubscriptions.enabledUserIds() : target.userIds ?? []);
  return [...members.values()].filter(m => !m.user.bot && (target.kind === 'all'
    || (target.kind === 'role' ? m.roles.cache.has(target.roleId) : selected.has(m.id))))
    .map(m => m.id).filter((id, index, all) => all.indexOf(id) === index);
}

export async function deliverMessage({ client, guild, ownerId, draft, target, test = false, recipientIds, wait = delay, onProgress }) {
  validateDraft(draft);
  const ids = [...new Set(test ? [ownerId] : recipientIds ?? await resolveRecipients(guild, target, ownerId))];
  if (!ids.length) throw new Error('Seçilen hedefte mesaj gönderilebilecek üye yok.');
  // Validate expansion for every recipient before starting any delivery.
  const context = { guildName: guild.name, now: Date.now() };
  const prepared = [];
  const unavailable = [];
  for (const id of ids) {
    let user;
    try { user = await client.users.fetch(id); } catch { unavailable.push({ id, code: 'user_unavailable' }); continue; }
    if (user.bot) continue;
    prepared.push({ user, payload: renderMessage(draft, user, context) });
  }
  const result = { sent: 0, failed: unavailable.length, total: ids.length, failures: unavailable };
  for (let i = 0; i < prepared.length; i += 3) {
    await Promise.all(prepared.slice(i, i + 3).map(async ({ user, payload }) => {
      try { await user.send(payload); result.sent++; }
      catch (error) { result.failed++; result.failures.push({ id: user.id, code: String(error.code ?? 'send_failed') }); }
    }));
    if (onProgress) await onProgress({ ...result });
    if (i + 3 < prepared.length) await wait(350);
  }
  return result;
}
