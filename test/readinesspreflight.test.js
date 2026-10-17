import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateReadiness } from '../src/readinesspreflight.js';

const now = Date.parse('2026-10-17T12:00:00Z');
const guildId = '1521979737201836233';
const uuid = '00000000-0000-0000-0000-000000000001';
const permissions = ['ManageChannels', 'ManageRoles', 'MoveMembers', 'Connect'];
function evidence() {
  return {
    observedAt: new Date(now).toISOString(),
    runtime: { javaVersion: '21.0.8', serverSoftware: 'Paper', minecraftVersion: '1.21.11',
      plugins: [{ name: 'LibertyBans', enabled: true }] },
    discord: { ready: true, guildId, configuredGuildId: guildId,
      intents: ['GuildMembers', 'GuildVoiceStates'], guildPermissions: permissions, portalMembersIntentEnabled: true,
      botHighestRolePosition: 10, linkedRole: { position: 5, managed: false },
      categoryId: '1522215362857406654', globalId: '1522216892658614272',
      category: { id: '1522215362857406654', guildId, type: 4, permissions, childCount: 2 },
      global: { id: '1522216892658614272', guildId, type: 2, permissions }, managedChannels: [] },
    bridge: { expectedInstanceId: 'uhc-main', stats: { connected: true, instances: 1,
      instanceIds: ['uhc-main'], ambiguous: false, duplicateInstanceIds: [] },
      authentication: { botSecretConfigured: true, pluginSecretConfigured: true, sharedSecretMatches: true } },
    database: { reachable: true, integrity: 'ok', requiredTablesPresent: true },
    teams: { teamSize: 4, active: false, teams: [{ number: 1, members: [{ uuid, team: 1 }] }],
      players: [{ uuid, team: 1 }] },
    voice: { enabled: true, active: false, matchKey: '', teams: [{ number: 1, members: [{ uuid, team: 1 }] }],
      links: [{ uuid, discordId: '123456789012345678', team: 1, online: true, participant: false, alive: true }] },
    world: { ready: true, selectedWorldExists: true, requiredDatapacks: ['uhc'], enabledDatapacks: ['uhc'] },
  };
}
const run = (data) => evaluateReadiness(data, { now });
const check = (report, id) => report.checks.find((row) => row.id === id)?.status;

