/** Report-only evaluator. No bot/DB/network imports; supplied evidence is never echoed. */
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value) => Array.isArray(value) && value.every(item => typeof item === 'string');
const bool = (value) => typeof value === 'boolean';
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const snowflake = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);
const known = (condition, complete) => complete ? (condition ? 'PASS' : 'FAIL') : 'UNVERIFIED';
const requiredPermissions = ['ManageChannels', 'ManageRoles', 'MoveMembers', 'Connect'];
const hasPermissions = (actual, required) => actual.includes('Administrator') || required.every(p => actual.includes(p));

function rosterStatus(data) {
  if (!object(data) || !Array.isArray(data.teams) || !Array.isArray(data.players)
    || !Number.isInteger(data.teamSize) || !bool(data.active)) return 'UNVERIFIED';
  if (data.teamSize < 1 || data.teamSize > 4) return 'FAIL';
  const numbers = new Set(), members = new Map(), players = new Map();
  for (const team of data.teams) {
    if (!object(team) || !Number.isInteger(team.number) || !Array.isArray(team.members)) return 'UNVERIFIED';
    if (team.number < 1 || numbers.has(team.number) || team.members.length > data.teamSize
      || team.members.length === 0 || data.teamSize === 1) return 'FAIL';
    numbers.add(team.number);
    for (const member of team.members) {
      if (!object(member) || !uuid(member.uuid) || !Number.isInteger(member.team)) return 'UNVERIFIED';
      const id = member.uuid.toLowerCase();
      if (members.has(id) || member.team !== team.number) return 'FAIL';
      members.set(id, team.number);
    }
  }
  for (const player of data.players) {
    if (!object(player) || !uuid(player.uuid)) return 'UNVERIFIED';
    const id = player.uuid.toLowerCase();
    if (players.has(id) || (player.team !== undefined && !Number.isInteger(player.team))) return 'FAIL';
    players.set(id, player.team);
    if (members.get(id) !== player.team) return 'FAIL';
  }
  if ([...members].some(([id, team]) => !players.has(id) || players.get(id) !== team)) return 'FAIL';
  return 'PASS';
}

function voiceStatus(voice, teams) {
  if (!object(voice) || !bool(voice.enabled) || !bool(voice.active) || typeof voice.matchKey !== 'string'
    || !Array.isArray(voice.teams) || !Array.isArray(voice.links) || rosterStatus(teams) !== 'PASS') return 'UNVERIFIED';
  // teamadmin.active covers warmup/countdown; voice.active covers running. An active voice must have a started match.
  if ((teams.active && !voice.enabled)
    || (voice.active && (!teams.active || !voice.enabled || !voice.matchKey))
    || (!voice.active && voice.matchKey !== '')) return 'FAIL';
  const signature = (rows) => rows.map(t => `${t.number}:${t.members.map(m => m.uuid.toLowerCase()).sort().join(',')}`).sort().join('|');
  if (voice.teams.some(t => !object(t) || !Number.isInteger(t.number) || !Array.isArray(t.members)
    || t.members.some(m => !object(m) || !uuid(m.uuid)))) return 'UNVERIFIED';
  if (signature(voice.teams) !== signature(teams.teams)) return 'FAIL';
  const membership = new Map(teams.teams.flatMap(t => t.members.map(m => [m.uuid.toLowerCase(), t.number])));
  const seen = new Set();
  for (const link of voice.links) {
    if (!object(link) || !uuid(link.uuid) || !snowflake(link.discordId)
      || !['online', 'participant', 'alive'].every(k => bool(link[k]))) return 'UNVERIFIED';
    const id = link.uuid.toLowerCase();
    if (seen.has(id) || membership.get(id) !== link.team || (!voice.active && link.participant)) return 'FAIL';
    seen.add(id);
  }
  return 'PASS';
}

