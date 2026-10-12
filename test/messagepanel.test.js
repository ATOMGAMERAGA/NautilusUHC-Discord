import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret';
process.env.DB_PATH = ':memory:';
const { createStudioSession, getStudioSession, prepareStudioSend, confirmStudioSend,
  handleMessageStudio, openMessageStudio } = await import('../src/messagestudio.js');
const { createMessageDraft } = await import('../src/messagecore.js');
const { messageTemplates } = await import('../src/messagetemplates.js');
const ownerId = '1051072781284016198';
const guildId = '1051072781284016197';
function interaction(customId = '', extra = {}) {
  const replies = [];
  const sent = [];
  return {
    customId, user: { id: ownerId, username: 'Atom' }, guildId, channelId: '1051072781284016196',
    guild: { id: guildId, name: 'Nautilus', ownerId,
      members: { fetch: async () => new Map([[ownerId, { id: ownerId, user: { id: ownerId }, roles: { cache: new Map() } }]]) } },
    member: { id: ownerId, roles: { cache: new Map() }, guild: { ownerId } },
    client: { users: { fetch: async id => ({ id, username: 'Atom', send: async payload => sent.push({ id, payload }) }) } },
    reply: async p => replies.push(p), update: async p => replies.push(p),
    deferUpdate: async () => {}, editReply: async p => replies.push(p), followUp: async p => replies.push(p),
    showModal: async p => replies.push(p), replies, sent, ...extra,
  };
}
test('private panel uses real Discord builders and initial targets are self only', async () => {
  const i = interaction();
  const s = await openMessageStudio(i, { kind: 'dm', test: false });
  assert.equal(i.replies[0].flags, 64);
  assert.equal(s.target.kind, 'self');
  assert.ok(i.replies[0].components.length <= 5);
  for (const row of i.replies[0].components) assert.doesNotThrow(() => row.toJSON());
});
test('sessions reject another owner, another guild, and expiry', () => {
  const s = createStudioSession({ ownerId, guildId, now: 100 });
  assert.throws(() => getStudioSession(s.id, 'other', guildId, { now: 200 }), /sana ait/);
  assert.throws(() => getStudioSession(s.id, ownerId, 'other', { now: 200 }), /sunucu/);
  assert.throws(() => getStudioSession(s.id, ownerId, guildId, { now: 100 + 31 * 60_000 }), /doldu/);
});
test('buttons recheck staff authorization', async () => {
  const s = createStudioSession({ ownerId, guildId });
  const i = interaction(`studio:${s.id}:test`, { member: { id: 'x', guild: { ownerId: 'y' }, roles: { cache: new Map() } } });
  await handleMessageStudio(i);
  assert.equal(i.sent.length, 0); assert.match(i.replies[0].embeds[0].data.description, /yetki/i);
});
test('test-mode send ignores normal audience and never fetches guild members', async () => {
  const s = createStudioSession({ ownerId, guildId, test: true });
  s.target = { kind: 'all' };
  const i = interaction();
  i.guild.members.fetch = async () => { throw Error('unexpected audience access'); };
  const pending = await prepareStudioSend(s, i);
  const result = await confirmStudioSend(s, pending.token, i);
  assert.equal(result.sent, 1); assert.deepEqual(i.sent.map(x => x.id), [ownerId]);
});
test('normal confirmation freezes its message and double confirmation cannot resend', async () => {
  const s = createStudioSession({ ownerId, guildId, draft: createMessageDraft({ content: 'original' }) });
  const i = interaction();
  const pending = await prepareStudioSend(s, i);
  s.draft.content = 'edited without publishing';
  const result = await confirmStudioSend(s, pending.token, i);
  assert.equal(result.sent, 1); assert.equal(i.sent[0].payload.content, 'original');
  await assert.rejects(confirmStudioSend(s, pending.token, i), /onay|gönderim/i);
  assert.equal(i.sent.length, 1);
});
test('confirmation expires and cannot use an unrelated nonce', async () => {
  const s = createStudioSession({ ownerId, guildId }); const i = interaction();
  const pending = await prepareStudioSend(s, i, { now: 100 });
  await assert.rejects(confirmStudioSend(s, 'wrong', i, { now: 200 }), /onay/i);
  await assert.rejects(confirmStudioSend(s, pending.token, i, { now: 100 + 121_000 }), /doldu/i);
  assert.equal(i.sent.length, 0);
});
test('a malformed modal cannot publish an invalid draft', async () => {
  const s = createStudioSession({ ownerId, guildId });
  const i = interaction(`studio:${s.id}:modal:appearance`, { fields: { getTextInputValue: key => ({
    color: '#ZZZZZZ', image: '', thumbnail: '', url: '', footer: '',
  })[key] ?? '' } });
  await handleMessageStudio(i);
  assert.equal(s.draft.embed.color, '#00B3B3');
  assert.match(i.replies[0].embeds[0].data.description, /HEX/);
});
test('loading a template preserves test mode and the selected audience', async () => {
  const template = messageTemplates.save(guildId, ownerId, 'Panel testi', createMessageDraft({ content: 'loaded' }));
  const s = createStudioSession({ ownerId, guildId, test: true }); s.target = { kind: 'all' };
  const i = interaction(`studio:${s.id}:template_load`, { values: [template.id] });
  await handleMessageStudio(i);
  assert.equal(s.test, true); assert.equal(s.target.kind, 'all'); assert.equal(s.draft.content, 'loaded');
});
test('normal panel test button sends only to the owner without fetching targets', async () => {
  const s = createStudioSession({ ownerId, guildId }); s.target = { kind: 'all' };
  const i = interaction(`studio:${s.id}:test`);
  i.guild.members.fetch = async () => { throw Error('unexpected fetch'); };
  await handleMessageStudio(i);
  assert.deepEqual(i.sent.map(x => x.id), [ownerId]);
});
test('slash definitions include private DM, channel match tests and optional embed starting values', async () => {
  const { default: commands } = await import('../src/commands/admin.js');
  const admin = commands.find(c => c.data.name === 'admin').data.toJSON();
  assert.ok(admin.options.some(o => o.name === 'dm' && o.options.some(x => x.name === 'test')));
  assert.ok(admin.options.some(o => o.name === 'macmesajtest'));
  const embed = commands.find(c => c.data.name === 'embed').data.toJSON();
  assert.ok(embed.options.every(o => !o.required));
});
test('audience changes during roster fetch invalidate the pending send', async () => {
  const s = createStudioSession({ ownerId, guildId }); s.target = { kind: 'all' };
  const i = interaction();
  i.guild.members.fetch = async () => { s.version++; s.target = { kind: 'self' }; return new Map([[ownerId, { id: ownerId, user: { id: ownerId } }]]); };
  await assert.rejects(prepareStudioSend(s, i), /değişti/);
  assert.equal(s.pending, null);
});
test('an existing field opens an edit form with its saved text', async () => {
  const s = createStudioSession({ ownerId, guildId, draft: createMessageDraft({
    embed: { fields: [{ name: 'Ödül', value: '400 TL', inline: true }] },
  }) });
  const i = interaction(`studio:${s.id}:field_edit`, { values: ['0'] });
  await handleMessageStudio(i);
  const m = i.replies[0].toJSON();
  assert.equal(m.components[1].components[0].value, 'Ödül');
  assert.equal(m.components[2].components[0].value, '400 TL');
});
test('simultaneous self-test clicks send exactly one DM', async () => {
  const s = createStudioSession({ ownerId, guildId }); const i = interaction(`studio:${s.id}:test`);
  await Promise.all([handleMessageStudio(i), handleMessageStudio(i)]);
  assert.equal(i.sent.length, 1);
});
