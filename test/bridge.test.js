import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// config.js DISCORD_TOKEN ister; db.js dosya açar — ikisini de test için ayarla.
process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret-çok-gizli';
process.env.BRIDGE_ALLOW_LEGACY = '1';
const dbFile = join(tmpdir(), `nautilus-bridge-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const { createRequestHandler, verifySignature, buildAnnouncement, matchChannelId, findMatchChannelByName } = await import('../src/httpserver.js');
const { config } = await import('../src/config.js');
const { setSetting, processedEvents } = await import('../src/db.js');

const SECRET = process.env.BRIDGE_SECRET;

/* ---------------- yardımcılar ---------------- */

const sends = [];
const hookEvents = [];
const fetchedChannels = []; // hangi kanal id'sine gönderildiğini doğrulamak için
let channelAvailable = true;
const mockChannel = {
  isTextBased: () => true,
  send: async (payload) => { sends.push(payload); return { id: '1' }; },
};
const mockClient = {
  isReady: () => true,
  channels: {
    fetch: async (id) => {
      fetchedChannels.push(id);
      return channelAvailable ? mockChannel : null;
    },
  },
};

let server;
let base;
before(async () => {
  server = createServer(createRequestHandler(mockClient, {
    onEvent: async (env) => { hookEvents.push(env); },
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // Yeni tip fixture'ları (report_created/punishment/link_removed) staff
  // kanalına yönlenir; contract testinin "fixture başına 1 send" beklentisi
  // için kanal ayarı burada verilir.
  setSetting('staff_channel', '777888999');
});
after(() => {
  server?.close();
  try { rmSync(dbFile); rmSync(`${dbFile}-wal`, { force: true }); rmSync(`${dbFile}-shm`, { force: true }); } catch {}
});

function sign(rawBody, { ts = Date.now(), nonce = randomUUID(), secret = SECRET } = {}) {
  const signature = createHmac('sha256', secret).update(`${ts}.${nonce}.${rawBody}`).digest('hex');
  return {
    'X-Nautilus-Timestamp': String(ts),
    'X-Nautilus-Nonce': nonce,
    'X-Nautilus-Signature': signature,
  };
}

async function postEvent(envelope, headers = null) {
  const raw = JSON.stringify(envelope);
  const res = await fetch(`${base}/api/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? sign(raw)) },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

function v2(type, data = {}, extra = {}) {
  return {
    eventId: randomUUID(),
    schemaVersion: 2,
    type,
    occurredAt: new Date().toISOString(),
    test: false,
    data,
    ...extra,
  };
}

/* ---------------- verifySignature birim testleri ---------------- */

test('verifySignature: geçerli imza kabul edilir', () => {
  const ts = 1_700_000_000_000;
  const raw = '{"a":1}';
  const sig = createHmac('sha256', 's').update(`${ts}.n1.${raw}`).digest('hex');
  const err = verifySignature({ timestamp: String(ts), nonce: 'n1', signature: sig }, raw, 's',
    { now: ts + 1000, nonces: new Map() });
  assert.equal(err, null);
});

test('verifySignature: pencere dışı timestamp reddedilir', () => {
  const ts = 1_700_000_000_000;
  const raw = '{}';
  const sig = createHmac('sha256', 's').update(`${ts}.n1.${raw}`).digest('hex');
  const err = verifySignature({ timestamp: String(ts), nonce: 'n1', signature: sig }, raw, 's',
    { now: ts + 301_000, windowMs: 300_000, nonces: new Map() });
  assert.equal(err, 'timestamp_out_of_window');
});

test('verifySignature: nonce tekrarı (replay) reddedilir', () => {
  const ts = 1_700_000_000_000;
  const raw = '{}';
  const sig = createHmac('sha256', 's').update(`${ts}.n1.${raw}`).digest('hex');
  const nonces = new Map();
  assert.equal(verifySignature({ timestamp: String(ts), nonce: 'n1', signature: sig }, raw, 's', { now: ts, nonces }), null);
  assert.equal(verifySignature({ timestamp: String(ts), nonce: 'n1', signature: sig }, raw, 's', { now: ts, nonces }), 'replay');
});

