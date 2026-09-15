import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * HESAP BAĞLAMA (Minecraft ↔ Discord) — regresyon paketi.
 *
 * Sahadaki arıza: oyuncu MC'de `/link` ile kodu alıyor, Discord modalına DOĞRU
 * kodu giriyor, bot yine de "Kod geçersiz veya süresi dolmuş" diyordu. Önceki
 * ana nedenlerden biri bot'un HTTP 400/404 gördüğü her yanıtı "yanlış kod"
 * saymasıydı. Bu paket, yanlış uç/ayar hatalarının kod hatasına çevrilmemesini
 * kilitler.
 *
 * 1.2.2 ile değişen sözleşme (bkz. linkflow.js / linkrouting.js):
 *  - Çoklu instance'ta kod instance'lara sırayla YAZILMAZ ("ilk başarı" yanlış
 *    hesaba bağlayabiliyordu). Önce salt-okunur yoklama yapılır; tek sahip
 *    kanıtlanmadıkça hiçbir yere yazma isteği gitmez.
 *  - Discord hesabı zaten bağlı olsa da girilen kod doğrulanır; "zaten bağlı"
 *    kararı plugin'in atomik yanıtından gelir.
 *  - Başarı, doğrulama yanıtı ve ardından geri okunan kayıt aynı çifti
 *    gösterdiğinde sayılır.
 *
 * Buradaki testler akışın TAMAMINI (köprü durumu → plan → doğrulama → geri
 * okuma → sınıflandırma) sürer; Discord'a hiç ihtiyaç duymaz.
 */

process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret-çok-gizli';

const { createMcApi } = await import('../src/mcapi.js');
const { verifyLinkCode, classifyLinkFailure, normalizeLinkCode } = await import('../src/linkflow.js');
const { validateMcApiUrl, logConfigIssues } = await import('../src/config.js');
const { createFakePlugin, createFakeBridge, LINK_WRITE_PATHS } = await import('./support/fakeplugin.js');

const SECRET = process.env.BRIDGE_SECRET;
const CODE = 'A1B2C3';
const CFG = {
  mcApiUrl: '', directFallbackDisabled: false, mcApiUrlError: null, bridgeSecret: SECRET,
};

/** Tüm log satırlarını toplayan kayıt edici (sızıntı testleri bunu okur). */
function captureLogger() {
  const lines = [];
  const push = (...args) => lines.push(args.map(String).join(' '));
  return { log: push, warn: push, error: push, lines };
}

/**
 * Ters köprü kuyruğu taklidi (1.2.1 plugin gibi: instance protokol bildirmez).
 * `respond(job)` işi plugin gibi yanıtlar; alınan işler `jobs` dizisinde birikir.
 */
function fakeQueue({
  connected = true, instances = ['mc-live'], pollers = 1, respond,
} = {}) {
  const jobs = [];
  return {
    jobs,
    pluginConnected: () => connected,
    activeInstances: () => instances,
    routingAmbiguity: () => {
      const reason = instances.length > 1 ? 'instances' : (pollers > 1 ? 'concurrent_pollers' : null);
      return { ambiguous: reason !== null, reason, instances, pollers, peakPollers: pollers };
    },
    stats: () => ({ pollers, peakPollers: pollers, instances: instances.length }),
    enqueue: async (job) => {
      jobs.push(job);
      return respond(job);
    },
  };
}

/** linkStatus "bağlı değil", linkVerify verilen yanıtı döner. */
function verifyResponder(verifyResponse) {
  return (job) => (job.path.startsWith('/api/link/status')
    ? { status: 200, data: { linked: false } }
    : verifyResponse);
}

/** Test için hazır mcapi: bağlı tek instance + verilen doğrulama yanıtı. */
function apiWith(verifyResponse, opts = {}) {
  const logger = captureLogger();
  const queue = fakeQueue({ respond: verifyResponder(verifyResponse), ...opts });
  const api = createMcApi({ queue, cfg: CFG, logger });
  return { api, queue, logger };
}

