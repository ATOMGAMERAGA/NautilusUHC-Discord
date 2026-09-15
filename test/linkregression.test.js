import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

/**
 * HESAP EŞLEME REGRESYONLARI (bot tarafı).
 *
 * Bu dosyadaki testler 1.2.1 döneminin bot kodunda FAIL veren somut hataları
 * kilitler: çok instance'ta "ilk başarı" seçimi, zaman aşımından sonra başka
 * instance'a körlemesine yazma, kaybolan başarılı yanıtın tekrarında kodun hiç
 * doğrulanmaması, hedef dışı instance'tan gelen iş sonucunun kabulü ve kalıcı
 * eşleme sonrası audit hatasının kullanıcıya "başarısız" gösterilmesi.
 */

process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret-çok-gizli';
process.env.BRIDGE_ALLOW_LEGACY = '1';
const dbFile = join(tmpdir(), `nautilus-linkregression-${process.pid}.db`);
process.env.DB_PATH = dbFile;

register('./support/discordjs-hooks.mjs', import.meta.url);

const { createMcApi } = await import('../src/mcapi.js');
const { verifyLinkCode } = await import('../src/linkflow.js');
const { createRequestHandler } = await import('../src/httpserver.js');
const { bridgeQueue } = await import('../src/bridgequeue.js');
const { componentHandlers } = await import('../src/components.js');
const { db } = await import('../src/db.js');
const { createFakePlugin, createFakeBridge, LINK_WRITE_PATHS } = await import('./support/fakeplugin.js');

const SECRET = process.env.BRIDGE_SECRET;
const SILENT = { log() {}, warn() {}, error() {} };
const AHMET_DC = '300000000000000001';
const ZEYNEP_DC = '300000000000000002';

function apiFor(bridge) {
  return createMcApi({
    queue: bridge,
    cfg: { mcApiUrl: '', directFallbackDisabled: false, mcApiUrlError: null, bridgeSecret: SECRET },
    logger: SILENT,
  });
}

function sign(rawBody) {
  const ts = Date.now();
  const nonce = randomUUID();
  return {
    'X-Nautilus-Timestamp': String(ts),
    'X-Nautilus-Nonce': nonce,
    'X-Nautilus-Signature': createHmac('sha256', SECRET).update(`${ts}.${nonce}.${rawBody}`).digest('hex'),
  };
}

