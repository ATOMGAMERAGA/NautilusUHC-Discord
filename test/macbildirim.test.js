import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret';
process.env.MC_API_URL = ''; // köprü kapalı — linkedMcName sessizce boş dönmeli
const dbFile = join(tmpdir(), `nautilus-macbildirim-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const { dmSubscriptions } = await import('../src/db.js');
const { dispatchMatchDms, confirmDecision, CONFIRM_TTL_MS } = await import('../src/matchdm.js');
const { buildAnnouncement } = await import('../src/httpserver.js');

process.on('exit', () => {
  try { rmSync(dbFile, { force: true }); rmSync(`${dbFile}-wal`, { force: true }); rmSync(`${dbFile}-shm`, { force: true }); } catch {}
});

/** DM'leri kaydeden mock client. failFor: bu kullanıcılar 50007 fırlatır. */
function mockClient(dms, failFor = new Set()) {
  return {
    users: {
      fetch: async (id) => ({
        send: async (payload) => {
          if (failFor.has(id)) {
            const err = new Error('Cannot send messages to this user');
            err.code = 50007;
            throw err;
          }
          dms.push({ id, payload });
        },
      }),
    },
  };
}

function reset() {
  for (const id of dmSubscriptions.enabledUserIds()) dmSubscriptions.set(id, false);
}

/* ---------------- abonelik kalıcılığı ---------------- */

test('abonelik aç/kapa kalıcı olarak saklanır', () => {
  reset();
  assert.equal(dmSubscriptions.isEnabled('u1'), false);
  dmSubscriptions.set('u1', true);
  assert.equal(dmSubscriptions.isEnabled('u1'), true);
  assert.deepEqual(dmSubscriptions.enabledUserIds(), ['u1']);
  dmSubscriptions.set('u1', false);
  assert.equal(dmSubscriptions.isEnabled('u1'), false);
  assert.deepEqual(dmSubscriptions.enabledUserIds(), []);
});

/* ---------------- onay kararı (buton güvenliği) ---------------- */

test('onay butonu: başka kullanıcı basamaz', () => {
  const d = confirmDecision(`bildirim:ac:sahip:${Date.now()}`, 'baskasi');
  assert.equal(d, 'not_owner');
});

test('onay butonu: TTL aşımında süresi dolar', () => {
  const issued = Date.now() - CONFIRM_TTL_MS - 1000;
  const d = confirmDecision(`bildirim:ac:sahip:${issued}`, 'sahip');
  assert.equal(d, 'expired');
});

test('onay butonu: sahibi TTL içinde onaylayabilir', () => {
  const d = confirmDecision(`bildirim:kapat:sahip:${Date.now()}`, 'sahip');
  assert.deepEqual(d, { action: 'kapat', ownerId: 'sahip' });
});

/* ---------------- DM dağıtım kuralları ---------------- */

const startData = { host: 'Atom', players: 10, scenarios: ['Timber'], startedAt: 1784224803000 };

test('normal match_start yalnız abonelere birer DM gönderir', async () => {
  reset();
  dmSubscriptions.set('a1', true);
  dmSubscriptions.set('a2', true);
  dmSubscriptions.set('kapali', false);
  const dms = [];
  const res = await dispatchMatchDms(mockClient(dms), {
    type: 'match_start', test: false, data: startData, eventId: randomUUID(),
  });
  assert.equal(res.sent, 2);
  assert.equal(res.failed, 0);
  assert.deepEqual(dms.map((d) => d.id).sort(), ['a1', 'a2']);
  // Kullanıcı kontrollü etiketlenir; mention allowlist yalnız o kullanıcı.
  for (const d of dms) {
    assert.ok(d.payload.content.includes(`<@${d.id}>`));
    assert.deepEqual(d.payload.allowedMentions, { users: [d.id] });
  }
});

test('test maçı (test: true) hiçbir DM üretmez', async () => {
  reset();
  dmSubscriptions.set('a1', true);
  const dms = [];
  const res = await dispatchMatchDms(mockClient(dms), { type: 'match_start', test: true, data: startData });
  assert.equal(res.skipped, true);
  assert.equal(dms.length, 0);
});

test('match_start dışındaki event türleri DM üretmez', async () => {
  reset();
  dmSubscriptions.set('a1', true);
  const dms = [];
  for (const type of ['match_scheduled', 'match_end', 'match_cancelled', 'message', 'host_message']) {
    await dispatchMatchDms(mockClient(dms), { type, test: false, data: {} });
  }
  assert.equal(dms.length, 0);
});

test('kapatan kullanıcı yeni eventte DM almaz', async () => {
  reset();
  dmSubscriptions.set('a1', true);
  dmSubscriptions.set('a1', false);
  const dms = [];
  await dispatchMatchDms(mockClient(dms), { type: 'match_start', test: false, data: startData });
  assert.equal(dms.length, 0);
});

test('DM kapalı kullanıcı (50007) batch\'i durdurmaz, hata kaydedilir', async () => {
  reset();
  dmSubscriptions.set('b1', true);
  dmSubscriptions.set('dmkapali', true);
  dmSubscriptions.set('b3', true);
  const dms = [];
  const res = await dispatchMatchDms(mockClient(dms, new Set(['dmkapali'])), {
    type: 'match_start', test: false, data: startData,
  });
  assert.equal(res.sent, 2);
  assert.equal(res.failed, 1);
  assert.deepEqual(dms.map((d) => d.id).sort(), ['b1', 'b3']);
  assert.match(dmSubscriptions.lastError('dmkapali').last_error, /50007/);
  // başarılı teslimat hatayı temizler
  assert.equal(dmSubscriptions.lastError('b1').last_error ?? null, null);
});

test('DM embed\'i kanal duyurusuyla aynı üreticiden çıkar (drift yok)', async () => {
  reset();
  dmSubscriptions.set('c1', true);
  const dms = [];
  await dispatchMatchDms(mockClient(dms), { type: 'match_start', test: false, data: startData });
  const channelPayload = buildAnnouncement('match_start', startData, false);
  assert.deepEqual(dms[0].payload.embeds[0].data.fields, channelPayload.embeds[0].data.fields);
  assert.equal(dms[0].payload.embeds[0].data.title, channelPayload.embeds[0].data.title);
});