test('complete current production evidence passes without mutating supplied snapshots', () => {
  const input = evidence(); const before = JSON.stringify(input); const report = run(input);
  assert.equal(report.ready, true); assert.ok(report.checks.length >= 17);
  assert.ok(report.checks.every((row) => row.status === 'PASS'));
  assert.equal(JSON.stringify(input), before);
});
test('absent, partial and stale evidence cannot pass readiness', () => {
  for (const input of [{}, null, { observedAt: 'invalid' }, { ...evidence(), observedAt: new Date(now - 600001).toISOString() }]) {
    const report = run(input); assert.equal(report.ready, false);
    assert.ok(report.checks.some((row) => row.status === 'UNVERIFIED'));
  }
  const partial = evidence(); delete partial.world.enabledDatapacks;
  assert.equal(check(run(partial), 'world.datapacks'), 'UNVERIFIED');
});
test('Java, Paper and mandatory plugin mismatches fail independently', () => {
  const input = evidence(); input.runtime.javaVersion = '17.0.16'; input.runtime.minecraftVersion = '1.21.10';
  input.runtime.plugins[0].enabled = false;
  const report = run(input);
  for (const id of ['runtime.java', 'runtime.paper', 'runtime.libertybans']) assert.equal(check(report, id), 'FAIL');
});
test('missing privileged intent and channel-specific effective permissions fail', () => {
  const input = evidence(); input.discord.intents = ['GuildMembers']; input.discord.global.permissions = ['Connect'];
  const report = run(input); assert.equal(check(report, 'discord.intents'), 'FAIL');
  assert.equal(check(report, 'discord.permissions'), 'FAIL');
});
test('missing permission evidence is UNVERIFIED even when guild permissions are present', () => {
  const input = evidence(); delete input.discord.category.permissions;
  assert.equal(check(run(input), 'discord.permissions'), 'UNVERIFIED');
});
test('equal role positions or a managed linked role fail hierarchy', () => {
  for (const linkedRole of [{ position: 10, managed: false }, { position: 5, managed: true }]) {
    const input = evidence(); input.discord.linkedRole = linkedRole;
    assert.equal(check(run(input), 'discord.hierarchy'), 'FAIL');
  }
});
test('wrong channel type, guild, ID and full category fail configuration', () => {
  for (const change of [d => d.category.type = 2, d => d.global.guildId = 'other', d => d.category.id = 'other']) {
    const input = evidence(); change(input.discord); assert.equal(check(run(input), 'discord.channels'), 'FAIL');
  }
  const input = evidence(); input.discord.category.childCount = 50;
  assert.equal(check(run(input), 'discord.capacity'), 'FAIL');
});
test('disconnected, anonymous, competing or duplicated bridge instances cannot pass', () => {
  for (const stats of [
    { connected: false },
    { connected: true, instances: 2, instanceIds: ['uhc-main', 'other'], ambiguous: true, duplicateInstanceIds: [] },
    { connected: true, instances: 1, instanceIds: ['uhc-main'], ambiguous: false, duplicateInstanceIds: ['uhc-main'] },
    { connected: true, instances: 1, instanceIds: ['anonymous:legacy'], ambiguous: false, duplicateInstanceIds: [] },
  ]) {
    const input = evidence(); input.bridge.stats = stats; assert.equal(run(input).ready, false);
  }
});
test('shared-secret equality requires explicit proof and report never echoes secrets', () => {
  const input = evidence(); delete input.bridge.authentication.sharedSecretMatches;
  input.bridge.authentication.botSecret = 'SENSITIVE_DO_NOT_PRINT'; input.secret = 'SENSITIVE_DO_NOT_PRINT';
  const report = run(input); assert.equal(check(report, 'bridge.secret'), 'UNVERIFIED');
  assert.ok(!JSON.stringify(report).includes('SENSITIVE_DO_NOT_PRINT'));
  input.bridge.authentication.sharedSecretMatches = false;
  assert.equal(check(run(input), 'bridge.secret'), 'FAIL');
});
test('duplicate membership, overflow and reverse roster mismatch fail team integrity', () => {
  for (const change of [
    d => d.teams.push({ number: 2, members: [{ uuid, team: 2 }] }),
    d => { d.teamSize = 1; d.teams[0].members.push({ uuid: '00000000-0000-0000-0000-000000000002', team: 1 }); },
    d => d.players[0].team = 2,
  ]) {
    const input = evidence(); change(input.teams); assert.equal(check(run(input), 'teams.integrity'), 'FAIL');
  }
});
test('FFA, To2, To3 and To4 snapshots remain valid', () => {
  for (const teamSize of [1, 2, 3, 4]) {
    const input = evidence(); input.teams.teamSize = teamSize;
    if (teamSize === 1) { input.teams.teams = []; input.teams.players = [{ uuid }]; input.voice.teams = []; delete input.voice.links[0].team; }
    assert.equal(check(run(input), 'teams.integrity'), 'PASS');
  }
});
test('voice activity, roster and link inconsistencies block voice contract', () => {
  for (const change of [d => { d.active = true; }, d => { d.teams = []; }, d => { d.links[0].team = 99; }, d => { delete d.links[0].online; }]) {
    const input = evidence(); change(input.voice); assert.notEqual(check(run(input), 'voice.contract'), 'PASS');
  }
});
test('world not ready, missing datapack or inaccessible DB fail independently', () => {
  const input = evidence(); input.world.ready = false; input.world.enabledDatapacks = []; input.database.reachable = false;
  const report = run(input);
  for (const id of ['world.ready', 'world.datapacks', 'database.read']) assert.equal(check(report, id), 'FAIL');
});
test('CLI reads only evidence, reports missing live proof and preserves the input file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nautilus-preflight-'));
  try {
    const path = join(dir, 'evidence.json'); writeFileSync(path, '{}');
    const result = spawnSync(process.execPath, ['scripts/readiness-preflight.js', path], { encoding: 'utf8' });
    assert.equal(result.status, 1); const report = JSON.parse(result.stdout);
    assert.equal(report.ready, false); assert.ok(report.checks.every(row => row.status === 'UNVERIFIED'));
    assert.equal(readFileSync(path, 'utf8'), '{}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Portal approval cannot be inferred from code intent declarations', () => {
  const input = evidence(); delete input.discord.portalMembersIntentEnabled;
  assert.equal(check(run(input), 'discord.intents'), 'UNVERIFIED');
  input.discord.portalMembersIntentEnabled = false;
  assert.equal(check(run(input), 'discord.intents'), 'FAIL');
});
test('anonymous ip bridge identity is never accepted as explicit instance identity', () => {
  const input = evidence(); input.bridge.expectedInstanceId = 'ip:bilinmeyen';
  input.bridge.stats.instanceIds = ['ip:bilinmeyen'];
  assert.equal(check(run(input), 'bridge.instance'), 'FAIL');
});
test('CLI DB probe preserves an existing database and never creates an absent database', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'nautilus-preflight-db-'));
  try {
    const path = join(dir, 'evidence.json'), dbPath = join(dir, 'bot.db');
    const input = evidence(); input.observedAt = new Date().toISOString(); writeFileSync(path, JSON.stringify(input));
    const db = new DatabaseSync(dbPath); db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE processed_events (event_id TEXT); INSERT INTO settings VALUES ('sentinel', 'keep');`); db.close();
    const before = readFileSync(dbPath);
    const result = spawnSync(process.execPath, ['scripts/readiness-preflight.js', path, '--db', dbPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(check(JSON.parse(result.stdout), 'database.read'), 'PASS');
    assert.deepEqual(readFileSync(dbPath), before);
    const absent = spawnSync(process.execPath, ['scripts/readiness-preflight.js', path, '--db', join(dir, 'absent.db')], { encoding: 'utf8' });
    assert.equal(absent.status, 1); assert.equal(check(JSON.parse(absent.stdout), 'database.read'), 'FAIL');
    assert.throws(() => readFileSync(join(dir, 'absent.db')), { code: 'ENOENT' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('malformed diagnostic arrays remain UNVERIFIED instead of throwing or passing', () => {
  for (const change of [
    d => d.discord.intents = { includes: true },
    d => d.runtime.plugins = { find: true },
    d => d.discord.managedChannels = {},
    d => d.bridge.stats.instanceIds = 'uhc-main',
  ]) {
    const input = evidence(); change(input); const report = run(input);
    assert.equal(report.ready, false); assert.ok(report.counts.UNVERIFIED > 0);
  }
});

function managedChannels(keys, { releasable } = {}) {
  return keys.map((key, index) => ({ key, id: `1234567890123456${String(index).padStart(2, '0')}`,
    parentId: '1522215362857406654', type: 2, permissions, ...(releasable === undefined ? {} : { releasable }) }));
}
test('a full category passes when all desired managed IDs already exist', () => {
  const input = evidence(); input.discord.category.childCount = 50;
  input.discord.managedChannels = managedChannels(['entry', 'solo', 'spectator', 'team:1']);
  assert.equal(check(run(input), 'discord.capacity'), 'PASS');
});
test('50 new desired channels plus an unrelated occupied slot fail capacity', () => {
  const input = evidence(); input.discord.category.childCount = 1;
  input.teams.teams = Array.from({ length: 47 }, (_, i) => ({ number: i + 1, members: [] }));
  assert.equal(check(run(input), 'discord.capacity'), 'FAIL');
});
test('capacity counts only missing desired channels and safely releasable retired owned channels', () => {
  const input = evidence(); input.discord.category.childCount = 50;
  input.discord.managedChannels = managedChannels(['entry', 'solo', 'spectator', 'team:2']);
  input.discord.managedChannels[3].releasable = true;
  assert.equal(check(run(input), 'discord.capacity'), 'PASS');
  input.discord.managedChannels[3].releasable = false;
  assert.equal(check(run(input), 'discord.capacity'), 'FAIL');
  delete input.discord.managedChannels[3].releasable;
  assert.equal(check(run(input), 'discord.capacity'), 'UNVERIFIED');
});
test('unknown managed channel ownership/location cannot pass capacity', () => {
  const input = evidence(); input.discord.managedChannels = [{ id: '123456789012345678', permissions }];
  assert.equal(check(run(input), 'discord.capacity'), 'UNVERIFIED');
});
test('Leaf Paper fork requires explicit compatibility evidence for the expected Minecraft version', () => {
  const input = evidence(); input.runtime.serverSoftware = 'Leaf';
  assert.equal(check(run(input), 'runtime.paper'), 'UNVERIFIED');
  input.runtime.paperCompatible = true;
  assert.equal(check(run(input), 'runtime.paper'), 'PASS');
  input.runtime.paperCompatible = false;
  assert.equal(check(run(input), 'runtime.paper'), 'FAIL');
  input.runtime.paperCompatible = true; input.runtime.minecraftVersion = '1.21.10';
  assert.equal(check(run(input), 'runtime.paper'), 'FAIL');
});
test('To5 fails the supported1–4 admin capacity invariant', () => {
  const input = evidence(); input.teams.teamSize = 5;
  assert.equal(check(run(input), 'teams.integrity'), 'FAIL');
});

test('a started match cannot report disabled voice routing', () => {
  const input = evidence(); input.teams.active = true;
  input.voice.active = false; input.voice.enabled = false; input.voice.matchKey = '';
  const report = run(input);
  assert.equal(check(report, 'voice.contract'), 'FAIL');
  assert.equal(report.ready, false);
});
test('countdown may have started teams and enabled voice without running voice', () => {
  const input = evidence(); input.teams.active = true;
  input.voice.active = false; input.voice.enabled = true; input.voice.matchKey = '';
  assert.equal(check(run(input), 'voice.contract'), 'PASS');
});
