import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret';
process.env.DB_PATH = ':memory:';
const { createMessageDraft, renderMessage, validateDraft } = await import('../src/messagecore.js');
const { messageTemplates } = await import('../src/messagetemplates.js');
const { deliverMessage, resolveRecipients } = await import('../src/messagedelivery.js');
const actor = { id: '1051072781284016198', username: 'Atom' };
const other = { id: '1051072781284016199', username: 'Oyuncu' };
const context = { guildName: 'Nautilus', now: Date.UTC(2026, 9, 12, 12) };

test('plain DM substitutes every recipient mention and blocks unrelated mentions', () => {
  const draft = createMessageDraft({ mode: 'text', content: 'Merhaba %etiket%, %etiket%! %kullanici% / %sunucu% / %tarih% @everyone <@123>' });
  const payload = renderMessage(draft, other, context);
  assert.match(payload.content, /<@1051072781284016199>, <@1051072781284016199>/);
  assert.match(payload.content, /Oyuncu \/ Nautilus \/ 12 Ekim 2026/);
  assert.deepEqual(payload.allowedMentions, { parse: [], users: [other.id], repliedUser: false });
  assert.deepEqual(payload.embeds, []);
});

test('embed carries custom text, all visual options, fields and clickable URL buttons', () => {
  const draft = createMessageDraft({ content: 'Selam %etiket%', embed: {
    title: '%kullanici% için duyuru', description: '%etiket% hoş geldin', color: '#123ABC',
    url: 'https://nautilusuhc.com', image: 'https://example.com/a.png', thumbnail: 'https://example.com/b.png',
    author: { name: 'Nautilus', iconURL: 'https://example.com/c.png', url: 'https://nautilusuhc.com' },
    footer: { text: '%sunucu%', iconURL: 'https://example.com/d.png' }, timestamp: true,
    fields: [{ name: 'Oyuncu', value: '%etiket%', inline: true }],
  }, buttons: [{ label: 'Katıl', url: 'https://nautilusuhc.com', emoji: '🌊' }] });
  const p = renderMessage(draft, other, context);
  assert.equal(p.content, 'Selam <@1051072781284016199>');
  assert.equal(p.embeds[0].title, 'Oyuncu için duyuru');
  assert.equal(p.embeds[0].color, 0x123ABC);
  assert.equal(p.embeds[0].image.url, 'https://example.com/a.png');
  assert.equal(p.embeds[0].author.icon_url, 'https://example.com/c.png');
  assert.equal(p.embeds[0].footer.text, 'Nautilus');
  assert.equal(p.embeds[0].fields[0].value, `<@${other.id}>`);
  assert.equal(p.embeds[0].timestamp, new Date(context.now).toISOString());
  assert.equal(p.components[0].components[0].style, 5);
  assert.equal(p.components[0].components[0].url, 'https://nautilusuhc.com');
});

test('invalid color, non HTTP URL and Discord size limits fail before delivery', () => {
  for (const patch of [
    { embed: { color: '#zzzzzz' } }, { embed: { image: 'javascript:alert(1)' } },
    { mode: 'text', content: 'a'.repeat(2001) }, { embed: { title: 'a'.repeat(257) } },
    { embed: { fields: Array.from({ length: 26 }, () => ({ name: 'n', value: 'v' })) } },
    { buttons: Array.from({ length: 6 }, () => ({ label: 'a', url: 'https://example.com' })) },
    { embed: { description: 'a'.repeat(4096), fields: [{ name: 'x', value: 'b'.repeat(1024) }, { name: 'y', value: 'b'.repeat(1024) }] } },
    { buttons: [{ label: 'a', url: 'https://user:pass@example.com' }] },
  ]) assert.throws(() => validateDraft(createMessageDraft(patch)));
});

test('placeholder expansion is checked against final Discord limits', () => {
  const d = createMessageDraft({ mode: 'text', content: '%etiket%'.repeat(100) });
  assert.doesNotThrow(() => validateDraft(d));
  assert.throws(() => renderMessage(d, other, context), /2000/);
});