/** Akışı koştur ve kararı dön. */
function run(api, logger, { code = CODE, discordId = '424242', discordTag = 'oyuncu' } = {}) {
  return verifyLinkCode({
    api, code, discordId, discordTag, logger, sleep: async () => {}, retryDelayMs: 0,
  });
}

/* ------------------------------------------------------------------ */
/* 1. Gerçekten yanlış kod — TEK "kod geçersiz" gösterilecek durum      */
/* ------------------------------------------------------------------ */

test('404 + invalid_code → kullanıcıya yanlış/süresi dolmuş kod mesajı', async () => {
  const { api, logger } = apiWith({ status: 404, data: { error: 'invalid_code' } });
  const d = await run(api, logger);
  assert.equal(d.outcome, 'failed');
  assert.equal(d.failure.kind, 'bad_code');
  assert.equal(d.failure.title, 'Kod Doğrulanamadı');
  assert.match(d.failure.description, /geçersiz veya süresi dolmuş/);
  assert.match(d.failure.description, /`\/link`/, 'yeni kod almanın yolu gösterilmeli');
});

test('404 + expired_code → yine yanlış/süresi dolmuş kod mesajı', async () => {
  const { api, logger } = apiWith({ status: 404, data: { error: 'expired_code' } });
  const d = await run(api, logger);
  assert.equal(d.failure.kind, 'bad_code');
});

/* ------------------------------------------------------------------ */
/* 2. Kök neden: 404/400 ARTIK "yanlış kod" demek DEĞİL                 */
/* ------------------------------------------------------------------ */

test('404 + not_found → köprü/uç yapılandırma hatası (kod hatası DEĞİL)', async () => {
  // Botun MC_API_URL'i kendi adresini gösterdiğinde botun kendi HTTP sunucusu
  // tam olarak bunu döner: 404 {"error":"not_found"}. Sahadaki arıza buydu.
  const { api, logger } = apiWith({ status: 404, data: { error: 'not_found' } });
  const d = await run(api, logger);
  assert.equal(d.outcome, 'failed');
  assert.equal(d.failure.kind, 'routing');
  assert.notEqual(d.failure.kind, 'bad_code');
  assert.equal(d.failure.title, 'Doğrulama Servisine Ulaşılamadı');
  assert.match(d.failure.description, /anlamına GELMEZ/);
});

test('400 + missing_fields → entegrasyon sözleşmesi hatası', async () => {
  const { api, logger } = apiWith({ status: 400, data: { error: 'missing_fields' } });
  const d = await run(api, logger);
  assert.equal(d.failure.kind, 'contract');
  assert.equal(d.failure.errorCode, 'missing_fields');
  assert.equal(d.failure.title, 'Doğrulama İsteği Reddedildi');
});

test('401 → yetkilendirme/secret uyumsuzluğu', async () => {
  const { api, logger } = apiWith({ status: 401, data: { error: 'unauthorized' } });
  const d = await run(api, logger);
  assert.equal(d.failure.kind, 'auth');
  assert.equal(d.failure.title, 'Köprü Yetkilendirmesi Reddedildi');
});

test('500 → sunucu hatası, kod hatası değil', async () => {
  const { api, logger } = apiWith({ status: 500, data: { error: 'internal_error' } });
  const d = await run(api, logger);
  assert.notEqual(d.failure.kind, 'bad_code');
  assert.match(d.failure.description, /anlamına gelmez/i);
});

test('409 → Discord hesabın zaten başka bir MC hesabına bağlı', async () => {
  const { api, logger } = apiWith({ status: 409, data: { error: 'already_linked' } });
  const d = await run(api, logger);
  assert.equal(d.failure.kind, 'already_linked_other');
  assert.match(d.failure.description, /başka bir Minecraft hesabına bağlı/);
});

test('gövdesiz 404 (ters vekil/yanlış servis) da kod hatası sayılmaz', async () => {
  const { api, logger } = apiWith({ status: 404, data: {} });
  const d = await run(api, logger);
  assert.equal(d.failure.kind, 'routing');
  assert.equal(d.failure.errorCode, 'http_404');
});

/* ------------------------------------------------------------------ */
/* 3. Köprü bağlı değil / yanlış yapılandırılmış                        */
/* ------------------------------------------------------------------ */