/** Match reconciliation capacity: reuse desired owned IDs, retire only proven safe old voices. */
function capacityStatus(discord, teams) {
  const category = discord.category;
  if (!object(category) || !Number.isInteger(category.childCount) || category.childCount < 0
    || !snowflake(category.id) || !Array.isArray(discord.managedChannels) || !Array.isArray(teams?.teams)) return 'UNVERIFIED';
  if (category.childCount > 50) return 'FAIL';
  const desired = new Set(['entry', 'solo', 'spectator']);
  for (const team of teams.teams) {
    if (!object(team) || !Number.isInteger(team.number) || team.number < 1 || desired.has(`team:${team.number}`)) return 'UNVERIFIED';
    desired.add(`team:${team.number}`);
  }
  const ids = new Set(), keys = new Set();
  let reused = 0, ownedHere = 0, safeRetired = 0, unknownRetired = 0;
  for (const channel of discord.managedChannels) {
    if (!object(channel) || typeof channel.key !== 'string' || !channel.key
      || !snowflake(channel.id) || !Number.isInteger(channel.type)
      || (channel.parentId !== null && !snowflake(channel.parentId))) return 'UNVERIFIED';
    if (ids.has(channel.id) || keys.has(channel.key)) return 'FAIL';
    ids.add(channel.id); keys.add(channel.key);
    if (channel.parentId !== category.id) continue;
    ownedHere++;
    if (channel.type !== 2) return 'UNVERIFIED';
    if (desired.has(channel.key)) reused++;
    else if (channel.releasable === true) safeRetired++;
    else if (!bool(channel.releasable)) unknownRetired++;
  }
  if (ownedHere > category.childCount) return 'FAIL';
  const missing = desired.size - reused;
  if (category.childCount + missing - safeRetired <= 50) return 'PASS';
  return unknownRetired && category.childCount + missing - safeRetired - unknownRetired <= 50 ? 'UNVERIFIED' : 'FAIL';
}