test('five templates persist and update by name without crossing owners or saving targets', () => {
  const draft = createMessageDraft({ content: 'saved', target: { kind: 'all' }, test: false });
  for (let n = 1; n <= 5; n++) messageTemplates.save('g', actor.id, `T${n}`, draft);
  assert.equal(messageTemplates.list('g', actor.id).length, 5);
  assert.throws(() => messageTemplates.save('g', actor.id, 'six', draft), /5/);
  const updated = messageTemplates.save('g', actor.id, 'T1', createMessageDraft({ content: 'updated' }));
  assert.equal(messageTemplates.list('g', actor.id).length, 5);
  assert.equal(updated.draft.content, 'updated');
  assert.equal(updated.draft.target, undefined);
  assert.equal(updated.draft.test, undefined);
  assert.equal(messageTemplates.list('g', other.id).length, 0);
  assert.equal(messageTemplates.list('otherGuild', actor.id).length, 0);
  assert.equal(messageTemplates.remove('g', other.id, updated.id), false);
  assert.equal(messageTemplates.remove('g', actor.id, updated.id), true);
  messageTemplates.save('g', actor.id, 'six', draft);
});

const guild = { name: 'Nautilus', members: { fetch: async () => new Map([
  [actor.id, { id: actor.id, user: actor, roles: { cache: new Map([['r', true]]) } }],
  [other.id, { id: other.id, user: other, roles: { cache: new Map() } }],
  ['bot', { id: 'bot', user: { id: 'bot', bot: true }, roles: { cache: new Map([['r', true]]) } }],
]) } };

test('full guild, role and member audiences skip bots and deduplicate recipients', async () => {
  assert.deepEqual(await resolveRecipients(guild, { kind: 'all' }, actor.id), [actor.id, other.id]);
  assert.deepEqual(await resolveRecipients(guild, { kind: 'role', roleId: 'r' }, actor.id), [actor.id]);
  assert.deepEqual(await resolveRecipients(guild, { kind: 'users', userIds: [other.id, other.id, 'bot', 'absent'] }, actor.id), [other.id]);
  await assert.rejects(resolveRecipients({ members: { fetch: async () => { throw Error('fetch failed'); } } }, { kind: 'all' }, actor.id), /fetch failed/);
});

test('test delivery ignores all audience sources including explicit confirmation recipients', async () => {
  const sent = [];
  const client = { users: { fetch: async id => ({ ...actor, id, send: async p => sent.push({ id, p }) }) } };
  const forbiddenGuild = { name: 'Nautilus', members: { fetch: async () => { throw Error('MUST NOT FETCH'); } } };
  const result = await deliverMessage({ client, guild: forbiddenGuild, ownerId: actor.id,
    draft: createMessageDraft(), target: { kind: 'all' }, test: true, recipientIds: [other.id], wait: async () => {} });
  assert.equal(result.sent, 1);
  assert.deepEqual(sent.map(x => x.id), [actor.id]);
  assert.match(sent[0].p.embeds[0].description, new RegExp(actor.id));
});

test('a closed DM does not interrupt delivery; each successful payload mentions its own recipient', async () => {
  const sent = [];
  const client = { users: { fetch: async id => ({ id, username: id, send: async p => {
    if (id === actor.id) throw Object.assign(Error('closed'), { code: 50007 });
    sent.push({ id, p });
  } }) } };
  const result = await deliverMessage({ client, guild, ownerId: actor.id, draft: createMessageDraft(),
    target: { kind: 'all' }, wait: async () => {} });
  assert.equal(result.sent, 1); assert.equal(result.failed, 1);
  assert.equal(sent[0].id, other.id);
  assert.match(sent[0].p.embeds[0].description, new RegExp(other.id));
});

test('recipient-dependent oversized content aborts before any DM is sent', async () => {
  let calls = 0;
  const client = { users: { fetch: async id => ({ id, username: 'a', send: async () => calls++ }) } };
  await assert.rejects(deliverMessage({ client, guild, ownerId: actor.id,
    draft: createMessageDraft({ mode: 'text', content: '%etiket%'.repeat(100) }), target: { kind: 'all' }, wait: async () => {} }), /2000/);
  assert.equal(calls, 0);
});
