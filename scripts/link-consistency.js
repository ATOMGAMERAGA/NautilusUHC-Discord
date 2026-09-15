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
const byDiscord = new Map(links.map((link) => [String(link.discordId), link]));

const db = await openReadOnly(dbPath);
const cases = db.prepare(`SELECT id, action, user_id, mod_id, detail, created_at FROM cases
  WHERE action IN ('link_create', 'link_delete') AND user_id IS NOT NULL ORDER BY created_at, id`).all();

/** Discord ID başına botun son kaydı. */
const lastBotRecord = new Map();
for (const row of cases) lastBotRecord.set(String(row.user_id), row);

const review = [];
const nameOf = (detail) => String(detail ?? '').replace(/\s*\([0-9a-f-]{36}\)\s*$/i, '').replace(/`/g, '').trim();
const uuidOf = (detail) => String(detail ?? '').match(/\(([0-9a-f-]{36})\)\s*$/i)?.[1] ?? null;

for (const [discordId, record] of lastBotRecord) {
  const link = byDiscord.get(discordId);
  if (record.action === 'link_create') {
    if (!link) {
      review.push({
        discordId, tür: 'bot_bagli_saniyor_plugin_bagli_degil', botKaydı: record,
        not: 'Bağlantı oyun içinden ya da eski sürümden kaldırılmış olabilir.',
      });
      continue;
    }
    const recordedUuid = uuidOf(record.detail);
    const recordedName = nameOf(record.detail);
    const uuidMismatch = recordedUuid && recordedUuid !== link.uuid;
    const nameMismatch = !recordedUuid && recordedName
      && ![link.mcName, link.currentName].some((n) => String(n ?? '').toLowerCase() === recordedName.toLowerCase());
    if (uuidMismatch || nameMismatch) {
      review.push({
        discordId,
        tür: uuidMismatch ? 'farkli_uuid' : 'farkli_ad',
        botKaydı: record,
        pluginBağlantısı: link,
        not: 'Bot bu Discord hesabını başka bir Minecraft hesabıyla kaydetmiş. Ad değişikliği olabilir; '
          + 'kanıt olmadan bağlantıyı değiştirme.',
      });
    }
  } else if (link && Number(link.linkedAt) <= Number(record.created_at)) {
    review.push({
      discordId, tür: 'bot_silindi_saniyor_plugin_bagli', botKaydı: record, pluginBağlantısı: link,
      not: 'Bot silme kaydından sonra yeni bağlama görünmüyor.',
    });
  }
}

const withoutBotRecord = links.filter((link) => !lastBotRecord.has(String(link.discordId)));

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
