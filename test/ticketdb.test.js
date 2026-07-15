import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret';
process.env.MC_API_URL = '';
const dbFile = join(tmpdir(), `nautilus-ticketdb-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const {
  db, ticketsV2, ticketNotes, ticketMessages, ticketBlacklist, pendingTaskCount,
} = await import('../src/db.js');
const { renderTranscript, findOrphanTickets, applyTransition } = await import('../src/ticketcore.js');

process.on('exit', () => {
  try { rmSync(dbFile, { force: true }); rmSync(`${dbFile}-wal`, { force: true }); rmSync(`${dbFile}-shm`, { force: true }); } catch {}
});

/* ---------------- migration ---------------- */

test('migration v3 taze veritabanına uygulanır (tablolar + sürüm kaydı)', () => {
  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
    .map((r) => r.version);
  assert.ok(versions.includes(3), `v3 uygulanmalıydı, mevcut: ${versions}`);
  for (const table of ['tickets_v2', 'ticket_notes', 'ticket_messages', 'ticket_blacklist']) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
    assert.ok(row, `${table} tablosu oluşmalıydı`);
  }
});

test('pendingTaskCount çalışır', () => {
  assert.equal(typeof pendingTaskCount(), 'number');
});

/* ---------------- yaşam döngüsü ---------------- */

test('talep yaşam döngüsü: aç → üstlen → not → kapat → puanla → yeniden aç', () => {
  const id = ticketsV2.create({
    userId: 'opener', type: 'teknik', subject: 'Giriş sorunu', description: 'Sunucuya giremiyorum',
  });
  assert.ok(Number.isInteger(id) && id > 0);
  ticketsV2.setChannel(id, 'chan-1');

  let t = ticketsV2.get(id);
  assert.equal(t.status, 'open');
  assert.equal(t.priority, 'normal');
  assert.equal(t.reopen_count, 0);
  assert.equal(t.satisfaction, null);
  assert.equal(ticketsV2.getByChannel('chan-1').id, id);
  assert.equal(ticketsV2.openByUser('opener').length, 1);

  // üstlen + ilk yanıt
  ticketsV2.claim(id, 'staff1');
  ticketsV2.setFirstResponse(id, 111_222);
  ticketsV2.setFirstResponse(id, 999_999); // ikinci yazım etkisiz
  t = ticketsV2.get(id);
  assert.equal(t.assignee_id, 'staff1');
  assert.ok(t.claimed_at > 0);
  assert.equal(t.first_response_at, 111_222);

  // öncelik
  ticketsV2.setPriority(id, 'urgent');
  assert.equal(ticketsV2.get(id).priority, 'urgent');

  // beklet / devam (durum makinesi üzerinden)
  const hold = applyTransition(ticketsV2.get(id), 'pending');
  assert.equal(hold.ok, true);
  ticketsV2.setStatus(id, 'pending');
  assert.equal(ticketsV2.get(id).status, 'pending');
  ticketsV2.setStatus(id, 'open');

  // not
  ticketNotes.add(id, 'staff1', 'Kullanıcıyla konuşuldu');
  ticketNotes.add(id, 'staff2', 'IP sorunu olabilir');
  assert.equal(ticketNotes.of(id).length, 2);
  assert.equal(ticketNotes.of(id)[0].note, 'Kullanıcıyla konuşuldu');

  // kapat
  ticketsV2.close(id, { closedBy: 'staff1', reason: 'çözüldü' });
  t = ticketsV2.get(id);
  assert.equal(t.status, 'closed');
  assert.equal(t.closed_by, 'staff1');
  assert.equal(t.close_reason, 'çözüldü');
  assert.ok(t.closed_at > 0);
  assert.equal(ticketsV2.getByChannel('chan-1'), undefined); // kapalı talep kanal eşleşmesinden düşer
  assert.equal(t.channel_id, 'chan-1'); // ama kanal id'si denetim için satırda kalır

  // puanla (tek seferlik)
  assert.equal(ticketsV2.rate(id, 5), true);
  assert.equal(ticketsV2.rate(id, 1), false);
  assert.equal(ticketsV2.get(id).satisfaction, 5);

  // yeniden aç
  const tr = applyTransition(ticketsV2.get(id), 'open');
  assert.equal(tr.ok, true);
  ticketsV2.reopen(id, 'chan-2');
  t = ticketsV2.get(id);
  assert.equal(t.status, 'open');
  assert.equal(t.channel_id, 'chan-2');
  assert.equal(t.reopen_count, 1);
  assert.equal(t.closed_at, null);
  assert.equal(t.close_reason, null);
  assert.equal(t.satisfaction, 5); // puan tarihsel olarak kalır

  // temizlik: sonraki testler için kapat
  ticketsV2.close(id, { closedBy: 'staff1', reason: 'test bitti' });
});

test('listByStatus ve openCount', () => {
  const a = ticketsV2.create({ userId: 'la', type: 'genel', subject: 'A' });
  const b = ticketsV2.create({ userId: 'lb', type: 'genel', subject: 'B' });
  ticketsV2.setStatus(b, 'pending');
  assert.ok(ticketsV2.openCount() >= 2);
  assert.ok(ticketsV2.listByStatus('open').some((t) => t.id === a));
  assert.ok(ticketsV2.listByStatus('pending').some((t) => t.id === b));
  assert.ok(ticketsV2.listByStatus(null, 50).length >= 2);
  ticketsV2.close(a, {}); ticketsV2.close(b, {});
});

test('lastCreatedAt cooldown için son açılışı verir', () => {
  assert.equal(ticketsV2.lastCreatedAt('hiç-yok'), null);
  const id = ticketsV2.create({ userId: 'cd-user', type: 'genel', subject: 'x' });
  const t = ticketsV2.get(id);
  assert.equal(ticketsV2.lastCreatedAt('cd-user'), t.created_at);
  ticketsV2.close(id, {});
});

/* ---------------- kara liste ---------------- */

test('kara liste ekle/güncelle/çıkar', () => {
  assert.equal(ticketBlacklist.get('bad'), undefined);
  ticketBlacklist.add('bad', 'spam', 'mod1');
  const row = ticketBlacklist.get('bad');
  assert.equal(row.reason, 'spam');
  assert.equal(row.added_by, 'mod1');
  // aynı kullanıcı tekrar eklenirse sebep güncellenir (PK çakışması patlamaz)
  ticketBlacklist.add('bad', 'küfür', 'mod2');
  assert.equal(ticketBlacklist.get('bad').reason, 'küfür');
  assert.ok(ticketBlacklist.all().some((r) => r.user_id === 'bad'));
  assert.equal(ticketBlacklist.remove('bad'), true);
  assert.equal(ticketBlacklist.remove('bad'), false);
  assert.equal(ticketBlacklist.get('bad'), undefined);
});

/* ---------------- reconciliation ---------------- */

test('reconciliation: kanalı silinmiş talepler kapalıya çekilir', () => {
  const keep = ticketsV2.create({ userId: 'r1', type: 'genel', subject: 'kalır' });
  const orphan = ticketsV2.create({ userId: 'r2', type: 'genel', subject: 'öksüz' });
  ticketsV2.setChannel(keep, 'var-olan-kanal');
  ticketsV2.setChannel(orphan, 'silinen-kanal');

  const ids = findOrphanTickets(ticketsV2.active(), ['var-olan-kanal']);
  assert.ok(ids.includes(orphan));
  assert.ok(!ids.includes(keep));

  for (const id of ids) assert.equal(ticketsV2.markOrphanClosed(id), true);
  const t = ticketsV2.get(orphan);
  assert.equal(t.status, 'closed');
  assert.equal(t.close_reason, 'kanal silinmiş (reconciliation)');
  // ikinci çağrı etkisiz (idempotent)
  assert.equal(ticketsV2.markOrphanClosed(orphan), false);
  assert.equal(ticketsV2.get(keep).status, 'open');
  ticketsV2.close(keep, {});
});

/* ---------------- tam transcript (>100 mesaj) ---------------- */

test('transcript deposu 100 mesaj sınırını aşar: 150 mesajın tamamı saklanır ve işlenir', () => {
  const id = ticketsV2.create({ userId: 'çok-yazan', type: 'genel', subject: 'Uzun konuşma' });
  ticketsV2.setChannel(id, 'chan-150');
  const base = Date.now();
  for (let i = 1; i <= 150; i += 1) {
    ticketMessages.add(id, {
      messageId: `m${i}`,
      authorId: i % 2 ? 'çok-yazan' : 'staff',
      authorTag: i % 2 ? 'Üye#1' : 'Yetkili#2',
      content: `mesaj numarası ${i} — şğüçöı`,
      attachments: i === 150 ? [{ name: 'son.png', url: 'https://cdn.example/son.png' }] : [],
      createdAt: base + i * 1000,
    });
  }
  assert.equal(ticketMessages.count(id), 150);
  const rows = ticketMessages.of(id);
  assert.equal(rows.length, 150);
  assert.equal(ticketMessages.lastAt(id), base + 150 * 1000);

  const transcript = renderTranscript(ticketsV2.get(id), rows);
  for (const n of [1, 42, 100, 101, 149, 150]) {
    assert.ok(transcript.includes(`mesaj numarası ${n} —`), `mesaj ${n} transcriptte olmalı`);
  }
  assert.match(transcript, /Mesaj sayısı: 150/);
  assert.match(transcript, /https:\/\/cdn\.example\/son\.png/);
  assert.match(transcript, /şğüçöı/);
  ticketsV2.close(id, {});
});

/* ---------------- eski tickets tablosu migrasyonu ---------------- */

test('eski tickets tablosu boşsa tickets_v2 kopyasız kalır (migration SQL güvenli)', () => {
  // Taze DB'de eski `tickets` tablosu boştu; migration INSERT..SELECT hata vermeden geçti.
  const legacyCount = db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
  const migrated = db.prepare("SELECT COUNT(*) AS n FROM tickets_v2 WHERE type = 'genel' AND subject IS NULL AND description IS NULL AND channel_id LIKE '%legacy%'").get().n;
  assert.equal(legacyCount, 0);
  assert.equal(migrated, 0);
});
