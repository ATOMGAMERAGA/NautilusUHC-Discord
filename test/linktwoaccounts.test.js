import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret';
process.env.DB_PATH = `/tmp/link-two-accounts-${process.pid}.db`;
const { verifyLinkCode } = await import('../src/linkflow.js');
const { readDiscordLink, createDefaultHandlers } = await import('../src/linkeffects.js');
const { setSetting } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { mcapi } = await import('../src/mcapi.js');
const { createLinkAdmin } = await import('../src/linkadmin.js');
const { default: commands } = await import('../src/commands/link.js');
const DC = '300000000000000001';
const first = { uuid: '00000000-0000-4000-8000-00000000000a', discordId: DC, linkId: 'first', currentName: 'First', tier: 'Altın' };
const second = { uuid: '00000000-0000-4000-8000-00000000000b', discordId: DC, linkId: 'second', currentName: 'Second', tier: 'Elmas' };
const silent = { log() {}, warn() {}, error() {} };
const api = {
  bridgeStatus: () => ({ ok: true, transport: 'reverse', instances: ['mc-live'], instanceMeta: [{ id: 'mc-live', linkProtocol: 2 }] }),
  linkVerifyV2: async () => ({ ok: true, link: second, created: true, instance: 'mc-live' }),
  linkInfo: async (selector, value) => ({ ok: true, linked: true, instance: 'mc-live',
    link: selector === 'uuid' && value === second.uuid ? second : first, links: [first, second] }),
};
after(() => { for (const suffix of ['', '-wal', '-shm']) rmSync(process.env.DB_PATH + suffix, { force: true }); });

test('second account verification reads its UUID, preserving success despite a different Discord representative', async () => {
  const result = await verifyLinkCode({ api, code: '9DAAAAAA', discordId: DC, logger: silent });
  assert.equal(result.outcome, 'linked');
  assert.equal(result.link.uuid, second.uuid);
});

test('Discord status returns both records', async () => {
  const result = await readDiscordLink(api, DC, 'mc-live');
  assert.deepEqual(result.links?.map((l) => l.uuid), [first.uuid, second.uuid]);
});

test('second linked record authorizes its own delayed role sync', async () => {
  setSetting('elo_role_map', JSON.stringify({ elmas: 'diamond-role' }));
  const cache = new Map();
  const member = { roles: { cache, add: async (id) => cache.set(id, true), remove: async (id) => cache.delete(id) } };
  const guild = { members: { me: { roles: { highest: { position: 50 } } }, fetch: async () => member },
    roles: { cache: new Map([['diamond-role', { id: 'diamond-role', position: 5 }]]) } };
  const client = { guilds: { cache: new Map([[config.guildId, guild]]) } };
  await createDefaultHandlers({ api }).role_sync({ discordId: DC, uuid: second.uuid, linkId: second.linkId, instance: 'mc-live' }, { client });
  assert.ok(cache.has('diamond-role'));
});

test('unlink keeps tier roles while the other account remains', async () => {
  setSetting('elo_role_map', JSON.stringify({ elmas: 'diamond-role' }));
  const cache = new Map([['diamond-role', true]]);
  const member = { roles: { cache, remove: async (id) => cache.delete(id) } };
  const guild = { members: { fetch: async () => member } };
  await createDefaultHandlers({ api }).role_cleanup({ discordId: DC, linkId: second.linkId, instance: 'mc-live' },
    { client: { guilds: { cache: new Map([[config.guildId, guild]]) } } });
  assert.ok(cache.has('diamond-role'));
});

test('/link shows both account names', async () => {
  const original = mcapi.linkInfo;
  const originalStatus = mcapi.bridgeStatus;
  mcapi.linkInfo = api.linkInfo;
  mcapi.bridgeStatus = api.bridgeStatus;
  let response;
  try {
    await commands.find((c) => c.data.name === 'link').execute({ user: { id: DC }, deferReply: async () => {}, editReply: async (value) => { response = value; } });
    const description = response.embeds[0].data.description;
    assert.match(description, /First/);
    assert.match(description, /Second/);
  } finally { mcapi.linkInfo = original; mcapi.bridgeStatus = originalStatus; }
});

test('admin Discord unlink asks for a UUID instead of silently choosing the first account', async () => {
  const actor = { id: '900000000000000001', member: { guild: { ownerId: 'x' }, roles: { cache: new Set([config.roles.admin]) } }, resolveUser: async () => null };
  const service = createLinkAdmin({ api, logger: silent });
  const result = await service.prepareUnlink({ actor, selector: 'discord', value: DC });
  assert.equal(result.components.length, 0);
  const description = result.embeds[0].data.description;
  assert.match(description, /UUID/);
  assert.match(description, new RegExp(second.uuid));
});

test('admin info displays both linked Minecraft accounts', async () => {
  const actor = { id: '900000000000000001', member: { guild: { ownerId: 'x' }, roles: { cache: new Set([config.roles.admin]) } }, resolveUser: async () => null };
  const result = await createLinkAdmin({ api, logger: silent }).infoPayload({ actor, selector: 'discord', value: DC });
  const fields = result.embeds.flatMap((embed) => embed.data.fields ?? []).map((field) => field.value).join('\n');
  assert.match(fields, /First/);
  assert.match(fields, /Second/);
});
