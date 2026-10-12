import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret';
const dbFile = join(tmpdir(), `nautilus-announce-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const { buildAnnouncement } = await import('../src/httpserver.js');
const { Colors, Limits } = await import('../src/embeds.js');

after(() => {
  try { rmSync(dbFile, { force: true }); rmSync(`${dbFile}-wal`, { force: true }); rmSync(`${dbFile}-shm`, { force: true }); } catch {}
});

const embedOf = (type, data, test = false) => buildAnnouncement(type, data, test).embeds[0].data;

const hostDiscordId = '123456789012345678';
const now = Date.parse('2026-10-12T08:00:00Z');
const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const matchData = {
  startsAt: Date.parse('2026-10-12T12:00:00Z'), teamSize: 1,
  host: 'Atom', hostDiscordId, scenarios: ['safe_loot', 'auto_smelt'],
};

const expectedMatch = (status, { team = 'FFA', prize = '' } = {}) =>
  '<:goldenapple:1336769041934585948> **Nautilus UHC Match**\n\n'
  + `${divider}\n\n`
  + `<:bayrak:1541604665064423484> **Takım Boyutu:** \`${team}\`\n\n`
  + '<:kitap:1559053100625690734> **Senaryolar:**\n'
  + '\`Safe Loot\` \`Auto Smelt\`\n\n'
  + '<:NautilusUHC:1546552489975873640> **IP:** \`nautilusuhc.com\`\n'
  + '<:yldz:1559054377526886444> **Version:** \`1.21+\`\n'
  + (prize ? `<:para:1559053003703717989> **Ödül:** ${prize}\n` : '')
  + `\n${status}\n\n${divider}\n\n**Hosted by <@${hostDiscordId}>**`;

test('planned match uses exact requested layout, Istanbul time and brand color', () => {
  const e = buildAnnouncement('match_scheduled', matchData, false, { now }).embeds[0].data;
  assert.equal(e.description, expectedMatch('<:saat:1559054932211138640> **Açılma Zamanı:** \`15.00\`'));
  assert.equal(e.color, Colors.brand);
  for (const key of ['title', 'fields', 'thumbnail', 'image', 'timestamp']) assert.equal(e[key], undefined);
  assert.ok(!e.footer, 'no additional branding footer');
});

test('prize sits immediately below version and team size is dynamic', () => {
  for (const teamSize of [2, 3]) {
    const e = buildAnnouncement('match_start', { ...matchData, teamSize, prize: '500 TL + VIP' }).embeds[0].data;
    assert.equal(e.description, expectedMatch('<:saat:1559054932211138640> **Açıldı**', { team: `To${teamSize}`, prize: '500 TL + VIP' }));
    assert.doesNotMatch(e.description, /Açılma Zamanı/);
  }
  assert.doesNotMatch(embedOf('match_start', { ...matchData, prize: '   ' }).description, /Ödül/);
});

test('future Istanbul dates include Turkish date, today depends on Istanbul midnight', () => {
  const e = buildAnnouncement('match_scheduled', { ...matchData, startsAt: '2026-10-15T12:00:00Z' }, false, { now }).embeds[0].data;
  assert.match(e.description, /\`15 Ekim, Saat 15\.00\`/);
  const overnight = buildAnnouncement('match_scheduled', { ...matchData, startsAt: '2026-10-12T22:00:00Z' }, false, { now: Date.parse('2026-10-12T21:01:00Z') }).embeds[0].data;
  assert.match(overnight.description, /\`01\.00\`/);
  assert.doesNotMatch(overnight.description, /13 Ekim/);
});

test('legacy planned slot and host name remain readable without a linked host id', () => {
  const e = embedOf('match_scheduled', { slot: '21:00', host: 'Atom', scenarios: ['Timber'] });
  assert.match(e.description, /\`21\.00\`/);
  assert.match(e.description, /Hosted by Atom/);
  assert.doesNotMatch(e.description, /<@/);
  assert.match(embedOf('match_start', { hostDiscordId: '@everyone', host: 'Fallback' }).description, /Hosted by Fallback/);
});

test('scenario keys map to display names and only enabled scenarios are shown', () => {
  const e = embedOf('match_start', { scenarios: { safe_loot: true, auto_smelt: false, no_fire: true, veinminer: true } });
  assert.match(e.description, /\`Safe Loot\` \`Fire Resistance\` \`Vein Miner\`/);
  assert.doesNotMatch(e.description, /Auto Smelt/);
  assert.match(embedOf('match_start', { scenarios: ['new_scenario'] }).description, /\`New Scenario\`/);
});

test('results use exact winners, MVP and host description with no extra fields', () => {
  const e = embedOf('match_end', { winners: ['example1', 'example2', 'example3'], mvpName: 'example1', hostDiscordId });
  assert.equal(e.description,
    '<:NautilusUHC:1546552489975873640> **NautilusUHC Maç Sonuçları:**\n\n'
    + `${divider}\n\n`
    + '<:kazanan:1559164230127722507> **Kazanan:** \`\`example1 , example2 , example3\`\`\n'
    + '<a:mvp:1559164030403219466> **MVP:** \`example1\`\n\n'
    + `${divider}\n\nHosted by <@${hostDiscordId}>`);
  assert.equal(e.color, Colors.brand);
  assert.equal(e.fields, undefined);
  assert.equal(e.title, undefined);
});

test('legacy winner string and missing MVP or winner remain supported', () => {
  assert.match(embedOf('match_end', { winner: 'Atom' }).description, /\`\`Atom\`\`/);
  assert.match(embedOf('match_end', { winners: 'Atom , Reis' }).description, /\`\`Atom , Reis\`\`/);
  assert.match(embedOf('match_end', {}).description, /\*\*Kazanan:\*\* \`\`—\`\`/);
  assert.match(embedOf('match_end', {}).description, /\*\*MVP:\*\* \`—\`/);
});

test('match_cancelled: ne olduğu ve sıradaki adım birlikte verilir', () => {
  const e = embedOf('match_cancelled', { slot: '21:00', host: 'Atom', reason: 'yetersiz katılım' });
  assert.equal(e.color, Colors.danger);
  assert.match(e.description, /maç program/);
  assert.ok(e.fields.some((f) => f.name === 'Sebep'));
});

/* ---------------- test etiketi ve etiketleme güvenliği ---------------- */

test('duyuru başlıklarında TEST etiketi görünmez', () => {
  for (const type of ['match_scheduled', 'match_start', 'match_end', 'match_cancelled',
    'phase_change', 'tier_change', 'punishment', 'link_removed', 'host_message']) {
    const e = embedOf(type, { phase: 'pvp', startsAt: Date.now(), action: 'ban', message: 'Host duyurusu' }, true);
    assert.doesNotMatch(e.title ?? e.description, /TEST/, `${type} temiz başlık taşımalı`);
  }
});

test('duyuru payload\'ı varsayılan olarak hiçbir etiketi pinglemez', () => {
  const payload = buildAnnouncement('match_end', { winner: '@everyone' }, false);
  assert.deepEqual(payload.allowedMentions.parse, []);
  assert.equal(payload.allowedMentions.roles, undefined);
  assert.equal(payload.content, undefined);
});

/* ---------------- dinamik veri limitleri ---------------- */

test('aşırı uzun oyuncu adı ve sebep embed\'i kırmaz', () => {
  const e = embedOf('punishment', {
    action: 'ban', player: 'P'.repeat(500), staff: 'S'.repeat(500), reason: 'R'.repeat(5000),
  });
  assert.ok(e.title.length <= Limits.title);
  for (const f of e.fields) {
    assert.ok(f.name.length <= Limits.fieldName);
    assert.ok(f.value.length <= Limits.fieldValue);
  }
});

test('bilinmeyen event tipi duyuru üretmez', () => {
  assert.equal(buildAnnouncement('bilinmeyen', {}, false), null);
});


test('match pings default off and require explicit boolean flags', () => {
  for (const type of ['match_scheduled', 'match_start', 'match_end']) {
    const data = { ...matchData, mentionEveryone: true, mentionHere: true };
    const payload = buildAnnouncement(type, data, false);
    assert.equal(payload.content, '||@everyone @here||');
    assert.deepEqual(payload.allowedMentions, { parse: ['everyone'], users: [] });
    for (const flags of [{}, { mentionEveryone: 'true', mentionHere: 1 }]) {
      const off = buildAnnouncement(type, { ...matchData, ...flags }, false);
      assert.equal(off.content, undefined);
      assert.deepEqual(off.allowedMentions, { parse: [], users: [] });
    }
    assert.equal(buildAnnouncement(type, { ...data, mentionHere: false }, false).content, '||@everyone||');
    assert.equal(buildAnnouncement(type, { ...data, mentionEveryone: false }, false).content, '||@here||');
    const sample = buildAnnouncement(type, data, true);
    assert.equal(sample.content, undefined);
    assert.deepEqual(sample.allowedMentions, { parse: [], users: [] });
  }
  assert.equal(buildAnnouncement('match_start', { ...matchData, mentionEveryone: true, mentionHere: true, plannedAnnouncement: true }).content, undefined);
});

test('long dynamic strings and code delimiters cannot break description or host attribution', () => {
  const e = embedOf('match_start', { ...matchData, prize: 'P'.repeat(8000), scenarios: ['safe_loot', '`unsafe`\nkey'.repeat(200)], host: 'H'.repeat(8000) });
  assert.ok(e.description.length <= Limits.description);
  assert.match(e.description, new RegExp(`Hosted by <@${hostDiscordId}>`));
  const results = embedOf('match_end', { winners: Array(100).fill('`X`\n'.repeat(300)), mvpName: '`MVP`', host: 'Host' });
  assert.ok(results.description.length <= Limits.description);
  assert.match(results.description, /\*\*MVP:\*\* \`MVP\`/);
  assert.match(results.description, /Hosted by Host/);
});

test('sample announcements call the production builder and always suppress all mentions', async () => {
  const { sampleMatchAnnouncements } = await import('../src/matchannouncements.js');
  const samples = sampleMatchAnnouncements(hostDiscordId, { prize: 'VIP', teamSize: 3, now });
  assert.deepEqual(samples.map((s) => s.type), ['match_scheduled', 'match_start', 'match_end']);
  for (const sample of samples) {
    assert.deepEqual(sample.payload, buildAnnouncement(sample.type, sample.data, true, { now }));
    assert.equal(sample.payload.content, undefined);
    assert.deepEqual(sample.payload.allowedMentions, { parse: [], users: [] });
    assert.match(sample.payload.embeds[0].data.description, new RegExp(`<@${hostDiscordId}>`));
  }
  assert.equal(sampleMatchAnnouncements(hostDiscordId, { type: 'match_end', now }).length, 1);
});
