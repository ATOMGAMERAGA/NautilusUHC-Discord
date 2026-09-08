import { test } from 'node:test';
import assert from 'node:assert/strict';

// ticketcore.js bağımlılıksızdır — discord.js, db veya env GEREKMEZ.
import {
  STATUSES, PRIORITIES, canTransition, applyTransition, nextPriority,
  slaTargetMinutes, slaState, DEFAULT_SLA_MINUTES,
  maskSecrets, renderTranscript, checkOpenAllowed, findOrphanTickets,
  TICKET_TYPES, ticketTypeLabel,
} from '../src/ticketcore.js';

/* ---------------- durum makinesi ---------------- */

test('geçerli geçişler: open→pending/closed, pending→open/closed, closed→open', () => {
  assert.ok(canTransition('open', 'pending'));
  assert.ok(canTransition('open', 'closed'));
  assert.ok(canTransition('pending', 'open'));
  assert.ok(canTransition('pending', 'closed'));
  assert.ok(canTransition('closed', 'open'));
});

test('geçersiz geçişler reddedilir', () => {
  assert.equal(canTransition('closed', 'pending'), false);
  assert.equal(canTransition('open', 'open'), false);
  assert.equal(canTransition('pending', 'pending'), false);
  assert.equal(canTransition('closed', 'closed'), false);
  assert.equal(canTransition('open', 'banana'), false);

  const r = applyTransition({ status: 'closed', reopen_count: 0 }, 'pending');
  assert.equal(r.ok, false);
  assert.match(r.error, /Geçersiz durum geçişi/);

  const r2 = applyTransition({ status: 'open' }, 'yok');
  assert.equal(r2.ok, false);
});

test('applyTransition: yeniden açma reopen_count artırır ve kapanış alanlarını sıfırlar', () => {
  const ticket = {
    status: 'closed', reopen_count: 1, closed_at: 123, closed_by: 'mod', close_reason: 'çözüldü',
  };
  const r = applyTransition(ticket, 'open');
  assert.equal(r.ok, true);
  assert.equal(r.changes.status, 'open');
  assert.equal(r.changes.reopen_count, 2);
  assert.equal(r.changes.closed_at, null);
  assert.equal(r.changes.closed_by, null);
  assert.equal(r.changes.close_reason, null);
  // girdi nesnesi değişmedi
  assert.equal(ticket.status, 'closed');
  assert.equal(ticket.reopen_count, 1);
});

test('applyTransition: normal geçişler reopen_count değiştirmez', () => {
  const r = applyTransition({ status: 'open', reopen_count: 3 }, 'pending');
  assert.equal(r.ok, true);
  assert.equal(r.changes.reopen_count, undefined);
});

test('öncelik döngüsü low→normal→high→urgent→low', () => {
  assert.equal(nextPriority('low'), 'normal');
  assert.equal(nextPriority('normal'), 'high');
  assert.equal(nextPriority('high'), 'urgent');
  assert.equal(nextPriority('urgent'), 'low');
});

test('sabitler beklenen kümeler', () => {
  assert.deepEqual(STATUSES, ['open', 'pending', 'closed']);
  assert.deepEqual(PRIORITIES, ['low', 'normal', 'high', 'urgent']);
  assert.equal(Object.keys(TICKET_TYPES).length, 7);
  assert.equal(ticketTypeLabel('sikayet'), 'Oyuncu Şikâyeti');
  assert.equal(ticketTypeLabel('olmayan-tür'), 'Genel Destek');
});

/* ---------------- SLA ---------------- */

test('SLA hedefleri öncelik başına doğru', () => {
  assert.equal(slaTargetMinutes('urgent'), 30);
  assert.equal(slaTargetMinutes('high'), 60);
  assert.equal(slaTargetMinutes('normal'), 240);
  assert.equal(slaTargetMinutes('low'), 1440);
  assert.equal(slaTargetMinutes('bilinmeyen'), DEFAULT_SLA_MINUTES.normal);
  assert.equal(slaTargetMinutes('urgent', { urgent: 15 }), 15);
});

test('SLA: yanıtsız ve hedef içinde → breached=false, kalan süre doğru', () => {
  const created = 1_000_000;
  const t = { priority: 'urgent', created_at: created, first_response_at: null };
  const s = slaState(t, created + 10 * 60_000); // 10 dk sonra, hedef 30 dk
  assert.equal(s.breached, false);
  assert.equal(s.responded, false);
  assert.equal(s.remainingMs, 20 * 60_000);
});

test('SLA: yanıtsız ve hedef aşılmış → breached=true, remaining 0', () => {
  const created = 1_000_000;
  for (const [priority, mins] of Object.entries(DEFAULT_SLA_MINUTES)) {
    const t = { priority, created_at: created, first_response_at: null };
    const s = slaState(t, created + (mins + 1) * 60_000);
    assert.equal(s.breached, true, `${priority} aşılmalıydı`);
    assert.equal(s.remainingMs, 0);
  }
});

test('SLA: yanıt verilmişse yanıt zamanına göre değerlendirilir', () => {
  const created = 1_000_000;
  const inTime = { priority: 'high', created_at: created, first_response_at: created + 30 * 60_000 };
  assert.deepEqual(
    { responded: slaState(inTime).responded, breached: slaState(inTime).breached },
    { responded: true, breached: false },
  );
  const late = { priority: 'high', created_at: created, first_response_at: created + 90 * 60_000 };
  assert.equal(slaState(late).breached, true);
});

/* ---------------- gizli bilgi maskeleme ---------------- */

