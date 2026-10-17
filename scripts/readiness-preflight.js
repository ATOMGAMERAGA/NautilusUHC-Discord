/** node scripts/readiness-preflight.js evidence.json [--db existing-bot.db] */
import { readFileSync, statSync } from 'node:fs';
import { evaluateReadiness } from '../src/readinesspreflight.js';

async function databaseEvidence(path) {
  let database;
  try {
    if (!statSync(path).isFile()) return { reachable: false };
    try {
      const { default: Database } = await import('better-sqlite3');
      database = new Database(path, { readonly: true, fileMustExist: true });
    } catch {
      const { DatabaseSync } = await import('node:sqlite');
      database = new DatabaseSync(path, { readOnly: true });
    }
    const integrity = Object.values(database.prepare('PRAGMA quick_check').get() ?? {})[0];
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('settings', 'processed_events')").all();
    return { reachable: true, integrity: integrity === 'ok' ? 'ok' : 'failed', requiredTablesPresent: tables.length === 2 };
  } catch {
    // Neither driver errors nor paths/SQL contents are emitted (may contain sensitive data).
    return { reachable: false };
  } finally { database?.close(); }
}

const [path, option, dbPath, ...extra] = process.argv.slice(2);
if (!path || extra.length || (option && (option !== '--db' || !dbPath))) {
  console.error('Kullanım: node scripts/readiness-preflight.js evidence.json [--db existing-bot.db]');
  process.exitCode = 2;
} else {
  try {
    const evidence = JSON.parse(readFileSync(path, 'utf8'));
    if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error();
    if (dbPath) evidence.database = await databaseEvidence(dbPath);
    const report = evaluateReadiness(evidence);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ready ? 0 : 1;
  } catch {
    console.error('Kanıt JSON dosyası okunamadı veya kök değeri nesne değil; hiçbir değişiklik yapılmadı.');
    process.exitCode = 2;
  }
}