test('verifySignature: yanlış imza reddedilir', () => {
  const err = verifySignature({ timestamp: String(Date.now()), nonce: 'n2', signature: 'deadbeef' }, '{}', 's',
    { nonces: new Map() });
  assert.equal(err, 'bad_signature');
});

/* ---------------- HTTP handler testleri ---------------- */

test('HMAC imzalı v2 eventi kanala gönderilir', async () => {
  sends.length = 0; hookEvents.length = 0;
  const { status, body } = await postEvent(v2('match_start', { host: 'Atom', players: 12, scenarios: ['Timber'] }));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(sends.length, 1);
  assert.equal(hookEvents.length, 1, 'onEvent hook çağrılmalı');
  assert.match(sends[0].embeds[0].data.title, /Maç Başladı/);
});

test('aynı eventId retry edilirse ikinci Discord mesajı üretilmez', async () => {
  sends.length = 0;
  const env = v2('match_start', { host: 'Atom', players: 3 });
  const r1 = await postEvent(env);
  const r2 = await postEvent(env); // yeni nonce/imza, aynı eventId
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.duplicate, true);
  assert.equal(sends.length, 1);
});

test('kanal erişilemezse eventId bırakılır ve retry başarır', async () => {
  sends.length = 0;
  const env = v2('match_start', { host: 'Atom', players: 3 });
  channelAvailable = false;
  const r1 = await postEvent(env);
  assert.equal(r1.status, 502);
  channelAvailable = true;
  const r2 = await postEvent(env);
  assert.equal(r2.status, 200);
  assert.notEqual(r2.body.duplicate, true, 'başarısız deneme sahipliği bırakmalı');
  assert.equal(sends.length, 1);
});

test('bozuk imza 401 döner', async () => {
  const raw = JSON.stringify(v2('match_start', {}));
  const headers = sign(raw);
  headers['X-Nautilus-Signature'] = '0'.repeat(64);
  const res = await fetch(`${base}/api/event`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw,
  });
  assert.equal(res.status, 401);
});

test('gövde imzadan sonra değiştirilirse 401 döner', async () => {
  const env = v2('match_start', { host: 'Atom' });
  const raw = JSON.stringify(env);
  const headers = sign(raw);
  const tampered = JSON.stringify({ ...env, data: { host: 'Hacker' } });
  const res = await fetch(`${base}/api/event`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: tampered,
  });
  assert.equal(res.status, 401);
});

test('legacy X-Bridge-Secret ile v1 zarfı hâlâ çalışır (geçiş modu)', async () => {
  sends.length = 0;
  const { status } = await postEvent(
    { type: 'match_end', test: false, data: { winner: 'Atom', durationSecs: 900, participantCount: 8 } },
    { 'X-Bridge-Secret': SECRET },
  );
  assert.equal(status, 200);
  assert.equal(sends.length, 1);
});

test('yanlış legacy secret 401 döner', async () => {
  const { status } = await postEvent({ type: 'message', data: {} }, { 'X-Bridge-Secret': 'wrong-secret' });
  assert.equal(status, 401);
});

test('bilinmeyen event türü 400 döner', async () => {
  const { status, body } = await postEvent(v2('bilinmeyen_tur', {}));
  assert.equal(status, 400);
  assert.equal(body.error, 'unknown_event_type');
});

test('desteklenmeyen schemaVersion 422 döner', async () => {
  const { status, body } = await postEvent(v2('match_start', {}, { schemaVersion: 99 }));
  assert.equal(status, 422);
  assert.equal(body.error, 'unsupported_schema_version');
});

test('test eventi rol etiketi taşımaz, normal event taşır', async () => {
  setSetting('match_ping_role', '42424242');
  const normal = buildAnnouncement('match_start', { host: 'x' }, false);
  const testli = buildAnnouncement('match_start', { host: 'x' }, true);
  assert.equal(normal.content, '<@&42424242>');
  assert.deepEqual(normal.allowedMentions.roles, ['42424242']);
  assert.equal(testli.content, undefined);
  assert.match(testli.embeds[0].data.title, /TEST/);
  setSetting('match_ping_role', '');
});