test('maskSecrets: anahtar=değer kalıpları maskelenir', () => {
  const input = 'şifre: hunter2 ve token=abc123xyz ayrıca PASSWORD:gizli99 api_key= yok';
  const out = maskSecrets(input);
  assert.ok(!out.includes('hunter2'));
  assert.ok(!out.includes('abc123xyz'));
  assert.ok(!out.includes('gizli99'));
  assert.match(out, /GİZLİ/);
});

test('maskSecrets: uzun hex ve base64 bloblar maskelenir, normal metin kalır', () => {
  const hex = 'a'.repeat(64);
  const b64 = 'QWxhZGRpbjpvcGVuIHNlc2FtZQabcdefgh12345678ZZ==';
  const out = maskSecrets(`önce ${hex} sonra ${b64} ve normal kelimeler burada duruyor`);
  assert.ok(!out.includes(hex));
  assert.ok(!out.includes(b64));
  assert.ok(out.includes('normal kelimeler burada duruyor'));
});

/* ---------------- transcript ---------------- */

const baseTicket = {
  id: 7, type: 'teknik', subject: 'Sunucuya giremiyorum', user_id: 'u1',
  status: 'closed', priority: 'high', created_at: 1_700_000_000_000,
  closed_at: 1_700_003_600_000, close_reason: 'çözüldü',
};

test('renderTranscript: zaman damgası, yazar, içerik, dosya URL ve Türkçe karakterler', () => {
  const rows = [
    {
      author_tag: 'Oyuncu#1', content: 'Şöyle bir sorun var: ığüşiöç ÇĞİÖŞÜ',
      attachments: JSON.stringify([{ name: 'ekran.png', url: 'https://cdn.discordapp.com/ekran.png' }]),
      created_at: 1_700_000_100_000,
    },
    {
      author_tag: 'Yetkili#2', content: 'Bakıyorum', embeds_summary: 'Durum kartı',
      attachments: '[]', created_at: 1_700_000_200_000,
    },
  ];
  const out = renderTranscript(baseTicket, rows);
  assert.match(out, /Talep #7/);
  assert.match(out, /Oyuncu#1/);
  assert.match(out, /ığüşiöç ÇĞİÖŞÜ/);
  assert.match(out, /https:\/\/cdn\.discordapp\.com\/ekran\.png/);
  assert.match(out, /\[embed\] Durum kartı/);
  assert.match(out, /Kapanış: .*çözüldü/);
  assert.match(out, /Mesaj sayısı: 2/);
  // zaman damgaları biçimlendi (varsayılan ISO benzeri)
  assert.match(out, /\[2023-11-14 \d{2}:\d{2}:\d{2}\]/);
});

test('renderTranscript: özel formatTime kullanılır ve sırlar maskelenir', () => {
  const rows = [{
    author_tag: 'Oyuncu#1', content: 'token=SUPERSECRETVALUE lütfen bakın', attachments: '[]',
    created_at: 1_700_000_100_000,
  }];
  const out = renderTranscript(baseTicket, rows, { formatTime: () => 'SAAT' });
  assert.match(out, /\[SAAT\] Oyuncu#1/);
  assert.ok(!out.includes('SUPERSECRETVALUE'));
});

test('renderTranscript: bozuk attachment JSON transcripti patlatmaz', () => {
  const rows = [{ author_tag: 'X#1', content: 'merhaba', attachments: '{bozuk', created_at: 1 }];
  const out = renderTranscript(baseTicket, rows);
  assert.match(out, /merhaba/);
});

/* ---------------- açma limiti / cooldown ---------------- */

test('checkOpenAllowed: kara listedeki kullanıcı reddedilir', () => {
  const r = checkOpenAllowed({ blacklisted: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'blacklist');
  assert.match(r.message, /erişimin kapatılmış/);
});

test('checkOpenAllowed: açık talep limiti', () => {
  assert.equal(checkOpenAllowed({ openCount: 0, maxOpen: 1, lastOpenAt: null }).ok, true);
  const r = checkOpenAllowed({ openCount: 1, maxOpen: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'limit');
  const r3 = checkOpenAllowed({ openCount: 3, maxOpen: 3 });
  assert.equal(r3.ok, false);
  assert.match(r3.message, /3/);
  assert.equal(checkOpenAllowed({ openCount: 2, maxOpen: 3, lastOpenAt: null }).ok, true);
});

test('checkOpenAllowed: cooldown penceresi', () => {
  const now = 10_000_000;
  const r = checkOpenAllowed({ openCount: 0, lastOpenAt: now - 5 * 60_000, cooldownMinutes: 10, now });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cooldown');
  assert.equal(r.retryInMs, 5 * 60_000);
  assert.match(r.message, /5 dakika/);
  // pencere geçince serbest
  assert.equal(checkOpenAllowed({ openCount: 0, lastOpenAt: now - 11 * 60_000, cooldownMinutes: 10, now }).ok, true);
  // cooldown 0 = kapalı
  assert.equal(checkOpenAllowed({ openCount: 0, lastOpenAt: now - 1, cooldownMinutes: 0, now }).ok, true);
});

/* ---------------- reconciliation ---------------- */

test('findOrphanTickets: kanalı olmayan aktif talepleri bulur', () => {
  const active = [
    { id: 1, channel_id: 'c1' },
    { id: 2, channel_id: 'silinmis' },
    { id: 3, channel_id: null },
    { id: 4, channel_id: 'c4' },
  ];
  assert.deepEqual(findOrphanTickets(active, ['c1', 'c4', 'baska']), [2]);
  assert.deepEqual(findOrphanTickets(active, []), [1, 2, 4]); // kanalı NULL olan (3) hariç hepsi öksüz
  assert.deepEqual(findOrphanTickets([], ['c1']), []);
});