test('ters köprü bağlı değil + MC_API_URL boş → "plugin bağlı değil" ve HİÇ istek atılmaz', async () => {
  const logger = captureLogger();
  const queue = fakeQueue({
    connected: false,
    instances: [],
    respond: () => assert.fail('plugin bağlı değilken kuyruğa iş yazılmamalı'),
  });
  const api = createMcApi({ queue, cfg: CFG, logger });

  const d = await run(api, logger, { discordId: '1', discordTag: 't' });
  assert.equal(d.outcome, 'failed');
  assert.equal(d.failure.kind, 'not_connected');
  assert.equal(d.failure.errorCode, 'plugin_not_connected');
  assert.equal(d.failure.title, 'Minecraft Plugin Bağlantısı Yok');
  assert.equal(queue.jobs.length, 0, 'doğrulama çağrısı hiç yapılmamalı');
});

test('MC_API_URL botun kendi domaini → başlangıç doğrulaması hata verir, doğrudan yedek kapanır', () => {
  const v = validateMcApiUrl('https://bot.nautilusuhc.com', {
    port: 25000, botPublicUrl: 'https://bot.nautilusuhc.com',
  });
  assert.equal(v.selfLoop, true);
  assert.equal(v.code, 'mc_api_url_self_loop');
  assert.equal(v.url, '', 'geçersiz adres KULLANILMAZ (doğrudan yedek kapalı)');
  assert.match(v.error, /kendi/i);

  // Açılış logu: sorun sessiz kalmaz.
  const logger = captureLogger();
  const issues = logConfigIssues(logger, {
    mcApiUrlError: v.error, bridgeSecret: SECRET,
  });
  assert.equal(issues.length, 1);
  assert.match(logger.lines.join('\n'), /\[config\]/);
});

test('MC_API_URL botun kendi dinlediği loopback portu → döngü olarak yakalanır', () => {
  const v = validateMcApiUrl('http://127.0.0.1:25000', { port: 25000 });
  assert.equal(v.selfLoop, true);
  assert.equal(v.url, '');
});

test('MC_API_URL boş → outbound ters köprü modunda geçerli', () => {
  const v = validateMcApiUrl('', { port: 25000, botPublicUrl: 'https://bot.nautilusuhc.com' });
  assert.equal(v.error, null);
  assert.equal(v.url, '');
});

test('MC_API_URL mutlak olmayan / yanlış şemalı adres reddedilir', () => {
  for (const bad of ['1.2.3.4:25000', 'bot.nautilusuhc.com', '/api', 'ftp://1.2.3.4']) {
    const v = validateMcApiUrl(bad, { port: 25000 });
    assert.ok(v.error, `${bad} reddedilmeli`);
    assert.equal(v.url, '', `${bad} kullanılmamalı`);
  }
});

test('geçerli MC_API_URL kabul edilir (sondaki eğik çizgi kırpılır)', () => {
  const v = validateMcApiUrl('http://10.0.0.5:25000/', { port: 25000, botPublicUrl: 'https://bot.nautilusuhc.com' });
  assert.equal(v.error, null);
  assert.equal(v.url, 'http://10.0.0.5:25000');
});

test('MC_API_URL geçersizken doğrulama sahte "kod geçersiz" değil ayar hatası gösterir', async () => {
  const logger = captureLogger();
  const queue = fakeQueue({ connected: false, instances: [], respond: () => assert.fail('istek atılmamalı') });
  const cfg = {
    mcApiUrl: '',
    directFallbackDisabled: true,
    mcApiUrlError: 'MC_API_URL botun KENDİ adresini gösteriyor.',
    bridgeSecret: SECRET,
  };
  const api = createMcApi({ queue, cfg, logger });
  const d = await run(api, logger, { discordId: '1', discordTag: 't' });
  assert.equal(d.failure.kind, 'misconfigured');
  assert.equal(d.failure.errorCode, 'bridge_misconfigured');
  assert.equal(queue.jobs.length, 0);
});

/* ------------------------------------------------------------------ */
/* 4. Birden fazla plugin instance                                      */
/* ------------------------------------------------------------------ */