test('capabilities endpoint şema ve auth bilgisi döner', async () => {
  const res = await fetch(`${base}/api/capabilities`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.schemaVersions, [1, 2]);
  assert.ok(body.auth.includes('hmac-sha256'));
});

/* ---------------- Faz 7: yeni event tipleri ve kanal yönlendirme ---------------- */

test('capabilities yeni event tiplerini içerir', async () => {
  const res = await fetch(`${base}/api/capabilities`);
  const body = await res.json();
  for (const t of ['phase_change', 'tier_change', 'report_created', 'punishment', 'link_removed']) {
    assert.ok(body.eventTypes.includes(t), `${t} capabilities listesinde olmalı`);
  }
});

test('phase_change maç kanalına, report_created staff kanalına yönlenir', async () => {
  sends.length = 0; fetchedChannels.length = 0;
  const r1 = await postEvent(v2('phase_change', { phase: 'pvp', elapsedSecs: 600, aliveCount: 12, borderSize: 1000 }));
  const r2 = await postEvent(v2('report_created', { reporter: 'KaptanReis', reported: 'Oyuncu2', reason: 'xray' }));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(sends.length, 2);
  assert.equal(fetchedChannels[0], '1522216307809063154', 'phase_change maç kanalına gitmeli (varsayılan)');
  assert.equal(fetchedChannels[1], '777888999', 'report_created staff_channel ayarına gitmeli');
  assert.match(sends[0].embeds[0].data.title, /PvP/);
  assert.match(sends[1].embeds[0].data.title, /Oyuncu Raporu/);
  assert.equal(sends[0].content, undefined, 'yeni tipler rol pingi taşımaz');
});

test('staff kanalı boşken report_created routed:false döner, claim edilir, hook yine koşar', async () => {
  setSetting('staff_channel', '');
  sends.length = 0; hookEvents.length = 0;
  const env = v2('report_created', { reporter: 'A', reported: 'B', reason: 'x' });
  const r1 = await postEvent(env);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.routed, false);
  assert.equal(sends.length, 0, 'kanal ayarsızken mesaj üretilmemeli');
  assert.equal(hookEvents.length, 1, 'hook yönlendirme olmasa da çalışmalı');
  const r2 = await postEvent(env); // aynı eventId → duplicate, retry fırtınası yok
  assert.equal(r2.body.duplicate, true);
  assert.equal(sends.length, 0);
  setSetting('staff_channel', '777888999');
});

test('punishment source=discord bastırılır, source=game duyurulur', async () => {
  sends.length = 0; hookEvents.length = 0;
  const rd = await postEvent(v2('punishment', {
    action: 'ban', player: 'X', staff: 'Mod', reason: 'r', durationMs: null, source: 'discord',
  }));
  assert.equal(rd.status, 200);
  assert.equal(rd.body.routed, false, 'botun kendi /mcban aynası bastırılmalı');
  assert.equal(sends.length, 0);
  assert.equal(hookEvents.length, 1);
  const rg = await postEvent(v2('punishment', {
    action: 'mute', player: 'X', staff: 'Yetkili', reason: 'spam', durationMs: 60000, source: 'game',
  }));
  assert.equal(rg.status, 200);
  assert.equal(sends.length, 1);
  assert.match(sends[0].embeds[0].data.title, /MC Ceza/);
});

test('tier_change rank_channel ayarına, ayar boşken maç kanalına yönlenir', async () => {
  sends.length = 0; fetchedChannels.length = 0;
  await postEvent(v2('tier_change', { player: 'P1', oldTier: 'Altın', newTier: 'Zümrüt', elo: 1600, direction: 'promote' }));
  assert.equal(fetchedChannels[0], '1522216307809063154', 'ayar boşken maç kanalı');
  setSetting('rank_channel', '555666777');
  await postEvent(v2('tier_change', { player: 'P1', oldTier: 'Zümrüt', newTier: 'Elmas', elo: 1805, direction: 'promote' }));
  assert.equal(fetchedChannels[1], '555666777', 'rank_channel ayarlıyken oraya gitmeli');
  assert.equal(sends.length, 2);
  assert.match(sends[1].embeds[0].data.title, /Küme Atladı/);
  setSetting('rank_channel', '');
});

