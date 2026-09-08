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

/* ---------------- maç sonucu: kazanan en görünür bilgi ---------------- */

test('match_end: kazanan başlıkta ve açıklamada öne çıkar', () => {
  const e = embedOf('match_end', {
    winner: 'Atom', durationSecs: 1830, participantCount: 16, matchId: 42,
    top: [{ name: 'Atom', kills: 5 }, { name: 'Reis', kills: 3 }],
  });
  assert.match(e.title, /Atom/);
  assert.match(e.description, /Atom/);
  const names = e.fields.map((f) => f.name);
  assert.deepEqual(names.slice(0, 2), ['Süre', 'Katılımcı'], 'ikincil bilgiler kazanandan sonra gelir');
  assert.ok(e.fields.some((f) => f.name === 'En çok kill' && /🥇 Atom/.test(f.value)));
  assert.ok(e.fields.some((f) => f.value.includes('/maç detay 42')), 'sıradaki adım gösterilmeli');
});

test('match_end: kazanan yoksa başlık yine anlamlı', () => {
  const e = embedOf('match_end', { durationSecs: 100, participantCount: 4 });
  assert.match(e.title, /Maç Bitti/);
});

test('match_start: en önemli bilgiler sabit sırada', () => {
  const e = embedOf('match_start', { host: 'Atom', players: 12, scenarios: ['Timber'] });
  assert.match(e.title, /Maç Başladı/);
  assert.deepEqual(e.fields.map((f) => f.name), ['Oyuncu', 'Host', 'Senaryolar']);
  assert.ok(e.timestamp, 'duyuruda zaman damgası anlamlıdır');
});

test('match_scheduled: başlangıç saati ve katılım yolu gösterilir', () => {
  const e = embedOf('match_scheduled', {
    startsAt: 1784224803000, slot: '21:00', host: 'Atom', teamSize: 2, scenarios: ['Cutclean'],
  });
  assert.match(e.description, /21:00/);
  assert.ok(e.fields.some((f) => f.name === 'Mod' && f.value === 'To2'));
  assert.ok(e.fields.some((f) => f.name === 'Katılım' && /link/.test(f.value)));
});

test('match_cancelled: ne olduğu ve sıradaki adım birlikte verilir', () => {
  const e = embedOf('match_cancelled', { slot: '21:00', host: 'Atom', reason: 'yetersiz katılım' });
  assert.equal(e.color, Colors.danger);
  assert.match(e.description, /maç program/);
  assert.ok(e.fields.some((f) => f.name === 'Sebep'));
});

/* ---------------- test etiketi ve etiketleme güvenliği ---------------- */

test('test eventleri her tipte TEST etiketi taşır', () => {
  for (const type of ['match_scheduled', 'match_start', 'match_end', 'match_cancelled',
    'phase_change', 'tier_change', 'punishment', 'link_removed', 'host_message']) {
    const e = embedOf(type, { phase: 'pvp', startsAt: Date.now(), action: 'ban' }, true);
    assert.match(e.title, /TEST/, `${type} test etiketi taşımalı`);
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
