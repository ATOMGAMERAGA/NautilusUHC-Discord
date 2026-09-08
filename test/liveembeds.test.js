import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

process.env.DISCORD_TOKEN = 'test-token';
process.env.BRIDGE_SECRET = 'test-secret';
const dbFile = join(tmpdir(), `nautilus-liveembeds-test-${process.pid}.db`);
process.env.DB_PATH = dbFile;

const {
  liveMatchEmbed, teamsEmbed, scenariosEmbed, queueEmbed, perfEmbed,
  modHistoryEmbed, modListEmbed, statusBoardEmbed,
} = await import('../src/liveembeds.js');

after(() => {
  try { rmSync(dbFile); rmSync(`${dbFile}-wal`, { force: true }); rmSync(`${dbFile}-shm`, { force: true }); } catch {}
});

const ACTIVE_STATUS = {
  ok: true,
  count: 14,
  match: {
    active: true,
    state: 'PvP',
    elapsedSecs: 1250,
    aliveCount: 9,
    participantCount: 16,
    secondsUntilPvp: 0,
    secondsUntilHeal: 0,
    borderSize: 1500,
    scenarios: ['Timber', 'GoldenHeads'],
  },
};

test('liveMatchEmbed: ulaşılamıyor → sınıflandırılmış hata, ham metin sızmaz', () => {
  const e = liveMatchEmbed({ ok: false, error: 'fetch failed ECONNRESET 10.0.0.4:25000' });
  assert.match(e.data.title, /Ulaşılamıyor/);
  assert.match(e.data.description, /yanıt vermiyor/);
  assert.doesNotMatch(e.data.description, /ECONNRESET|fetch|25000/,
    'ham köprü hatası kullanıcıya gösterilmemeli');
});

test('liveMatchEmbed: aktif maç yokken boş durum kartı + sıradaki adım', () => {
  const e = liveMatchEmbed({ ok: true, count: 3, match: { active: false } });
  assert.match(e.data.title, /Aktif Maç Yok/);
  assert.match(e.data.description, /3/);
  assert.match(e.data.description, /maç program/, 'kullanıcıya sıradaki adım gösterilmeli');
});

test('liveMatchEmbed: aktif maç alanları ve hayatta listesi', () => {
  const grace = JSON.parse(JSON.stringify(ACTIVE_STATUS));
  grace.match.state = 'Hazırlık';
  grace.match.secondsUntilPvp = 300;
  const e = liveMatchEmbed(grace, { ok: true, alive: ['KaptanReis', 'Oyuncu2'] });
  assert.match(e.data.title, /Canlı Maç/);
  const names = e.data.fields.map((f) => f.name);
  assert.ok(names.includes('Aşama'));
  assert.ok(names.includes("PvP'ye Kalan"), 'grace evresinde PvP sayacı görünmeli');
  const aliveField = e.data.fields.find((f) => f.name.includes('Hayatta Kalanlar'));
  assert.match(aliveField.value, /KaptanReis/);
});

test('teamsEmbed: FFA ve dolu kadro halleri', () => {
  const ffa = teamsEmbed({ ok: true, ffa: true, teamSize: 1, teams: [] });
  assert.match(ffa.data.description, /FFA/);

  const e = teamsEmbed({
    ok: true,
    ffa: false,
    teamSize: 2,
    teams: [{
      id: 'team-1',
      color: 'red',
      leaderName: 'KaptanReis',
      members: [
        { name: 'KaptanReis', alive: true, online: true },
        { name: 'Oyuncu2', alive: false, online: false },
      ],
    }],
  });
  assert.match(e.data.title, /To2/);
  const field = e.data.fields[0];
  assert.match(field.value, /🟢 KaptanReis 👑/);
  assert.match(field.value, /💀 Oyuncu2 \(çevrimdışı\)/);
});

test('scenariosEmbed: aktifler işaretlenir', () => {
  const e = scenariosEmbed({
    ok: true,
    scenarios: [
      { id: 'casino', name: 'Casino', lore: 'kumar', active: true },
      { id: 'nofall', name: 'No Fall', lore: 'düşüş hasarı yok', active: false },
    ],
  });
  assert.match(e.data.description, /Casino/);
  assert.ok(e.data.fields.some((f) => f.name.startsWith('✅ Casino')));
  assert.ok(e.data.fields.some((f) => f.name.startsWith('▫️ No Fall')));
});

test('queueEmbed: boş kuyruk + zorunluluk bayrakları', () => {
  const e = queueEmbed({ ok: true, size: 0, players: [], requireLink: true, requireJoin: false });
  assert.match(e.data.description, /Kuyruk boş/);
  const link = e.data.fields.find((f) => f.name === 'Hesap bağlama');
  assert.equal(link.value, 'Zorunlu');
});

test('perfEmbed: TPS/MSPT/bellek alanları', () => {
  const e = perfEmbed({
    ok: true,
    tps: { m1: 19.98, m5: 19.9, m15: 20 },
    mspt: 3.2,
    memory: { usedMb: 2048, maxMb: 8192 },
    uptimeSecs: 3600,
    onlineCount: 12,
  });
  const tpsField = e.data.fields.find((f) => f.name.includes('TPS'));
  assert.match(tpsField.value, /🟢 19.98/);
  assert.match(e.data.fields.find((f) => f.name === 'Bellek').value, /2048 \/ 8192 MB/);
});

test('modHistoryEmbed: temiz sicil ve kayıt satırları', () => {
  const clean = modHistoryEmbed('Steve', { ok: true, player: 'Steve', entries: [] });
  assert.match(clean.data.title, /Sicil Temiz/);
  assert.match(clean.data.description, /cezası bulunmuyor/);

  const e = modHistoryEmbed('Steve', {
    ok: true,
    player: 'Steve',
    entries: [
      { action: 'ban', staff: 'admin', reason: 'xray', durationMs: 86_400_000, createdAt: 1_784_224_803_000 },
      { action: 'warn', staff: 'mod', reason: 'dil', durationMs: 0, createdAt: 1_784_224_803_000 },
    ],
  });
  assert.match(e.data.footer.text, /2 kayıt/);
  assert.match(e.data.description, /🔨 \*\*ban\*\*/);
  assert.match(e.data.description, /⚠️ \*\*warn\*\*/);
});

test('modListEmbed: kalıcı/bitişli banlar', () => {
  const e = modListEmbed({
    ok: true,
    type: 'ban',
    entries: [
      { player: 'Griefer', staff: 'admin', reason: 'grief', issuedAt: 1, expiresAt: 0 },
      { player: 'Spammer', staff: 'mod', reason: 'spam', issuedAt: 1, expiresAt: 1_784_224_803_000 },
    ],
  });
  assert.match(e.data.title, /Aktif Banlar — 2/);
  assert.match(e.data.description, /Griefer.*kalıcı/);
});

test('statusBoardEmbed: ulaşılamıyor ve canlı pano halleri', () => {
  const down = statusBoardEmbed({ ok: false, error: 'x' }, null);
  assert.match(down.data.title, /Ulaşılamıyor/);

  const up = statusBoardEmbed(ACTIVE_STATUS, {
    ok: true, tps: { m1: 20 }, mspt: 2.5, memory: { usedMb: 1024, maxMb: 4096 },
  });
  assert.match(up.data.title, /Canlı Durum/);
  assert.ok(up.data.fields.some((f) => f.name === 'Performans' && /TPS 20/.test(f.value)));
  assert.ok(up.data.fields.some((f) => f.name === 'Maç' && f.value.includes('PvP')));
});