test('sözleşme fixture\'ları receiver tarafından işlenir (contract testi)', async () => {
  const { readFileSync, readdirSync, existsSync } = await import('node:fs');
  // Kanonik kopya monorepo docs/contracts altında; bot reposu tek başına
  // klonlandığında test/fixtures aynası kullanılır. İkisi de varsa parite
  // doğrulanır (drift = test hatası).
  const localDir = new URL('./fixtures/events/', import.meta.url);
  const canonDir = new URL('../../docs/contracts/events/fixtures/', import.meta.url);
  if (existsSync(canonDir)) {
    for (const f of readdirSync(localDir)) {
      const canon = new URL(f, canonDir);
      assert.ok(existsSync(canon), `${f} kanonik kopyada da olmalı`);
      assert.equal(readFileSync(new URL(f, localDir), 'utf8'), readFileSync(canon, 'utf8'),
        `${f} monorepo docs/contracts kopyasıyla birebir olmalı (drift)`);
    }
  }
  const fixtureDir = localDir;
  let checked = 0;
  for (const f of readdirSync(fixtureDir)) {
    if (!f.endsWith('.json')) continue;
    const envelope = JSON.parse(readFileSync(new URL(f, fixtureDir), 'utf8'));
    sends.length = 0;
    const { status } = await postEvent(envelope);
    assert.equal(status, 200, `${f} işlenmeli`);
    assert.equal(sends.length, 1, `${f} tek kanal mesajı üretmeli`);
    if (envelope.test) {
      assert.match(sends[0].embeds[0].data.title, /TEST/, `${f} TEST etiketi taşımalı`);
      assert.equal(sends[0].content, undefined, `${f} rol pingi taşımamalı`);
    }
    checked++;
  }
  assert.ok(checked >= 3, 'en az 3 fixture doğrulanmalı');
});

test('processedEvents.claim/release idempotency sözleşmesi', () => {
  const id = randomUUID();
  assert.equal(processedEvents.claim(id, 't'), true);
  assert.equal(processedEvents.claim(id, 't'), false);
  processedEvents.release(id);
  assert.equal(processedEvents.claim(id, 't'), true);
});

/* ---------------- maç kanalı yönlendirme (/admin mackanal + isim fallback) ---------------- */

test('match_channel ayarı maç duyuru kanalını geçersiz kılar', async () => {
  sends.length = 0;
  fetchedChannels.length = 0;
  setSetting('match_channel', '424242');
  try {
    assert.equal(matchChannelId(), '424242');
    const r = await postEvent(v2('match_start', { host: 'Atom', players: 2 }));
    assert.equal(r.status, 200);
    assert.equal(fetchedChannels.at(-1), '424242');
    assert.equal(sends.length, 1);
  } finally {
    setSetting('match_channel', '');
  }
});

test('kanal id geçersizse "maçlar" kanalı isimle bulunur ve duyuru oraya gider', async () => {
  const localSends = [];
  const namedChannel = {
    name: 'maçlar',
    isTextBased: () => true,
    send: async (p) => { localSends.push(p); return { id: '2' }; },
  };
  const guild = { channels: { cache: { find: (fn) => [namedChannel].find(fn) } } };
  const guildClient = {
    isReady: () => true,
    channels: { fetch: async () => { throw new Error('unknown channel'); } },
    guilds: { cache: { get: (id) => (id === config.guildId ? guild : undefined) } },
  };
  assert.equal(findMatchChannelByName(guildClient), namedChannel);

  const localServer = createServer(createRequestHandler(guildClient, {}));
  await new Promise((r) => localServer.listen(0, '127.0.0.1', r));
  const localBase = `http://127.0.0.1:${localServer.address().port}`;
  try {
    const raw = JSON.stringify(v2('match_start', { host: 'Atom', players: 5 }));
    const res = await fetch(`${localBase}/api/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...sign(raw) }, body: raw,
    });
    assert.equal(res.status, 200);
    assert.equal(localSends.length, 1);
  } finally {
    localServer.close();
  }
});
