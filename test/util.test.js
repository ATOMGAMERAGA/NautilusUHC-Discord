// config.js, DISCORD_TOKEN yoksa process.exit(1) yapar; util.js onu import
// ettiği için testten ÖNCE sahte bir token veriyoruz (gerçek bağlantı kurulmaz).
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Dinamik import: ortam değişkeni AYARLANDIKTAN sonra util.js -> config.js yüklensin
// (statik import'lar bu satırın üstüne hoist edilir, dinamik import edilmez).
const { parseDuration, formatDuration, formatSeconds, clean, discordTime, trDateTime } = await import('../src/util.js');

test('parseDuration Türkçe/İngilizce birimleri çözer', () => {
  assert.equal(parseDuration('10dk'), 600_000);
  assert.equal(parseDuration('2sa'), 7_200_000);
  assert.equal(parseDuration('7g'), 604_800_000);
  assert.equal(parseDuration('30sn'), 30_000);
  assert.equal(parseDuration('1h'), 3_600_000);
  assert.equal(parseDuration('45m'), 2_700_000);
});

test('parseDuration geçersiz girdide null döner', () => {
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration('0dk'), null);
  assert.equal(parseDuration('-5dk'), null);
  assert.equal(parseDuration('10'), null);
});

test('formatDuration okunur Türkçe süre üretir', () => {
  assert.equal(formatDuration(0), 'kalıcı');
  assert.equal(formatDuration(null), 'kalıcı');
  assert.equal(formatDuration(600_000), '10dk');
  assert.equal(formatDuration(7_200_000), '2sa');
  assert.equal(formatDuration(90_061_000), '1g 1sa 1dk');
});

test('parseDuration/formatDuration turu tutarlı', () => {
  for (const s of ['10dk', '2sa', '3g']) {
    assert.equal(formatDuration(parseDuration(s)), s);
  }
});

test('formatSeconds mm:ss ve h:mm:ss', () => {
  assert.equal(formatSeconds(0), '00:00');
  assert.equal(formatSeconds(65), '01:05');
  assert.equal(formatSeconds(3661), '1:01:01');
  assert.equal(formatSeconds(-10), '00:00');
});

test('clean markdown kaçışı yapar ve kısaltır', () => {
  assert.equal(clean('a*b_c`d'), 'a\\*b\\_c\\`d');
  assert.equal(clean('uzun', 2), 'uz…');
  assert.equal(clean(null), '');
});

test('discordTime unix zaman etiketi', () => {
  assert.equal(discordTime(1_700_000_000_000), '<t:1700000000:F>');
  assert.equal(discordTime(1_700_000_000_000, 'R'), '<t:1700000000:R>');
});

test('trDateTime bir tarih dizesi döner', () => {
  const s = trDateTime(1_700_000_000_000);
  assert.match(s, /\d{2}\.\d{2}\.\d{4}/);
});
