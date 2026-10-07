/**
 * Hesap bağlantısı tutarlılık raporu — SALT OKUNUR.
 *
 * Plugin'in LinkConsistencyCheck çıktısını (JSON) botun audit kayıtlarıyla
 * (cases: link_create / link_delete) karşılaştırır ve kanıt gerektiren kayıtları
 * listeler. Hiçbir kaydı değiştirmez, gerçek sahibi tahmin etmez.
 *
 *   node scripts/link-consistency.js <plugin-rapor.json> [bot.db]
 */
import { readFileSync } from 'node:fs';

async function openReadOnly(path) {
  try {
    const { default: Database } = await import('better-sqlite3');
    return new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(path, { readOnly: true });
  }
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

const [reportPath, dbPath = 'data/bot.db'] = process.argv.slice(2);
if (!reportPath) fail('Kullanım: node scripts/link-consistency.js <plugin-rapor.json> [bot.db]');

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (err) {
  fail(`Plugin raporu okunamadı: ${err.message}`);
}
const links = Array.isArray(report.links) ? report.links : [];
const byDiscord = new Map();
for (const link of links) {
  const id = String(link.discordId);
  if (!byDiscord.has(id)) byDiscord.set(id, []);
  byDiscord.get(id).push(link);
}

const db = await openReadOnly(dbPath);
const cases = db.prepare(`SELECT id, action, user_id, mod_id, detail, created_at FROM cases
  WHERE action IN ('link_create', 'link_delete') AND user_id IS NOT NULL ORDER BY created_at, id`).all();

const review = [];
const nameOf = (detail) => String(detail ?? '').replace(/\s*\([0-9a-f-]{36}\)\s*$/i, '').replace(/`/g, '').trim();
const uuidOf = (detail) => String(detail ?? '').match(/\(([0-9a-f-]{36})\)\s*$/i)?.[1]?.toLowerCase() ?? null;
const nameKey = (name) => String(name ?? '').trim().toLowerCase();

// Old audit rows carry only names. Resolve them only when current links and UUID
// audit history agree on a single owner of that name; renames/reused names stay ambiguous.
const aliases = new Map();
function addAlias(discordId, name, uuid) {
  if (!name || !uuid) return;
  const key = `${discordId}\0${nameKey(name)}`;
  if (!aliases.has(key)) aliases.set(key, new Set());
  aliases.get(key).add(uuid.toLowerCase());
}
for (const link of links) {
  addAlias(String(link.discordId), link.mcName, link.uuid);
  addAlias(String(link.discordId), link.currentName, link.uuid);
}
for (const record of cases) addAlias(String(record.user_id), nameOf(record.detail), uuidOf(record.detail));

/** Last audit per Discord + Minecraft identity, including conservatively resolved legacy rows. */
const lastBotRecord = new Map();
for (const row of cases) {
  const discordId = String(row.user_id);
  const name = nameKey(nameOf(row.detail));
  const owners = aliases.get(`${discordId}\0${name}`);
  const uuid = uuidOf(row.detail) ?? (owners?.size === 1 ? [...owners][0] : null);
  const identity = uuid ? `uuid:${uuid}` : `name:${name}`;
  lastBotRecord.set(`${discordId}\0${identity}`, { discordId, uuid, name, record: row });
}

for (const { discordId, uuid, name, record } of lastBotRecord.values()) {
  const discordLinks = byDiscord.get(discordId) ?? [];
  const matching = discordLinks.filter((link) => uuid
    ? link.uuid?.toLowerCase() === uuid
    : [link.mcName, link.currentName].some((n) => name && nameKey(n) === name));
  if (record.action === 'link_create') {
    if (!matching.length) {
      const nameMismatch = !uuid && discordLinks.length > 0;
      review.push({
        discordId, uuid,
        tür: nameMismatch ? 'farkli_ad' : 'bot_bagli_saniyor_plugin_bagli_degil',
        botKaydı: record,
        ...(nameMismatch ? { pluginBağlantıları: discordLinks } : {}),
        not: nameMismatch ? 'Eski isim kaydı güncel hesaplarla eşleşmiyor; isim değişmiş olabilir.'
          : 'Bu Minecraft hesabının bağlantısı oyun içinden ya da eski sürümden kaldırılmış olabilir.',
      });
    }
  } else if (uuid && matching.length === 1 && Number(matching[0].linkedAt) <= Number(record.created_at)) {
    review.push({
      discordId, uuid: matching[0].uuid,
      tür: 'bot_silindi_saniyor_plugin_bagli', botKaydı: record, pluginBağlantısı: matching[0],
      not: 'Bu Minecraft hesabı için bot silme kaydından sonra yeni bağlama görünmüyor.',
    });
  }
}

const withoutBotRecord = links.filter((link) => !lastBotRecord.has(`${link.discordId}\0uuid:${link.uuid.toLowerCase()}`));

const output = {
  araç: 'scripts/link-consistency.js',
  not: 'Salt rapor. Hiçbir kayıt değiştirilmedi; incelenecek kayıtlar yalnız kanıtla düzeltilmeli.',
  pluginÖzeti: report.summary ?? null,
  botAuditKaydı: cases.length,
  incelenecek: review,
  botKaydıOlmayanBağlantılar: withoutBotRecord.length,
  aynıAdıPaylaşanBağlantılar: report.duplicateNameLinks ?? [],
  adıBaşkasınaGeçmişBağlantılar: report.nameTakenByOtherPlayer ?? [],
  geçersizDiscordId: report.invalidDiscordIds ?? [],
};
console.log(JSON.stringify(output, null, 2));
console.error(`[link-consistency] ${links.length} plugin bağlantısı, ${cases.length} bot kaydı, `
  + `${review.length} inceleme gerektiren kayıt.`);
