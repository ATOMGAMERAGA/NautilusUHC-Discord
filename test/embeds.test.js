import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret';
const dbFile = join(tmpdir(), `nautilus-embeds-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const {
  baseEmbed, okEmbed, errEmbed, warnEmbed, infoEmbed, neutralEmbed, emptyEmbed,
  brandFooter, classifyBridgeError, bridgeErrorEmbed, failureEmbed, fit, Colors, Limits, Brand,
} = await import('../src/embeds.js');
const { codeText, mentionUsers, clean } = await import('../src/util.js');

after(() => {
  try { rmSync(dbFile, { force: true }); rmSync(`${dbFile}-wal`, { force: true }); rmSync(`${dbFile}-shm`, { force: true }); } catch {}
});

/* ---------------- semantik renkler ---------------- */

test('semantik yapıcılar doğru rengi kullanır', () => {
  assert.equal(okEmbed('x').data.color, Colors.success);
  assert.equal(errEmbed('x').data.color, Colors.danger);
  assert.equal(warnEmbed('x').data.color, Colors.warn);
  assert.equal(infoEmbed('x').data.color, Colors.info);
  assert.equal(neutralEmbed('x').data.color, Colors.neutral);
  assert.equal(baseEmbed().data.color, Colors.brand, 'varsayılan renk marka rengidir');
});

test('başlık ve açıklama beraber verilebilir', () => {
  const e = okEmbed('Minecraft hesabın eşleştirildi.', '🔗 Hesap Bağlandı');
  assert.equal(e.data.title, '🔗 Hesap Bağlandı');
  assert.match(e.data.description, /eşleştirildi/);
});

/* ---------------- marka ---------------- */

test('her embed markalı altbilgi taşır, bağlam öne yazılır', () => {
  assert.equal(baseEmbed().data.footer.text, `${Brand.community} • ${Brand.domain}`);
  assert.equal(brandFooter('Sayfa 1/3').text, `Sayfa 1/3 • ${Brand.community}`);
  assert.equal(brandFooter('Sayfa 1/3', '24 kayıt').text,
    `Sayfa 1/3 • 24 kayıt • ${Brand.community}`);
  assert.ok((baseEmbed().data.footer.icon_url ?? baseEmbed().data.footer.iconURL).endsWith('nautilus-icon-mark.png'));
});

test('zaman damgası varsayılan değildir (ephemeral kartlarda gürültü yapmaz)', () => {
  assert.equal(okEmbed('x').data.timestamp, undefined);
  assert.ok(okEmbed('x').setTimestamp().data.timestamp, 'gerektiğinde eklenebilir');
});

/* ---------------- boş durumlar ---------------- */

test('emptyEmbed bağlamı ve sıradaki adımı gösterir', () => {
  const e = emptyEmbed('Aktif Maç Yok', 'Şu anda devam eden bir UHC maçı bulunmuyor.',
    'Sonraki maç saatlerini `/maç program` ile görebilirsin.');
  assert.equal(e.data.color, Colors.neutral);
  assert.match(e.data.description, /bulunmuyor/);
  assert.match(e.data.description, /maç program/);
});

/* ---------------- Discord limitleri ---------------- */

test('fit: limit aşan metin kırpılır, kısası dokunulmaz', () => {
  assert.equal(fit('kısa', 10), 'kısa');
  assert.equal(fit('a'.repeat(20), 10).length, 10);
  assert.ok(fit('a'.repeat(20), 10).endsWith('…'));
  assert.equal(fit(null, 10), null);
});

test('başlık/açıklama/alan limitleri embed üreticisinde zorlanır', () => {
  const e = baseEmbed()
    .setTitle('T'.repeat(400))
    .setDescription('D'.repeat(5000))
    .addFields({ name: 'N'.repeat(400), value: 'V'.repeat(2000) });
  assert.equal(e.data.title.length, Limits.title);
  assert.equal(e.data.description.length, Limits.description);
  assert.equal(e.data.fields[0].name.length, Limits.fieldName);
  assert.equal(e.data.fields[0].value.length, Limits.fieldValue);
});

test('25 alandan fazlası sessizce düşürülür (Discord reddetmez)', () => {
  const e = baseEmbed();
  for (let i = 0; i < 40; i++) e.addFields({ name: `n${i}`, value: `v${i}` });
  assert.equal(e.data.fields.length, Limits.fields);
});

test('boş alan değeri geçerli bir yer tutucuya çevrilir', () => {
  const e = baseEmbed().addFields({ name: 'Sebep', value: '' });
  assert.equal(e.data.fields[0].value, '—');
});

test('altbilgi metni de limite sığdırılır', () => {
  const e = baseEmbed().setFooter({ text: 'F'.repeat(3000) });
  assert.equal(e.data.footer.text.length, Limits.footer);
});

/* ---------------- köprü hatalarının sınıflandırılması ---------------- */

test('classifyBridgeError: HTTP durumları anlamlı sınıflara ayrılır', () => {
  assert.equal(classifyBridgeError({ status: 403 }).kind, 'permission');
  assert.equal(classifyBridgeError({ status: 404 }).kind, 'not_found');
  assert.equal(classifyBridgeError({ status: 409 }).kind, 'conflict');
  assert.equal(classifyBridgeError({ status: 429 }).kind, 'rate_limited');
  assert.equal(classifyBridgeError({ status: 422 }).kind, 'invalid');
  assert.equal(classifyBridgeError({ status: 500 }).kind, 'server_error');
  assert.equal(classifyBridgeError({ error: 'fetch failed' }).kind, 'unreachable');
});

test('classifyBridgeError: taşıma hata kodları status\'tan önce gelir', () => {
  // Bunların HTTP karşılığı yoktur; "kayıt bulunamadı" gibi yanlış bir anlama
  // düşerlerse kullanıcı hatayı kendi girdisinde arar.
  assert.equal(classifyBridgeError({ errorCode: 'plugin_not_connected' }).kind, 'not_connected');
  assert.equal(classifyBridgeError({ errorCode: 'bridge_misconfigured' }).kind, 'misconfigured');
  assert.equal(
    classifyBridgeError({ errorCode: 'multiple_plugin_instances' }).kind,
    'ambiguous_plugin_instance',
  );
  // Backend'den gelen gerçek HTTP kodları eskisi gibi sınıflanır.
  assert.equal(classifyBridgeError({ status: 404, errorCode: 'not_found' }).kind, 'not_found');
});

test('ham backend hatası kullanıcıya sızmaz', () => {
  const cases = [
    { ok: false, error: 'ECONNRESET http://10.0.0.4:25000/api/status' },
    { ok: false, status: 500, error: 'NullPointerException at nautilus.uhc.Bridge' },
    { ok: false, status: 404, error: 'player not found in table players' },
  ];
  for (const res of cases) {
    const e = bridgeErrorEmbed(res, { context: 'test' });
    const text = `${e.data.title} ${e.data.description}`;
    assert.doesNotMatch(text, /ECONNRESET|NullPointerException|http:|25000|table players/,
      'teknik ayrıntı kullanıcıya gösterilmemeli');
    assert.ok(e.data.title.length > 0 && e.data.description.length > 0);
    assert.equal(e.data.color, Colors.danger);
  }
});

test('failureEmbed teknik ayrıntı içermez ama yol gösterir', () => {
  const e = failureEmbed('Sorun sürerse `/destek aç` ile talep oluştur.');
  assert.match(e.data.description, /tekrar dene/);
  assert.match(e.data.description, /destek aç/);
});

/* ---------------- kullanıcı içeriği güvenliği ---------------- */

test('codeText: kod aralığını kıran karakterler temizlenir, ad okunur kalır', () => {
  assert.equal(codeText('Atom_57'), 'Atom_57', 'MC adları gereksiz kaçışla bozulmaz');
  assert.equal(codeText('a`b\\c'), 'abc');
  assert.equal(codeText(''), '—');
  assert.ok(codeText('x'.repeat(50), 20).endsWith('…'));
});

test('clean: markdown kaçışı kullanıcı metnini biçimi bozmadan taşır', () => {
  assert.equal(clean('**kalın**'), '\\*\\*kalın\\*\\*');
});

test('mentionUsers: yalnız adı geçen kullanıcılar etiketlenebilir', () => {
  assert.deepEqual(mentionUsers('a', 'b', 'a'), { parse: [], users: ['a', 'b'] });
  assert.deepEqual(mentionUsers([]), { parse: [], users: [] },
    'rol ve @everyone hiçbir zaman etiketlenmez');
});
