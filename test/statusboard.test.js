import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret';
const dbFile = join(tmpdir(), `nautilus-statusboard-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const { payloadHash, shouldEdit, presenceLine } = await import('../src/statusboard.js');
const { statusBoardEmbed } = await import('../src/liveembeds.js');

after(() => {
  try { rmSync(dbFile); rmSync(`${dbFile}-wal`, { force: true }); rmSync(`${dbFile}-shm`, { force: true }); } catch {}
});

const STATUS = {
  ok: true,
  count: 5,
  match: { active: true, state: 'PvP', aliveCount: 4, participantCount: 8, elapsedSecs: 100, borderSize: 900 },
};

test('payloadHash: timestamp hariç tutulur — aynı içerik aynı hash', () => {
  const a = statusBoardEmbed(STATUS, null).setTimestamp(new Date(1_000));
  const b = statusBoardEmbed(STATUS, null).setTimestamp(new Date(2_000));
  assert.equal(payloadHash(a), payloadHash(b), 'yalnız timestamp değişince edit tetiklenmemeli');
});

test('payloadHash: içerik değişince hash değişir', () => {
  const a = statusBoardEmbed(STATUS, null);
  const changed = JSON.parse(JSON.stringify(STATUS));
  changed.match.aliveCount = 3;
  const b = statusBoardEmbed(changed, null);
  assert.notEqual(payloadHash(a), payloadHash(b));
});

test('shouldEdit: yalnız hash farklıyken true', () => {
  assert.equal(shouldEdit('x', 'x'), false);
  assert.equal(shouldEdit('x', 'y'), true);
  assert.equal(shouldEdit('x', null), true, 'ilk tick her zaman gönderir/düzenler');
});

test('presenceLine: maç, boş sunucu ve ulaşılamama halleri', () => {
  assert.equal(presenceLine(STATUS), '⚔️ 4/8 — PvP');
  assert.equal(presenceLine({ ok: true, count: 7, match: { active: false } }), '🎮 7 oyuncu | nautilusuhc.com');
  assert.equal(presenceLine({ ok: false }), 'nautilusuhc.com');
});