/** Input is an operator-collected diagnostic envelope, NOT an existing HTTP endpoint. */
export function evaluateReadiness(evidence, { now = Date.now(), maxAgeMs = 300000 } = {}) {
  const input = object(evidence) ? evidence : {};
  const observed = typeof input.observedAt === 'string' ? Date.parse(input.observedAt) : NaN;
  const fresh = Number.isFinite(observed) && observed <= now + 30000 && now - observed <= maxAgeMs;
  const checks = [];
  function add(id, status, action) {
    checks.push({ id, status: fresh ? status : 'UNVERIFIED', action,
      evidence: fresh ? 'supplied diagnostic evidence' : 'missing, invalid or stale observation timestamp' });
  }
  const runtime = object(input.runtime) ? input.runtime : {};
  add('runtime.java', known(typeof runtime.javaVersion === 'string' && /^21(?:\.|$)/.test(runtime.javaVersion), typeof runtime.javaVersion === 'string'),
    'Paper sunucusunu çalıştıran JVM için java -version çıktısının Java 21 olduğunu doğrulayın.');
  const runtimeVersionComplete = typeof runtime.serverSoftware === 'string' && typeof runtime.minecraftVersion === 'string';
  const paperCompatibilityKnown = runtime.serverSoftware === 'Paper' || bool(runtime.paperCompatible);
  add('runtime.paper', known((runtime.serverSoftware === 'Paper' || runtime.paperCompatible === true)
    && runtime.minecraftVersion === '1.21.11', runtimeVersionComplete
      && (runtime.minecraftVersion !== '1.21.11' || paperCompatibilityKnown)),
  'Çalışan /version çıktısında Minecraft 1.21.11 doğrulayın; Leaf gibi forklar için Paper API uyumluluğunu ayrıca paperCompatible=true kanıtıyla belirtin.');
  const liberty = Array.isArray(runtime.plugins) ? runtime.plugins.find(p => object(p) && p.name === 'LibertyBans') : undefined;
  add('runtime.libertybans', known(liberty?.enabled === true, Array.isArray(runtime.plugins)
    && (!liberty || bool(liberty.enabled))), 'Çalışan sunucuda LibertyBans eklentisinin yüklü ve etkin olduğunu doğrulayın.');

  const discord = object(input.discord) ? input.discord : {};
  add('discord.connection', known(discord.ready && discord.guildId === discord.configuredGuildId,
    bool(discord.ready) && snowflake(discord.guildId) && snowflake(discord.configuredGuildId)),
  'Canlı bot client.isReady() ve hedef guild kimliğini doğrulayın.');
  add('discord.intents', known(strings(discord.intents) && discord.intents.includes('GuildMembers') && discord.intents.includes('GuildVoiceStates') && discord.portalMembersIntentEnabled,
    strings(discord.intents) && bool(discord.portalMembersIntentEnabled)), 'Client intent bitlerini ve Developer Portal ayrıcalıklı Server Members Intent onayını doğrulayın.');
  const channelEvidence = [discord.category, discord.global, ...(Array.isArray(discord.managedChannels) ? discord.managedChannels : [])];
  const permissionComplete = strings(discord.guildPermissions) && Array.isArray(discord.managedChannels)
    && channelEvidence.every(c => object(c) && strings(c.permissions));
  add('discord.permissions', known(permissionComplete && hasPermissions(discord.guildPermissions, requiredPermissions)
    && channelEvidence.every(c => hasPermissions(c.permissions, ['ManageChannels', 'MoveMembers', 'Connect'])), permissionComplete),
  'Bot için guild ve kategori/Global/yönetilen ses kanallarında permissionsFor(botMember) etkin izinlerini doğrulayın; Administrator erişimi platform ayrıcalığıdır.');
  const role = object(discord.linkedRole) ? discord.linkedRole : {};
  add('discord.hierarchy', known(discord.botHighestRolePosition > role.position && role.managed === false,
    Number.isInteger(discord.botHighestRolePosition) && Number.isInteger(role.position) && bool(role.managed)),
  'Botun en yüksek rolünü yönetilen Minecraft bağlantı rolünün üstüne alın; managed roller düzenlenemez.');
  const category = object(discord.category) ? discord.category : {};
  const global = object(discord.global) ? discord.global : {};
  const channelIds = [discord.categoryId, discord.globalId, category.id, global.id, category.guildId, global.guildId, discord.guildId];
  const channelComplete = channelIds.every(id => typeof id === 'string')
    && Number.isInteger(category.type) && Number.isInteger(global.type);
  add('discord.channels', known(channelIds.every(snowflake) && category.id === discord.categoryId && global.id === discord.globalId
    && category.guildId === discord.guildId && global.guildId === discord.guildId && category.type === 4 && global.type === 2, channelComplete),
  'src/voice.js kategori/Global sabitlerini canlı guild kanallarıyla karşılaştırın; türler GuildCategory=4, GuildVoice=2 olmalı.');
  add('discord.capacity', capacityStatus(discord, input.teams),
  '50 kanal sınırı için mevcut desired managed anahtar/ID eşleşmelerini yeniden kullanın; yalnız eksik desired kanalları ekleyin, retired owned kanalları sadece releasable=true kanıtıyla boşalan yer sayın.');

  const bridge = object(input.bridge) ? input.bridge : {};
  const stats = object(bridge.stats) ? bridge.stats : {};
  add('bridge.outbound', known(stats.connected === true, bool(stats.connected)),
    'Canlı süreçte mcapi.bridgeSnapshot()/queue.stats().connected ve güncel outbound poll trafiğini doğrulayın.');
  const idsComplete = strings(stats.instanceIds) && strings(stats.duplicateInstanceIds) && Number.isInteger(stats.instances)
    && bool(stats.ambiguous) && typeof bridge.expectedInstanceId === 'string' && bridge.expectedInstanceId.length > 0;
  add('bridge.instance', known(idsComplete && stats.instances === 1 && stats.instanceIds.length === 1
    && stats.instanceIds[0] === bridge.expectedInstanceId && !bridge.expectedInstanceId.startsWith('anonymous:')
    && !bridge.expectedInstanceId.startsWith('legacy:') && !bridge.expectedInstanceId.startsWith('ip:') && !stats.ambiguous && stats.duplicateInstanceIds.length === 0, idsComplete),
  'bridge.instance-id ile stats.instanceIds eşleşmeli; tek açık kimlik, ambiguous=false ve duplicateInstanceIds=[] doğrulayın.');
  const auth = object(bridge.authentication) ? bridge.authentication : {};
  add('bridge.secret', known(auth.botSecretConfigured && auth.pluginSecretConfigured && auth.sharedSecretMatches,
    ['botSecretConfigured', 'pluginSecretConfigured', 'sharedSecretMatches'].every(k => bool(auth[k]))),
  'BRIDGE_SECRET ve plugin bridge.token değerlerini güvenli oturumda karşılaştırın; rapora yalnız üç boolean yazın, secret/hash eklemeyin.');
  const db = object(input.database) ? input.database : {};
  add('database.read', known(db.reachable && db.integrity === 'ok' && db.requiredTablesPresent,
    db.reachable === false || (bool(db.reachable) && typeof db.integrity === 'string' && bool(db.requiredTablesPresent))),
  'Mevcut bot SQLite dosyasını --db ile salt okunur açıp quick_check ve settings/processed_events tablo varlığını kontrol edin.');
  add('teams.integrity', rosterStatus(input.teams),
    'GET /api/teamadmin: takım numaraları/UUID tekilliği, kapasite, oyuncu↔takım ters eşleşmesi; kayıtları sıfırlamayın.');
  add('voice.contract', voiceStatus(input.voice, input.teams),
    'GET /api/voice ve GET /api/teamadmin anlık görüntülerini aynı sakin anda alın; enabled/active/matchKey, kadro ve bağlantıları karşılaştırın.');
  const world = object(input.world) ? input.world : {};
  add('world.ready', known(world.ready && world.selectedWorldExists, bool(world.ready) && bool(world.selectedWorldExists)),
    'Yetkili mevcut dünya seçimini ve hazırlığın tamamlandığını salt okunur durum/log kanıtıyla doğrulasın; dünya üretimini tetiklemeyin.');
  add('world.datapacks', known(strings(world.requiredDatapacks) && strings(world.enabledDatapacks)
    && world.requiredDatapacks.every(name => world.enabledDatapacks.includes(name)),
  strings(world.requiredDatapacks) && strings(world.enabledDatapacks)),
  'Zorunlu datapack adlarını yapılandırmadan alın; /datapack list enabled çıktısıyla birebir karşılaştırın.');

  const counts = Object.fromEntries(['PASS', 'FAIL', 'UNVERIFIED'].map(status => [status, checks.filter(c => c.status === status).length]));
  const ready = checks.every(c => c.status === 'PASS');
  return { schemaVersion: 1, reportOnly: true, ready, decision: ready ? 'GO' : 'NO-GO', counts, checks,
    limitations: [
      'PASS yalnız sağlanan güncel kanıtın tutarlılığıdır; canlı Discord/Paper entegrasyonu veya maç başarısı garantisi değildir.',
      'Bu araç kanıt toplamaz, ağ isteği göndermez, maç/dünya/oyuncu/kanal değiştirmez. --db yalnız salt okunur yerel sorgudur.',
      'Tek kimlikli bridge gözlemi aynı instance-id ile sırayla bağlanan iki süreci kesin dışlayamaz; deployment envanteri ayrıca doğrulanmalıdır.',
      'Mevcut bridge API dünya hazırlığını, zorunlu datapack listesini ve tam JVM/plugin sürüm kanıtını sunmaz; yetkili kanıtı gerekir.',
    ] };
}
