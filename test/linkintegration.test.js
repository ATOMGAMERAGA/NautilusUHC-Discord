import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

/**
 * UÇTAN UCA: bot HTTP köprüsü ↔ gerçek plugin sınıfları (JAR) + SQLite.
 *
 * plugin-patch/test/support/LinkBridgeHarness.java, Paper olmadan gerçek
 * LinkService/LinkBridgeApi ile bota HMAC imzalı uzun-yoklama yapar. Bot tarafı
 * gerçek httpserver + bridgequeue + mcapi + linkflow + linkadmin kullanır.
 *
 * Java gerektirir; `plugin-patch/integration.ps1` ortam değişkenlerini ayarlar.
 * Değişkenler yoksa test ATLANIR (npm test Docker/CI'da Java istemez).
 */

const JAVA = process.env.NAUTILUS_LINK_IT_JAVA;
const CLASSPATH = process.env.NAUTILUS_LINK_IT_CLASSPATH;
const enabled = Boolean(JAVA && CLASSPATH);
const skip = enabled ? false : 'NAUTILUS_LINK_IT_JAVA / NAUTILUS_LINK_IT_CLASSPATH yok (plugin-patch/integration.ps1 ile çalıştır)';

const SECRET = 'entegrasyon-bridge-secret-en-az-32-karakter';
process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = SECRET;
process.env.BRIDGE_ALLOW_LEGACY = '0';
const dbFile = join(tmpdir(), `nautilus-linkit-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const SILENT = { log() {}, warn() {}, error() {} };
const UUID_A = '00000000-0000-4000-8000-00000000000a';
const UUID_B = '00000000-0000-4000-8000-00000000000b';
const DC_A = '18446744073709551615';
const DC_B = '300000000000000002';

let mod;
let server;
let base;
const harnesses = new Set();

before(async () => {
  if (!enabled) return;
  const { createRequestHandler } = await import('../src/httpserver.js');
  const { bridgeQueue } = await import('../src/bridgequeue.js');
  const { createMcApi } = await import('../src/mcapi.js');
  const { verifyLinkCode } = await import('../src/linkflow.js');
  const { createLinkAdmin } = await import('../src/linkadmin.js');
  const { linkAdminPanels, db } = await import('../src/db.js');
  const { config } = await import('../src/config.js');
  mod = {
    bridgeQueue, createMcApi, verifyLinkCode, createLinkAdmin, linkAdminPanels, config, db,
  };
  server = createServer(createRequestHandler({ isReady: () => true, channels: { fetch: async () => null } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const harness of harnesses) await harness.quit();
  server?.close();
  mod?.bridgeQueue.reset();
  try {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true });
  } catch { /* Windows'ta açık dosya */ }
});

class Harness {
  constructor(instanceId) {
    this.instanceId = instanceId;
    this.events = [];
    this.waiters = [];
    this.stderr = [];
    this.proc = spawn(JAVA, ['-Dstdout.encoding=UTF-8', '-cp', CLASSPATH, 'LinkBridgeHarness', base, SECRET, instanceId], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise((resolve) => this.proc.on('exit', resolve));
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      this.events.push(event);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(event)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    });
    this.proc.stderr.on('data', (chunk) => this.stderr.push(String(chunk)));
    harnesses.add(this);
  }

  waitFor(predicate, timeoutMs = 30_000) {
    const found = this.events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          reject(new Error(`${this.instanceId}: olay beklenirken zaman aşımı; stderr=${this.stderr.join('').slice(-800)}`));
        }
      }, timeoutMs);
    });
  }

  send(command) {
    this.proc.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async ready() {
    await this.waitFor((e) => e.event === 'ready');
    return this;
  }

  async issue(uuid, name, { part = null, scoped = true } = {}) {
    const marker = this.events.length;
    this.send({
      cmd: 'issue', uuid, name, part, scoped,
    });
    const event = await this.waitFor((e) => e.event === 'issued' && e.uuid === uuid && this.events.indexOf(e) >= marker);
    return event.code;
  }

  async player(uuid, name) {
    this.send({ cmd: 'player', uuid, name });
    await this.waitFor((e) => e.event === 'player' && e.uuid === uuid);
  }

  async state(uuid) {
    const marker = this.events.length;
    this.send({ cmd: 'state', uuid });
    return this.waitFor((e) => e.event === 'state' && this.events.indexOf(e) >= marker);
  }

  async fault(fault) {
    const marker = this.events.length;
    this.send({ cmd: 'fault', ...fault });
    await this.waitFor((e) => e.event === 'fault' && this.events.indexOf(e) >= marker);
  }

  handled(path) {
    return this.events.filter((e) => e.event === 'handled' && e.path === path);
  }

  async quit() {
    if (!harnesses.has(this)) return;
    harnesses.delete(this);
    try {
      this.send({ cmd: 'quit' });
    } catch { /* süreç zaten kapanmış */ }
    await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (this.proc.exitCode === null) this.proc.kill();
  }
}

async function fresh(...instanceIds) {
  for (const harness of harnesses) await harness.quit();
  mod.bridgeQueue.reset();
  const started = instanceIds.map((id) => new Harness(id));
  await Promise.all(started.map((h) => h.ready()));
  return started;
}

function api() {
  return mod.createMcApi({
    queue: mod.bridgeQueue,
    cfg: {
      mcApiUrl: '', directFallbackDisabled: false, mcApiUrlError: null, bridgeSecret: SECRET,
    },
    logger: SILENT,
    readTimeoutMs: 5000,
    linkWriteTimeoutMs: 5000,
  });
}

const verify = (client, code, discordId) => mod.verifyLinkCode({
  api: client, code, discordId, discordTag: 'entegrasyon#0', logger: SILENT, retryDelayMs: 300,
});

test('I1 gerçek JAR + SQLite: iki hesap doğru çiftlerle bağlanır ve geri okunur', { skip }, async () => {
  const [live] = await fresh('mc-live');
  const client = api();
  const codeA = await live.issue(UUID_A, 'Ahmet');
  const codeB = await live.issue(UUID_B, 'Burak');
  assert.match(codeA, /^9D[2-9A-HJ-NP-Z]{6}$/, 'kapsamlı kod biçimi');
  const a = await verify(client, ` ${codeA.toLowerCase()} `, DC_A);
  const b = await verify(client, codeB, DC_B);
  assert.equal(a.outcome, 'linked', JSON.stringify(a.failure));
  assert.equal(b.outcome, 'linked', JSON.stringify(b.failure));
  assert.equal((await live.state(UUID_A)).discordId, DC_A, 'büyük Discord ID birebir saklanmalı');
  assert.equal((await live.state(UUID_B)).discordId, DC_B);
  assert.ok(live.handled('/api/link/v2/info').length >= 2, 'başarılar geri okunmalı');
});

test('I2 aynı kapsamı paylaşan iki bağımsız depoda kasıtlı aynı kod: hiçbir hesap eşlenmez', { skip }, async () => {
  const [b, a559] = await fresh('mc-b', 'mc-a-559');
  const client = api();
  const codeB = await b.issue(UUID_A, 'Ahmet', { part: 'K7QX4M' });
  const codeA = await a559.issue(UUID_B, 'Zeynep', { part: 'K7QX4M' });
  assert.equal(codeB, codeA, 'ön koşul: iki depoda birebir aynı kod');
  const d = await verify(client, codeB, DC_B);
  assert.equal(d.outcome, 'failed');
  assert.equal(d.failure.kind, 'code_conflict');
  assert.equal((await b.state(UUID_A)).linked, false);
  assert.equal((await a559.state(UUID_B)).linked, false);
  assert.equal(b.handled('/api/link/v2/verify').length + a559.handled('/api/link/v2/verify').length, 0,
    'çakışmada hiçbir depoya yazma gönderilmemeli');
});

test('I3 farklı kapsamlarda kod yalnız üreten sunucuya gider', { skip }, async () => {
  const [live, testServer] = await fresh('mc-live', 'mc-test');
  const client = api();
  const liveCode = await live.issue(UUID_A, 'CanliAhmet', { part: 'K7QX4M' });
  const testCode = await testServer.issue(UUID_B, 'TestZeynep', { part: 'K7QX4M' });
  assert.equal(liveCode.slice(2), testCode.slice(2), 'ön koşul: rastgele kısım aynı');
  const before = live.events.filter((e) => e.event === 'handled').length;
  const d = await verify(client, testCode, DC_B);
  assert.equal(d.outcome, 'linked', JSON.stringify(d.failure));
  assert.equal(d.instance, 'mc-test');
  assert.equal((await testServer.state(UUID_B)).discordId, DC_B);
  assert.equal(live.events.filter((e) => e.event === 'handled').length, before, 'diğer sunucuya iş gitmemeli');
  assert.equal((await live.state(UUID_A)).linked, false);
});

test('I4 kapsamsız eski kod iki depoda aynıysa salt-okunur yoklama çakışmayı yakalar', { skip }, async () => {
  const [one, two] = await fresh('mc-bir', 'mc-iki');
  const client = api();
  await one.issue(UUID_A, 'Bir', { part: 'P4RT9Q', scoped: false });
  await two.issue(UUID_B, 'Iki', { part: 'P4RT9Q', scoped: false });
  const d = await verify(client, 'p4rt9q', DC_A);
  assert.equal(d.failure?.kind, 'code_conflict');
  assert.equal(one.handled('/api/link/v2/probe').length, 1);
  assert.equal(two.handled('/api/link/v2/probe').length, 1);
});

test('I5 başarılı yanıt ağda kaybolursa aynı işlem uzlaştırılır; yazma tekrarlanmaz', { skip }, async () => {
  const [live] = await fresh('mc-live');
  const client = api();
  const code = await live.issue(UUID_A, 'Kayip');
  await live.fault({ dropResultFor: '/api/link/v2/verify' });
  const d = await verify(client, code, DC_A);
  assert.equal(d.outcome, 'linked', JSON.stringify(d.failure));
  assert.ok(live.events.some((e) => e.event === 'dropped'), 'ön koşul: yanıt düşürüldü');
  assert.equal(live.handled('/api/link/v2/verify').length, 1, 'doğrulama körlemesine tekrar gönderilmemeli');
  assert.ok(live.handled('/api/link/v2/operation').length >= 1);
});

test('I6 yönetim: isimle onaylı unlink, relink ve eski panelin yeni bağlantıyı silememesi', { skip }, async () => {
  const [live] = await fresh('mc-live');
  const client = api();
  await live.player(UUID_A, 'OfflineAli');
  assert.equal((await verify(client, await live.issue(UUID_A, 'OfflineAli'), DC_A)).outcome, 'linked');
  const roleId = mod.config.roles.admin;
  const admin = {
    id: '900000000000000001',
    tag: 'yetkili#0',
    client: {},
    member: { guild: { ownerId: 'x' }, roles: { cache: new Set([roleId]) } },
    resolveUser: async () => null,
  };
  const service = mod.createLinkAdmin({
    api: client, panels: mod.linkAdminPanels, effects: { enqueue: async () => {} }, cases: () => [], logger: SILENT,
  });
  const idOf = (payload, prefix) => payload.components.flatMap((r) => r.components)
    .find((b) => b.custom_id.startsWith(prefix))?.custom_id.split(':')[2];
  const bodyOf = (payload) => payload.embeds.map((e) => [e.data.title, e.data.description,
    ...(e.data.fields ?? []).map((f) => f.value)].join('\n')).join('\n');

  const panel = await service.prepareUnlink({ actor: admin, selector: 'name', value: 'offlineali', reason: 'entegrasyon' });
  assert.match(bodyOf(panel), new RegExp(UUID_A));
  const staleAfterRelink = await service.prepareUnlink({ actor: admin, selector: 'name', value: 'offlineali' });

  const removed = await service.confirmUnlink({ actor: admin, panelId: idOf(panel, 'linkadm:ok:') });
  assert.match(bodyOf(removed), /Bağlantı Kaldırıldı/);
  assert.equal((await live.state(UUID_A)).linked, false, 'iki taraf da bağlantısız');
  assert.equal((await verify(client, await live.issue(UUID_A, 'OfflineAli'), DC_A)).outcome, 'linked', 'yeniden eşleme');

  const stale = await service.confirmUnlink({ actor: admin, panelId: idOf(staleAfterRelink, 'linkadm:ok:') });
  assert.match(bodyOf(stale), /Kayıt Değişti/);
  assert.equal((await live.state(UUID_A)).linked, true, 'eski panel yeni bağlantıyı silmemeli');

  const history = await service.historyPayload({ actor: admin, selector: 'uuid', value: UUID_A });
  assert.match(bodyOf(history), /Kaldırıldı/);
  assert.match(bodyOf(history), /entegrasyon/);
});