const writesOf = (plugin) => plugin.calls.filter((call) => LINK_WRITE_PATHS.has(call.path));

test('iki instance\'ta kapsamsız kod: salt-okunur yoklama yalnız gerçek sahibe yazar', async () => {
  const eski = createFakePlugin({ instanceId: 'mc-eski' });
  const canli = createFakePlugin({ instanceId: 'mc-canli' });
  canli.issueCode('00000000-0000-4000-8000-000000000001', 'Oyuncu1', CODE);
  const logger = captureLogger();
  const api = createMcApi({ queue: createFakeBridge([eski, canli]), cfg: CFG, logger });

  const d = await run(api, logger, { discordId: '424242424242424242' });
  assert.equal(d.outcome, 'linked');
  assert.equal(d.mc, 'Oyuncu1');
  assert.deepEqual(eski.calls.map((c) => c.path), ['/api/link/v2/probe'],
    'kodu tutmayan instance yalnız salt-okunur yoklanmalı');
  assert.deepEqual(writesOf(canli).map((c) => c.targetInstance), ['mc-canli'],
    'yazma yalnız sahip instance\'a ve hedefli gitmeli');
});

test('hiçbir instance kodu tutmuyorsa kod geçersizdir ve hiçbir yere yazılmaz', async () => {
  const a = createFakePlugin({ instanceId: 'mc-1' });
  const b = createFakePlugin({ instanceId: 'mc-2' });
  const logger = captureLogger();
  const api = createMcApi({ queue: createFakeBridge([a, b]), cfg: CFG, logger });
  const d = await run(api, logger);
  assert.equal(d.outcome, 'failed');
  assert.equal(d.failure.kind, 'bad_code');
  assert.deepEqual([...writesOf(a), ...writesOf(b)], []);
});

test('bir instance yoklamaya yanıt vermezse tek sahip kanıtlanamaz: kod hatası değil, yazma yok', async () => {
  const yanitsiz = createFakePlugin({ instanceId: 'mc-yanitsiz' });
  const diger = createFakePlugin({ instanceId: 'mc-diger' });
  diger.issueCode('00000000-0000-4000-8000-000000000002', 'Oyuncu2', CODE);
  const logger = captureLogger();
  const bridge = createFakeBridge([yanitsiz, diger], {
    faults: { onJob: (job, target) => (target.instanceId === 'mc-yanitsiz' ? 'timeout' : null) },
  });
  const api = createMcApi({ queue: bridge, cfg: CFG, logger });

  const d = await run(api, logger);
  assert.equal(d.outcome, 'failed');
  assert.equal(d.failure.kind, 'unreachable');
  assert.deepEqual([...writesOf(yanitsiz), ...writesOf(diger)], [],
    'yanıt vermeyen depo da aynı kodu tutuyor olabilir; hiçbir yere yazılmamalı');
});

test('çoklu instance\'ta 1.2.1 plugin varsa kod hedeflenemez ve iş gönderilmez', async () => {
  const logger = captureLogger();
  const queue = fakeQueue({
    instances: ['mc-1', 'mc-2'],
    respond: () => assert.fail('protokol 2 olmayan çoklu kurulumda iş gönderilmemeli'),
  });
  const api = createMcApi({ queue, cfg: CFG, logger });
  const d = await run(api, logger);
  assert.equal(d.failure.kind, 'ambiguous_plugin_instance');
  assert.equal(queue.jobs.length, 0);
});

test('iki instance yalnız yan etkili çağrıları bloklar; okuma çağrıları çalışır', async () => {
  const logger = captureLogger();
  const queue = fakeQueue({
    instances: ['mc-canli', 'mc-test'],
    respond: () => ({ status: 200, data: { online: 5 } }),
  });
  const api = createMcApi({ queue, cfg: CFG, logger });

  const status = await api.status();
  assert.equal(status.ok, true, 'salt-okunur istek belirsizlikten etkilenmez');

  const verify = await api.linkVerify(CODE, '1', 't');
  assert.equal(verify.ok, false);
  assert.equal(verify.errorCode, 'multiple_plugin_instances');
});

