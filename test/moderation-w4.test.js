import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret';
const dbFile = join(tmpdir(), `nautilus-w4-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const {
  db, userNotes, casesOfPage, caseCount, addCase,
} = await import('../src/db.js');
const {
  escalationAction, escalationConfig, setTimeoutThreshold, setBanThreshold, clearEscalation,
} = await import('../src/escalation.js');
const { joinRateExceeded, accountTooYoung } = await import('../src/security/raid.js');

after(() => {
  try { rmSync(dbFile); rmSync(`${dbFile}-wal`, { force: true }); rmSync(`${dbFile}-shm`, { force: true }); } catch {}
});

/* ---------------- migration v4 ---------------- */

test('migration v4 uygulanır: user_notes tablosu ve sürüm kaydı', () => {
  const versions = db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version);
  assert.ok(versions.includes(4), 'v4 migration kaydı olmalı');
  // Tablo gerçekten var mı — insert dener.
  const id = userNotes.add('u1', 'mod1', 'test notu');
  assert.ok(id > 0);
});

/* ---------------- userNotes CRUD ---------------- */

test('userNotes: ekle/listele/say/sil', () => {
  userNotes.add('u2', 'mod1', 'birinci');
  userNotes.add('u2', 'mod2', 'ikinci');
  assert.equal(userNotes.count('u2'), 2);
  const notes = userNotes.of('u2');
  assert.equal(notes.length, 2);
  assert.equal(notes[0].note, 'ikinci', 'en yeni önce (DESC)');
  assert.equal(userNotes.remove(notes[0].id, 'u2'), true);
  assert.equal(userNotes.count('u2'), 1);
  assert.equal(userNotes.remove(999999, 'u2'), false, 'olmayan not silinmez');
  assert.equal(userNotes.remove(notes[1].id, 'BAŞKA'), false, 'yanlış user_id silmez');
});

/* ---------------- casesOfPage / caseCount ---------------- */

test('casesOfPage & caseCount: sayfalama tutarlı', () => {
  for (let i = 0; i < 25; i++) addCase('warn', 'u3', 'mod1', `sebep ${i}`);
  assert.equal(caseCount('u3'), 25);
  const p0 = casesOfPage('u3', 10, 0);
  const p1 = casesOfPage('u3', 10, 10);
  const p2 = casesOfPage('u3', 10, 20);
  assert.equal(p0.length, 10);
  assert.equal(p1.length, 10);
  assert.equal(p2.length, 5);
  assert.notEqual(p0[0].id, p1[0].id, 'sayfalar farklı kayıtlar');
  assert.ok(p0[0].id > p1[0].id, 'DESC sıra: ilk sayfa en yeni id\'ler');
});

/* ---------------- escalation ---------------- */

test('escalationAction: eşik yok → null', () => {
  assert.equal(escalationAction(10, {}), null);
  assert.equal(escalationAction(10, { timeout: null, ban: null }), null);
});

test('escalationAction: timeout eşiği', () => {
  const cfg = { timeout: { count: 3, durationMs: 60_000 } };
  assert.equal(escalationAction(2, cfg), null, 'eşiğin altında tetiklenmez');
  const a = escalationAction(3, cfg);
  assert.deepEqual(a, { type: 'timeout', ms: 60_000 });
});

test('escalationAction: ban eşiği timeout\'tan önce gelir', () => {
  const cfg = { timeout: { count: 3, durationMs: 60_000 }, ban: { count: 5 } };
  assert.deepEqual(escalationAction(4, cfg), { type: 'timeout', ms: 60_000 });
  assert.deepEqual(escalationAction(5, cfg), { type: 'ban' }, 'ban eşiğinde ban kazanır');
});

test('escalationAction: timeout süresi verilmemişse 1 saat', () => {
  const a = escalationAction(3, { timeout: { count: 3 } });
  assert.deepEqual(a, { type: 'timeout', ms: 3_600_000 });
});

test('escalation settings: yaz/oku/temizle', () => {
  clearEscalation();
  assert.deepEqual(escalationConfig(), { timeout: null, ban: null });
  setTimeoutThreshold(3, 60_000);
  setBanThreshold(5);
  const cfg = escalationConfig();
  assert.equal(cfg.timeout.count, 3);
  assert.equal(cfg.ban.count, 5);
  clearEscalation();
  assert.equal(escalationConfig().ban, null);
});

/* ---------------- raid saf yardımcıları ---------------- */

test('joinRateExceeded: pencere sınırları', () => {
  const now = 100_000;
  const ts = [now - 1000, now - 2000, now - 3000, now - 40_000];
  // pencere 30sn, limit 2 → son 3 katılım pencere içinde (>2) → aşıldı
  assert.equal(joinRateExceeded(ts, 2, 30_000, now), true);
  // limit 3 → tam 3 katılım, > değil → aşılmadı
  assert.equal(joinRateExceeded(ts, 3, 30_000, now), false);
  // pencere 500ms → hiçbiri içinde değil
  assert.equal(joinRateExceeded(ts, 0, 500, now), false);
});

test('accountTooYoung: hesap yaşı sınırı', () => {
  const now = 30 * 86_400_000; // 30 gün
  assert.equal(accountTooYoung(now - 5 * 86_400_000, 7, now), true, '5 günlük hesap, 7 gün eşiği → genç');
  assert.equal(accountTooYoung(now - 10 * 86_400_000, 7, now), false, '10 günlük hesap, 7 gün eşiği → uygun');
  assert.equal(accountTooYoung(0, 0, now), false, 'eşik 0 → kapalı');
});
