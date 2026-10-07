import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
async function openDatabase(path) {
  try {
    const { default: Database } = await import('better-sqlite3');
    return new Database(path);
  } catch {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(path);
  }
}
const DC = '300000000000000001';
const A = { uuid: '00000000-0000-4000-8000-00000000000a', discordId: DC, mcName: 'First', currentName: 'First', linkedAt: 10 };
const B = { uuid: '00000000-0000-4000-8000-00000000000b', discordId: DC, mcName: 'Second', currentName: 'Second', linkedAt: 20 };
const audit = (link, action) => ({ action, detail: `${link.mcName} (${link.uuid})` });
async function report(links, records) {
  const root = mkdtempSync(join(tmpdir(), 'link-consistency-'));
  const dbPath = join(root, 'bot.db');
  const reportPath = join(root, 'plugin.json');
  const db = await openDatabase(dbPath);
  try {
    db.exec('CREATE TABLE cases (id INTEGER PRIMARY KEY, action TEXT, user_id TEXT, mod_id TEXT, detail TEXT, created_at INTEGER)');
    const insert = db.prepare('INSERT INTO cases VALUES (?, ?, ?, ?, ?, ?)');
    records.forEach((record, i) => insert.run(i + 1, record.action, DC, 'staff', record.detail, 100 + i));
    db.close();
    writeFileSync(reportPath, JSON.stringify({ links, summary: { totalLinks: links.length } }));
    const child = spawnSync(process.execPath, ['scripts/link-consistency.js', reportPath, dbPath], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('two audited active links have no mismatch regardless of report order', async () => {
  const result = await report([B, A], [audit(A, 'link_create'), audit(B, 'link_create')]);
  assert.deepEqual(result.incelenecek, []);
  assert.equal(result.botKaydıOlmayanBağlantılar, 0);
});
test('UUID audit unlink of the second account does not flag the still-linked first account', async () => {
  const result = await report([A], [audit(A, 'link_create'), audit(B, 'link_create'), audit(B, 'link_delete')]);
  assert.deepEqual(result.incelenecek, []);
});
test('missing first UUID remains visible when the latest Discord audit describes a different active UUID', async () => {
  const result = await report([B], [audit(A, 'link_create'), audit(B, 'link_create')]);
  assert.equal(result.incelenecek.length, 1);
  assert.equal(result.incelenecek[0].uuid, A.uuid);
  assert.equal(result.incelenecek[0].tür, 'bot_bagli_saniyor_plugin_bagli_degil');
});
test('an audit for one UUID does not cover a second unaudited account', async () => {
  const result = await report([A, B], [audit(A, 'link_create')]);
  assert.deepEqual(result.incelenecek, []);
  assert.equal(result.botKaydıOlmayanBağlantılar, 1);
});
test('legacy name-only delete does not implicate another account', async () => {
  const result = await report([A], [audit(A, 'link_create'), { action: 'link_delete', detail: 'Second' }]);
  assert.deepEqual(result.incelenecek, []);
});
test('legacy unique name-only delete reports only its matching linked account', async () => {
  const result = await report([A, B], [{ action: 'link_delete', detail: 'First' }]);
  assert.equal(result.incelenecek.length, 1);
  assert.equal(result.incelenecek[0].pluginBağlantısı.uuid, A.uuid);
});
test('ambiguous legacy name-only delete cannot identify which UUID stayed linked', async () => {
  const result = await report([A, { ...B, mcName: 'First', currentName: 'First' }], [{ action: 'link_delete', detail: 'First' }]);
  assert.deepEqual(result.incelenecek, []);
});
test('legacy reused name remains ambiguous even when only its new UUID is currently linked', async () => {
  const result = await report([{ ...B, mcName: 'First', currentName: 'First' }],
    [audit(A, 'link_create'), audit(A, 'link_delete'), { action: 'link_delete', detail: 'First' }]);
  assert.deepEqual(result.incelenecek, []);
});