test('tek ve açık kimlikli instance varken doğrulama işi o instance\'a hedeflenir', async () => {
  const { api, queue } = apiWith({ status: 200, data: { mc: 'Oyuncu1' } }, { instances: ['mc-canli'] });
  await api.linkVerify(CODE, '1', 't');
  assert.equal(queue.jobs.at(-1).targetInstance, 'mc-canli');
});

test('eski (kimliksiz) plugin hedefsiz iş alır — geriye uyumluluk', async () => {
  const { api, queue } = apiWith({ status: 200, data: { mc: 'Oyuncu1' } }, { instances: ['ip:10.0.0.9'] });
  await api.linkVerify(CODE, '1', 't');
  assert.equal(queue.jobs.at(-1).targetInstance, null, 'eski plugin hedefli iş anlamaz');
});

test('ters vekil arkasında tek kimlik + iki eşzamanlı yoklama da bloklanır', async () => {
  // Sahadaki gerçek durum: iki plugin Dokploy proxy'sinin arkasında, ikisi de
  // 'ip:172.18.0.1' görünüyor. Kimlik sayımı 1 der; eşzamanlı yoklama sayısı
  // belirsizliği yine de yakalamalı, yoksa doğrulama rastgele sunucuya gider.
  const logger = captureLogger();
  const queue = fakeQueue({
    instances: ['ip:172.18.0.1'],
    pollers: 2,
    respond: () => assert.fail('belirsizlik varken iş kuyruğa YAZILMAMALI'),
  });
  const api = createMcApi({ queue, cfg: CFG, logger });

  const d = await run(api, logger, { discordId: '1', discordTag: 't' });
  assert.equal(d.failure.kind, 'ambiguous_plugin_instance');
  assert.equal(queue.jobs.length, 0);
  assert.match(logger.lines.join('\n'), /uzun-yoklama/, 'gerekçe logda açıkça yazmalı');
});

test('başka kimlikler varken yinelenen instance kimliği de doğrulamayı bloklar', async () => {
  const logger = captureLogger();
  const api = {
    bridgeStatus: () => ({
      ok: true,
      transport: 'reverse',
      instances: ['mc-a', 'mc-b'],
      routing: { reason: 'duplicate_instance', duplicateInstances: ['mc-b'] },
    }),
    bridgeSnapshot: () => ({ pollers: 3, peakPollers: 3, instances: 2 }),
    linkStatus: async () => assert.fail('belirsiz instance varken sorgu atılmamalı'),
    linkVerify: async () => assert.fail('belirsiz instance varken doğrulama atılmamalı'),
  };

  const d = await run(api, logger, { discordId: '1', discordTag: 't' });
  assert.equal(d.failure.kind, 'ambiguous_plugin_instance');
});

test('aynı instance\'ın ardışık farklı pollId\'leri çoklu plugin alarmı üretmez', async () => {
  const logger = captureLogger();
  // Tek plugin her uzun-yoklamada yeni pollId alır; süreç kimliği aynı kaldığı
  // sürece bu normaldir ve önceki teşhisteki gibi çoklu plugin sayılamaz.
  const api = {
    bridgeStatus: () => ({ ok: true, transport: 'reverse', instances: ['mc-canli'], routing: {} }),
    bridgeSnapshot: () => ({ pollers: 1, peakPollers: 1, instances: 1 }),
    linkStatus: async () => ({
      ok: true, linked: false, claimedBy: 'mc-canli', pollId: 'aaaa1111',
    }),
    linkVerify: async () => ({
      ok: false, status: 404, errorCode: 'invalid_code', claimedBy: 'mc-canli',
      pollId: 'bbbb2222', transport: 'reverse',
    }),
  };
  const d = await run(api, logger, { discordId: '1', discordTag: 't' });
  assert.equal(d.failure.kind, 'bad_code');
  const logs = logger.lines.join('\n');
  assert.doesNotMatch(logs, /FARKLI plugin/);
  assert.match(logs, /pollers=1/, 'köprü anlık durumu yine loglanmalı');
});

/* ------------------------------------------------------------------ */
/* 5. Başarılı akış + sözleşme                                          */
/* ------------------------------------------------------------------ */