let server;
let base;
before(async () => {
  server = createServer(createRequestHandler({ isReady: () => true, channels: { fetch: async () => null } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  bridgeQueue.reset();
  // Windows'ta açık SQLite dosyası silinemez; geçici dosya temp'te kalabilir.
  try {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true });
  } catch { /* açık dosya */ }
});

test('RB1 iki bağımsız instance aynı kodu farklı oyunculara verdiğinde hiçbir hesap yanlış eşlenmez', async () => {
  const a = createFakePlugin({ instanceId: 'mc-a' });
  const b = createFakePlugin({ instanceId: 'mc-b' });
  a.issueCode('00000000-0000-4000-8000-00000000000a', 'Ahmet', 'K7QX4M');
  b.issueCode('00000000-0000-4000-8000-00000000000b', 'Zeynep', 'K7QX4M'); // kasıtlı çakışma
  const bridge = createFakeBridge([a, b]);

  const decision = await verifyLinkCode({
    api: apiFor(bridge), code: 'K7QX4M', discordId: ZEYNEP_DC, discordTag: 'zeynep#0', logger: SILENT,
  });

  assert.equal(a.linkByDiscord(ZEYNEP_DC), null, 'kodu hangi sunucunun verdiği belirsizken A sunucusunda eşleme yapıldı');
  assert.equal(b.linkByDiscord(ZEYNEP_DC), null, 'kodu hangi sunucunun verdiği belirsizken B sunucusunda eşleme yapıldı');
  assert.notEqual(decision.outcome, 'linked');
});

test('RB2 zaman aşımıyla sonucu belirsiz kalan doğrulama başka instance\'a yazma isteğiyle denenmez', async () => {
  const a = createFakePlugin({ instanceId: 'mc-a' });
  const b = createFakePlugin({ instanceId: 'mc-b' });
  a.issueCode('00000000-0000-4000-8000-00000000000a', 'Ahmet', 'P4RT9Q');
  const bridge = createFakeBridge([a, b], {
    faults: {
      onJob: (job, target) => (target.instanceId === 'mc-a' && LINK_WRITE_PATHS.has(String(job.path).split('?')[0])
        ? 'apply_then_timeout'
        : null),
    },
  });

  await verifyLinkCode({
    api: apiFor(bridge), code: 'P4RT9Q', discordId: AHMET_DC, discordTag: 'ahmet#0', logger: SILENT,
  });

  const blindWrites = b.calls.filter((call) => LINK_WRITE_PATHS.has(call.path));
  assert.deepEqual(blindWrites, [], 'mc-a sonucu belirsizken mc-b\'ye yazma isteği gönderildi');
});

test('RB3 başarılı yanıtı ağda kaybolan teslim tekrarlandığında kod doğrulanır ve başarı gösterilir', async () => {
  const plugin = createFakePlugin({ instanceId: 'mc-live' });
  plugin.issueCode('00000000-0000-4000-8000-00000000000a', 'Ahmet', 'H8KM3W');
  const first = plugin.handle({
    method: 'POST',
    path: '/api/link/v2/verify',
    body: { code: 'H8KM3W', discordId: AHMET_DC, discordTag: 'ahmet#0', requestId: randomUUID() },
  });
  assert.equal(first.status, 200, 'ön koşul: ilk teslim eşlemeyi yapmış olmalı');
  plugin.calls.length = 0;

  const decision = await verifyLinkCode({
    api: apiFor(createFakeBridge([plugin])), code: ' h8km3w ', discordId: AHMET_DC, discordTag: 'ahmet#0', logger: SILENT,
  });

  assert.ok(
    plugin.calls.some((call) => call.path === '/api/link/verify' || call.path === '/api/link/v2/verify'),
    'tekrarlanan teslimde kod hiç doğrulanmadı',
  );
  assert.equal(decision.outcome, 'linked', 'aynı hesabın aynı kodla tekrarı idempotent başarı olmalı');
});

test('RB4 hedef instance dışından gelen iş sonucu kabul edilmez', async () => {
  bridgeQueue.reset();
  const pending = bridgeQueue.enqueue({
    method: 'POST', path: '/api/link/v2/verify', body: {}, targetInstance: 'mc-a',
  }, 3000);
  const poll = await fetch(`${base}/api/bridge/jobs?wait=1000`, { headers: { ...sign(''), 'X-Bridge-Instance': 'mc-a' } });
  const { jobs } = await poll.json();
  assert.equal(jobs.length, 1, 'ön koşul: iş hedef instance\'a teslim edilmeli');

  const forged = JSON.stringify({ jobId: jobs[0].jobId, status: 200, data: { from: 'mc-b' } });
  const wrong = await fetch(`${base}/api/bridge/jobs/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sign(forged), 'X-Bridge-Instance': 'mc-b' },
    body: forged,
  });
  const genuine = JSON.stringify({ jobId: jobs[0].jobId, status: 200, data: { from: 'mc-a' } });
  await fetch(`${base}/api/bridge/jobs/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...sign(genuine), 'X-Bridge-Instance': 'mc-a' },
    body: genuine,
  });
  const settled = await pending;

  assert.equal(wrong.status, 409, 'başka instance\'ın gönderdiği sonuç reddedilmeli');
  assert.deepEqual(settled.data, { from: 'mc-a' }, 'iş yalnız hedef instance\'ın sonucuyla tamamlanmalı');
});

test('RB5 kalıcı eşleme başarılıyken audit kaydı hatası kullanıcıya başarısızlık göstermez', async () => {
  bridgeQueue.reset();
  const plugin = createFakePlugin({ instanceId: 'mc-live' });
  plugin.issueCode('00000000-0000-4000-8000-00000000000a', 'Ahmet', 'M9QW2E');
  let polling = true;
  const loop = (async () => {
    while (polling) {
      const jobs = await bridgeQueue.takeJobs(50, { instanceId: 'mc-live', linkProtocol: 2 });
      for (const job of jobs) {
        const res = plugin.handle(job);
        bridgeQueue.completeJob(job.jobId, res.status, res.data);
      }
    }
  })();

  db.exec('DROP TABLE cases'); // bot audit yazımı artık hata verir
  const replies = [];
  const interaction = {
    user: { id: AHMET_DC, tag: 'ahmet#0', toString: () => `<@${AHMET_DC}>` },
    guild: null,
    client: { channels: { fetch: async () => null } },
    fields: { getTextInputValue: () => ' m9qw2e ' },
    deferred: false,
    replied: false,
    async deferReply() { this.deferred = true; },
    async editReply(payload) { replies.push(payload); },
    async followUp(payload) { replies.push(payload); },
  };

  let thrown = null;
  try {
    await componentHandlers['link:modal'](interaction);
  } catch (err) {
    thrown = err;
  } finally {
    polling = false;
    await loop;
  }

  assert.ok(plugin.linkByDiscord(AHMET_DC), 'ön koşul: eşleme plugin deposunda kalıcı olmalı');
  assert.equal(thrown, null, `başarılı eşleme sonrası yan işlem hatası akışı kırdı: ${thrown?.message}`);
  assert.ok(
    replies.some((reply) => /Hesap Bağlandı/.test(reply.embeds?.[0]?.data?.title ?? '')),
    'kalıcı eşleme yapılmışken kullanıcıya başarı gösterilmedi',
  );
});