test('başarılı doğrulamada {code, discordId, discordTag} eksiksiz aktarılır ve kayıt geri okunur', async () => {
  const logger = captureLogger();
  const queue = fakeQueue({
    respond: (job) => (job.path.startsWith('/api/link/status')
      ? { status: 200, data: { linked: true, mc: 'Oyuncu1', discordId: '424242' } }
      : { status: 200, data: { mc: 'Oyuncu1' } }),
  });
  const api = createMcApi({ queue, cfg: CFG, logger });
  const d = await run(api, logger, { code: '  a1b2c3  ', discordId: '424242', discordTag: 'oyuncu#0' });

  assert.equal(d.outcome, 'linked');
  assert.equal(d.mc, 'Oyuncu1');

  const job = queue.jobs.find((j) => j.path === '/api/link/verify');
  assert.ok(job, 'doğrulama isteği gönderilmeli');
  assert.equal(job.method, 'POST');
  assert.deepEqual(job.body, { code: 'A1B2C3', discordId: '424242', discordTag: 'oyuncu#0' });
  const readback = queue.jobs.find((j) => j.path.startsWith('/api/link/status'));
  assert.ok(readback, 'başarı, aynı instance\'tan geri okunan kayıtla doğrulanmalı');
  assert.equal(readback.targetInstance, 'mc-live');
});

test('doğrulama başarılı dese de geri okunan kayıt bağlı değilse başarı gösterilmez', async () => {
  const { api, logger } = apiWith({ status: 200, data: { mc: 'Oyuncu1' } });
  const d = await run(api, logger);
  assert.equal(d.outcome, 'failed');
  assert.equal(d.failure.kind, 'state_changed');
});

test('kod trim + upper ile normalize edilir', () => {
  assert.equal(normalizeLinkCode('  a1b2c3 '), 'A1B2C3');
  assert.equal(normalizeLinkCode(undefined), '');
});

test('Discord hesabı zaten bağlı olsa da girilen kod doğrulanır; başka hesabın kodu 409 ile reddedilir', async () => {
  const logger = captureLogger();
  const queue = fakeQueue({
    respond: (job) => (job.path.startsWith('/api/link/status')
      ? { status: 200, data: { linked: true, mc: 'EskiOyuncu' } }
      : { status: 409, data: { error: 'discord_already_linked' } }),
  });
  const api = createMcApi({ queue, cfg: CFG, logger });

  const d = await run(api, logger, { discordId: '1', discordTag: 't' });
  assert.equal(d.outcome, 'failed');
  assert.equal(d.failure.kind, 'already_linked_other');
  const verifyJob = queue.jobs.find((j) => j.path === '/api/link/verify');
  assert.ok(verifyJob, 'kod doğrulanmadan "zaten bağlı" denmemeli');
  assert.equal(verifyJob.targetInstance, 'mc-live', 'doğrulama tek instance\'a hedeflenmeli');
});

test('aynı Discord ve kod için eşzamanlı modal teslimleri tek doğrulamada birleşir', async () => {
  let finishVerify;
  const verifyGate = new Promise((resolve) => { finishVerify = resolve; });
  let verifyCalls = 0;
  const api = {
    bridgeStatus: () => ({
      ok: true, transport: 'reverse', instances: ['mc-live'],
      routing: { reason: 'single_instance' },
    }),
    bridgeSnapshot: () => ({ pollers: 1, peakPollers: 1, instances: 1 }),
    linkStatus: async () => ({ ok: true, linked: false }),
    linkVerify: async () => {
      verifyCalls += 1;
      await verifyGate;
      return { ok: true, status: 200, mc: 'Oyuncu1', correlationId: 'test-cid' };
    },
  };

  const first = run(api, captureLogger(), { discordId: '424242', discordTag: 'oyuncu#0' });
  const duplicate = run(api, captureLogger(), {
    code: ` ${CODE.toLowerCase()} `, discordId: '424242', discordTag: 'oyuncu#0',
  });

  await new Promise((resolve) => setImmediate(resolve));
  const callsBeforeRelease = verifyCalls;
  finishVerify();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

  assert.equal(callsBeforeRelease, 1, 'plugin yalnız bir kez doğrulanmalı');
  assert.deepEqual(duplicateResult, firstResult, 'yinelenen teslim aynı sonucu paylaşmalı');
});

/* ------------------------------------------------------------------ */
/* 6. Gözlemlenebilirlik ve sızıntı                                     */
/* ------------------------------------------------------------------ */

test('log satırı korelasyon kimliği, taşıma, yol, status ve hata kodu taşır', async () => {
  const { api, logger } = apiWith({ status: 404, data: { error: 'not_found' } });
  await run(api, logger);
  const line = logger.lines.find((l) => l.includes('/api/link/verify'));
  assert.ok(line, 'doğrulama isteği loglanmalı');
  assert.match(line, /\[mcapi\]/);
  assert.match(line, /reverse/, 'taşıma türü görünmeli');
  assert.match(line, /404/, 'HTTP status görünmeli');
  assert.match(line, /not_found/, 'backend hata kodu görünmeli');
  assert.match(line, /\d+ms/, 'süre görünmeli');
  assert.ok(logger.lines.some((l) => /\[link\] rid=[0-9a-f-]{36} stage=commit/.test(l)),
    'bot akışı işlem kimliği ve aşamayla loglanmalı');
});

test('kod, secret ve sorgu dizesi HİÇBİR logda görünmez', async () => {
  for (const response of [
    { status: 200, data: { mc: 'Oyuncu1' } },
    { status: 404, data: { error: 'invalid_code' } },
    { status: 401, data: { error: 'unauthorized' } },
  ]) {
    const { api, logger } = apiWith(response);
    await run(api, logger, { code: CODE, discordId: '424242', discordTag: 'oyuncu#0' });
    const logs = logger.lines.join('\n');
    assert.ok(!logs.includes(CODE), `link kodu loglanmamalı: ${logs}`);
    assert.ok(!logs.includes(SECRET), 'BRIDGE_SECRET loglanmamalı');
    assert.ok(!logs.includes('discord=424242'), 'sorgu dizesi loglanmamalı');
  }
});

test('köprü bağlı değilken de kod loglanmaz', async () => {
  const logger = captureLogger();
  const queue = fakeQueue({ connected: false, instances: [], respond: () => ({ status: 200, data: {} }) });
  const api = createMcApi({ queue, cfg: CFG, logger });
  await run(api, logger, { discordId: '1', discordTag: 't' });
  assert.ok(!logger.lines.join('\n').includes(CODE));
});

/* ------------------------------------------------------------------ */
/* 7. Sınıflandırıcının kendisi                                         */
/* ------------------------------------------------------------------ */

test('sınıflandırma: status tek başına asla "yanlış kod" üretmez', () => {
  for (const status of [400, 404, 401, 403, 409, 429, 500, 502, 503]) {
    const info = classifyLinkFailure({ status, errorCode: `http_${status}` });
    assert.notEqual(info.kind, 'bad_code', `${status} tek başına kod hatası sayılmamalı`);
  }
  // Yalnız açık backend kodu "yanlış kod" der.
  assert.equal(classifyLinkFailure({ status: 404, errorCode: 'invalid_code' }).kind, 'bad_code');
  assert.equal(classifyLinkFailure({ status: 400, errorCode: 'expired_code' }).kind, 'bad_code');
});

test('sınıflandırma: zaman aşımı, ulaşılamama ve depo hatası kod hatası değildir', () => {
  for (const errorCode of ['bridge_timeout', 'bridge_unreachable', 'bad_gateway_response', 'store_unavailable']) {
    const info = classifyLinkFailure({ errorCode });
    assert.notEqual(info.kind, 'bad_code');
    assert.match(info.description, /anlamına gelmez/i);
  }
});

test('sınıflandırma: kullanıcıya ham teknik metin veya secret gösterilmez', () => {
  const info = classifyLinkFailure({
    status: 500,
    errorCode: 'internal_error',
    error: `Bearer ${SECRET} → http://10.0.0.5:25000/api/link/verify patladı`,
  });
  assert.ok(!info.description.includes(SECRET));
  assert.ok(!info.description.includes('10.0.0.5'));
  assert.ok(!info.description.includes('Bearer'));
});
