import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

/*
 * SQLite sürücüsü: üretimde better-sqlite3 (package.json bağımlılığı).
 * Testler ve npm install yapılmamış geliştirme ortamları için Node'un
 * yerleşik node:sqlite modülüne (Node ≥ 22.5) aynı API yüzeyiyle düşülür —
 * böylece "bot testleri bağımlılıksız saf Node ile koşar" kuralı korunur.
 */
async function openDatabase(path) {
  try {
    const { default: Database } = await import('better-sqlite3');
    return new Database(path);
  } catch {
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path);
    const wrapStmt = (stmt) => ({
      run: (...a) => stmt.run(...a),
      get: (...a) => stmt.get(...a),
      all: (...a) => stmt.all(...a),
    });
    return {
      exec: (sql) => raw.exec(sql),
      pragma: (p) => raw.exec(`PRAGMA ${p}`),
      prepare: (sql) => wrapStmt(raw.prepare(sql)),
      transaction: (fn) => (...args) => {
        raw.exec('BEGIN');
        try {
          const out = fn(...args);
          raw.exec('COMMIT');
          return out;
        } catch (e) {
          raw.exec('ROLLBACK');
          throw e;
        }
      },
    };
  }
}

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = await openDatabase(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS warns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  mod_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_warns_user ON warns(user_id);
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  user_id TEXT,
  mod_id TEXT,
  reason TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guard_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(done, run_at);
CREATE TABLE IF NOT EXISTS giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  prize TEXT NOT NULL,
  winner_count INTEGER NOT NULL DEFAULT 1,
  ends_at INTEGER NOT NULL,
  ended INTEGER NOT NULL DEFAULT 0,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (giveaway_id, user_id)
);
CREATE TABLE IF NOT EXISTS polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  ends_at INTEGER,
  ended INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  choice INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id)
);
CREATE TABLE IF NOT EXISTS tickets (
  channel_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

/* ------------------------------------------------------------------ */
/* Migrations — sürümlü, idempotent şema değişiklikleri                */
/*                                                                     */
/* Yukarıdaki CREATE IF NOT EXISTS bloğu tarihsel taban şemadır (v0).  */
/* Yeni her şema değişikliği buraya BİR SONRAKİ sürüm numarasıyla      */
/* eklenir; asla eski bir migration değiştirilmez.                     */
/* ------------------------------------------------------------------ */

db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`);

const MIGRATIONS = [
  {
    version: 1,
    // Köprü eventleri için idempotency: aynı eventId ikinci kez işlenmez.
    sql: `CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      received_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_processed_events_time ON processed_events(received_at);`,
  },
  {
    version: 2,
    // /maç-bildirim kişisel DM abonelikleri (restartta kalıcı).
    sql: `CREATE TABLE IF NOT EXISTS dm_subscriptions (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      last_error TEXT,
      last_error_at INTEGER
    );`,
  },
  {
    version: 3,
    // Destek sistemi 2.0: numaralı talepler, tam transcript deposu, notlar,
    // kara liste. Eski `tickets` tablosu tarihsel olarak yerinde bırakılır;
    // açık satırları tickets_v2'ye 'genel' türüyle taşınır.
    sql: `CREATE TABLE IF NOT EXISTS tickets_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'genel',
      subject TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      assignee_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      claimed_at INTEGER,
      first_response_at INTEGER,
      closed_at INTEGER,
      closed_by TEXT,
      close_reason TEXT,
      reopen_count INTEGER NOT NULL DEFAULT 0,
      satisfaction INTEGER,
      sla_warned INTEGER NOT NULL DEFAULT 0,
      inactivity_warned_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_v2_status ON tickets_v2(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_v2_user ON tickets_v2(user_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_v2_channel ON tickets_v2(channel_id);
    CREATE TABLE IF NOT EXISTS ticket_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      author_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_notes_ticket ON ticket_notes(ticket_id);
    CREATE TABLE IF NOT EXISTS ticket_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      message_id TEXT,
      author_id TEXT,
      author_tag TEXT,
      content TEXT,
      embeds_summary TEXT,
      attachments TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id);
    CREATE TABLE IF NOT EXISTS ticket_blacklist (
      user_id TEXT PRIMARY KEY,
      reason TEXT,
      added_by TEXT,
      created_at INTEGER NOT NULL
    );
    INSERT INTO tickets_v2 (channel_id, user_id, type, status, priority, created_at)
      SELECT channel_id, user_id, 'genel', 'open', 'normal', created_at FROM tickets;`,
  },
  {
    version: 4,
    // W4 moderasyon: kullanıcı başına kalıcı yetkili notları (/not).
    sql: `CREATE TABLE IF NOT EXISTS user_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_notes_user ON user_notes(user_id);`,
  },
  {
    version: 5,
    // Hesap bağlama yan işlemleri (audit/log/rol) için kalıcı, sınırlı yeniden
    // denemeli kuyruk ve yönetim paneli durumları. Ham bağlantı kodu saklanmaz.
    sql: `CREATE TABLE IF NOT EXISTS link_side_effects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      effect_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      note TEXT,
      next_attempt_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_link_side_effects_due ON link_side_effects(status, next_attempt_at);
    CREATE TABLE IF NOT EXISTS link_admin_panels (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      instance_id TEXT,
      uuid TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      link_id TEXT NOT NULL,
      mc_name TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );`,
  },
];

{
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version),
  );
  const mark = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      mark.run(m.version, Date.now());
    })();
    console.log(`[db] migration v${m.version} uygulandı`);
  }
}

/* ------------------------------------------------------------------ */
/* Hesap bağlama yan işlemleri (outbox) ve yönetim panelleri            */
/* ------------------------------------------------------------------ */

export const linkSideEffects = {
  /** Aynı effect_key ikinci kez eklenmez (işlem başına bir kez). true = yeni kayıt. */
  enqueue: ({ key, kind, payload, at = Date.now() }) =>
    db.prepare(`INSERT OR IGNORE INTO link_side_effects
      (effect_key, kind, payload, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`)
      .run(key, kind, JSON.stringify(payload ?? {}), at, at, at).changes > 0,
  due: (at = Date.now(), limit = 20) =>
    db.prepare(`SELECT * FROM link_side_effects WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at, id LIMIT ?`).all(at, limit),
  get: (key) => db.prepare('SELECT * FROM link_side_effects WHERE effect_key = ?').get(key),
  markDone: (id, at = Date.now(), note = null) =>
    db.prepare(`UPDATE link_side_effects SET status = 'done', note = ?, last_error = NULL, updated_at = ?
      WHERE id = ?`).run(note, at, id),
  markRetry: (id, attempts, error, nextAt, at = Date.now()) =>
    db.prepare(`UPDATE link_side_effects SET attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ?`).run(attempts, error, nextAt, at, id),
  markFailed: (id, attempts, error, at = Date.now()) =>
    db.prepare(`UPDATE link_side_effects SET status = 'failed', attempts = ?, last_error = ?, updated_at = ?
      WHERE id = ?`).run(attempts, error, at, id),
  counts: () => Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS n FROM link_side_effects GROUP BY status').all()
      .map((r) => [r.status, r.n]),
  ),
  recentProblems: (limit = 5) =>
    db.prepare(`SELECT kind, effect_key, status, attempts, last_error, updated_at FROM link_side_effects
      WHERE last_error IS NOT NULL AND status != 'done' ORDER BY updated_at DESC LIMIT ?`).all(limit),
  /** Yetkili isteğiyle kalıcı başarısız kaydı yeniden kuyruğa al. */
  retryFailed: (key, at = Date.now()) =>
    db.prepare(`UPDATE link_side_effects SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?
      WHERE effect_key = ? AND status = 'failed'`).run(at, at, key).changes > 0,
};

export const linkAdminPanels = {
  create: ({
    id, ownerId, instanceId = null, uuid, discordId, linkId, mcName = null, reason = null,
    at = Date.now(), ttlMs = 15 * 60_000,
  }) => db.prepare(`INSERT INTO link_admin_panels
      (id, owner_id, instance_id, uuid, discord_id, link_id, mc_name, reason, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ownerId, instanceId, uuid, discordId, linkId, mcName, reason, at, at + ttlMs),
  get: (id) => db.prepare('SELECT * FROM link_admin_panels WHERE id = ?').get(id),
  setReason: (id, reason) =>
    db.prepare('UPDATE link_admin_panels SET reason = ? WHERE id = ? AND used_at IS NULL').run(reason, id),
  /** Tek kullanımlık: yalnız ilk onay true döner. */
  markUsed: (id, at = Date.now()) =>
    db.prepare('UPDATE link_admin_panels SET used_at = ? WHERE id = ? AND used_at IS NULL').run(at, id).changes > 0,
  prune: (at = Date.now()) =>
    db.prepare('DELETE FROM link_admin_panels WHERE expires_at < ?').run(at - 24 * 3600_000).changes,
};

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

export function getSetting(key, fallback = null) {
  const row = getSettingStmt.get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}

/* ------------------------------------------------------------------ */
/* Warns                                                               */
/* ------------------------------------------------------------------ */

const addWarnStmt = db.prepare(
  'INSERT INTO warns (user_id, mod_id, reason, created_at) VALUES (?, ?, ?, ?)',
);
const warnsOfStmt = db.prepare(
  'SELECT id, mod_id, reason, created_at FROM warns WHERE user_id = ? ORDER BY id DESC',
);
const delWarnStmt = db.prepare('DELETE FROM warns WHERE id = ? AND user_id = ?');
const clearWarnsStmt = db.prepare('DELETE FROM warns WHERE user_id = ?');

export function addWarn(userId, modId, reason) {
  return addWarnStmt.run(userId, modId, reason, Date.now()).lastInsertRowid;
}

export function warnsOf(userId) {
  return warnsOfStmt.all(userId);
}

export function deleteWarn(id, userId) {
  return delWarnStmt.run(id, userId).changes > 0;
}

export function clearWarns(userId) {
  return clearWarnsStmt.run(userId).changes;
}

/* ------------------------------------------------------------------ */
/* Mod cases (audit trail for every bot moderation action)             */
/* ------------------------------------------------------------------ */

const addCaseStmt = db.prepare(
  'INSERT INTO cases (action, user_id, mod_id, reason, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
);
const casesOfStmt = db.prepare(
  'SELECT id, action, mod_id, reason, detail, created_at FROM cases WHERE user_id = ? ORDER BY id DESC LIMIT ?',
);

export function addCase(action, userId, modId, reason, detail = null) {
  return addCaseStmt.run(action, userId ?? null, modId ?? null, reason ?? null, detail, Date.now())
    .lastInsertRowid;
}

export function casesOf(userId, limit = 15) {
  return casesOfStmt.all(userId, limit);
}

/** /sicil sayfalaması: OFFSET'li sayfa + toplam sayı. */
export function casesOfPage(userId, limit = 10, offset = 0) {
  return db.prepare(
    'SELECT id, action, mod_id, reason, detail, created_at FROM cases WHERE user_id = ? '
    + 'ORDER BY id DESC LIMIT ? OFFSET ?',
  ).all(userId, limit, offset);
}

export function caseCount(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM cases WHERE user_id = ?').get(userId).n;
}

/* ------------------------------------------------------------------ */
/* Kullanıcı notları (W4 — /not)                                       */
/* ------------------------------------------------------------------ */

export const userNotes = {
  add: (userId, authorId, note) =>
    db.prepare('INSERT INTO user_notes (user_id, author_id, note, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, authorId, note, Date.now()).lastInsertRowid,
  of: (userId, limit = 25) =>
    db.prepare('SELECT id, author_id, note, created_at FROM user_notes WHERE user_id = ? '
      + 'ORDER BY id DESC LIMIT ?').all(userId, limit),
  remove: (id, userId) =>
    db.prepare('DELETE FROM user_notes WHERE id = ? AND user_id = ?').run(id, userId).changes > 0,
  count: (userId) =>
    db.prepare('SELECT COUNT(*) AS n FROM user_notes WHERE user_id = ?').get(userId).n,
};

/* ------------------------------------------------------------------ */
/* Scheduled tasks (persistent — survive restarts)                     */
/* ------------------------------------------------------------------ */

const addTaskStmt = db.prepare('INSERT INTO tasks (type, run_at, data) VALUES (?, ?, ?)');
const dueTasksStmt = db.prepare('SELECT id, type, run_at, data FROM tasks WHERE done = 0 AND run_at <= ? ORDER BY run_at LIMIT 20');
const finishTaskStmt = db.prepare('UPDATE tasks SET done = 1 WHERE id = ?');
const cancelTasksStmt = db.prepare("UPDATE tasks SET done = 1 WHERE done = 0 AND type = ? AND data LIKE ?");

export function scheduleTask(type, runAt, data = {}) {
  return addTaskStmt.run(type, runAt, JSON.stringify(data)).lastInsertRowid;
}

export function dueTasks(now = Date.now()) {
  return dueTasksStmt.all(now).map((t) => ({ ...t, data: JSON.parse(t.data || '{}') }));
}

export function finishTask(id) {
  finishTaskStmt.run(id);
}

/** Cancels pending tasks of a type whose data JSON contains the given fragment. */
export function cancelTasks(type, dataFragment) {
  return cancelTasksStmt.run(type, `%${dataFragment}%`).changes;
}

/** Bekleyen (done=0) zamanlanmış görev sayısı — /sağlık için. */
export function pendingTaskCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE done = 0').get().n;
}

/* ------------------------------------------------------------------ */
/* Giveaways                                                           */
/* ------------------------------------------------------------------ */

export const giveaways = {
  create: (channelId, prize, winnerCount, endsAt, createdBy) =>
    db.prepare('INSERT INTO giveaways (channel_id, prize, winner_count, ends_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(channelId, prize, winnerCount, endsAt, createdBy).lastInsertRowid,
  setMessage: (id, messageId) =>
    db.prepare('UPDATE giveaways SET message_id = ? WHERE id = ?').run(messageId, id),
  get: (id) => db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id),
  end: (id) => db.prepare('UPDATE giveaways SET ended = 1 WHERE id = ?').run(id),
  enter: (id, userId) => {
    try {
      db.prepare('INSERT INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)').run(id, userId);
      return true;
    } catch {
      return false; // already entered
    }
  },
  entries: (id) =>
    db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?').all(id).map((r) => r.user_id),
};

/* ------------------------------------------------------------------ */
/* Polls                                                               */
/* ------------------------------------------------------------------ */

export const polls = {
  create: (channelId, question, options, endsAt) =>
    db.prepare('INSERT INTO polls (channel_id, question, options, ends_at) VALUES (?, ?, ?, ?)')
      .run(channelId, question, JSON.stringify(options), endsAt).lastInsertRowid,
  setMessage: (id, messageId) =>
    db.prepare('UPDATE polls SET message_id = ? WHERE id = ?').run(messageId, id),
  get: (id) => {
    const row = db.prepare('SELECT * FROM polls WHERE id = ?').get(id);
    return row ? { ...row, options: JSON.parse(row.options) } : null;
  },
  end: (id) => db.prepare('UPDATE polls SET ended = 1 WHERE id = ?').run(id),
  vote: (pollId, userId, choice) =>
    db.prepare('INSERT INTO poll_votes (poll_id, user_id, choice) VALUES (?, ?, ?) '
      + 'ON CONFLICT(poll_id, user_id) DO UPDATE SET choice = excluded.choice').run(pollId, userId, choice),
  counts: (pollId) => {
    const rows = db.prepare('SELECT choice, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY choice').all(pollId);
    return Object.fromEntries(rows.map((r) => [r.choice, r.n]));
  },
};

/* ------------------------------------------------------------------ */
/* Tickets                                                             */
/* ------------------------------------------------------------------ */

export const tickets = {
  create: (channelId, userId) =>
    db.prepare('INSERT INTO tickets (channel_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(channelId, userId, Date.now()),
  get: (channelId) => db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId),
  openByUser: (userId) => db.prepare('SELECT * FROM tickets WHERE user_id = ?').all(userId),
  close: (channelId) => db.prepare('DELETE FROM tickets WHERE channel_id = ?').run(channelId),
};

/* ------------------------------------------------------------------ */
/* Tickets v2 — numaralı destek talepleri (Faz 5)                      */
/* ------------------------------------------------------------------ */

export const ticketsV2 = {
  /** Yeni talep satırı; talep numarası (id) döner. Kanal sonra bağlanır. */
  create: ({ userId, type = 'genel', subject = null, description = null, priority = 'normal' }) =>
    db.prepare(`INSERT INTO tickets_v2 (user_id, type, subject, description, status, priority, created_at)
      VALUES (?, ?, ?, ?, 'open', ?, ?)`)
      .run(userId, type, subject, description, priority, Date.now()).lastInsertRowid,

  get: (id) => db.prepare('SELECT * FROM tickets_v2 WHERE id = ?').get(id),
  getByChannel: (channelId) =>
    db.prepare("SELECT * FROM tickets_v2 WHERE channel_id = ? AND status != 'closed'").get(channelId),

  setChannel: (id, channelId) =>
    db.prepare('UPDATE tickets_v2 SET channel_id = ? WHERE id = ?').run(channelId, id),

  /** Kullanıcının açık/beklemedeki talepleri. */
  openByUser: (userId) =>
    db.prepare("SELECT * FROM tickets_v2 WHERE user_id = ? AND status IN ('open','pending') ORDER BY id").all(userId),

  /** Kullanıcının en son talep açma zamanı (cooldown için — kapananlar dahil). */
  lastCreatedAt: (userId) =>
    db.prepare('SELECT MAX(created_at) AS t FROM tickets_v2 WHERE user_id = ?').get(userId)?.t ?? null,

  /** Açık/beklemedeki tüm talepler (reconciliation + SLA taraması). */
  active: () => db.prepare("SELECT * FROM tickets_v2 WHERE status IN ('open','pending') ORDER BY id").all(),

  listByStatus: (status = null, limit = 25) => (status
    ? db.prepare('SELECT * FROM tickets_v2 WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM tickets_v2 ORDER BY id DESC LIMIT ?').all(limit)),

  openCount: () =>
    db.prepare("SELECT COUNT(*) AS n FROM tickets_v2 WHERE status IN ('open','pending')").get().n,

  claim: (id, assigneeId) =>
    db.prepare('UPDATE tickets_v2 SET assignee_id = ?, claimed_at = ? WHERE id = ?')
      .run(assigneeId, Date.now(), id),
  unclaim: (id) =>
    db.prepare('UPDATE tickets_v2 SET assignee_id = NULL, claimed_at = NULL WHERE id = ?').run(id),

  setPriority: (id, priority) =>
    db.prepare('UPDATE tickets_v2 SET priority = ?, sla_warned = 0 WHERE id = ?').run(priority, id),

  setStatus: (id, status) =>
    db.prepare('UPDATE tickets_v2 SET status = ? WHERE id = ?').run(status, id),

  /** İlk yetkili yanıtının zamanı (yalnız ilk kez yazılır). */
  setFirstResponse: (id, at = Date.now()) =>
    db.prepare('UPDATE tickets_v2 SET first_response_at = ? WHERE id = ? AND first_response_at IS NULL')
      .run(at, id),

  close: (id, { closedBy = null, reason = null } = {}) =>
    db.prepare(`UPDATE tickets_v2 SET status = 'closed', closed_at = ?, closed_by = ?, close_reason = ?
      WHERE id = ?`).run(Date.now(), closedBy, reason, id),

  /** closed→open: yeni kanal, reopen_count+1, kapanış ve uyarı alanları sıfırlanır. */
  reopen: (id, channelId) =>
    db.prepare(`UPDATE tickets_v2 SET status = 'open', channel_id = ?, reopen_count = reopen_count + 1,
      closed_at = NULL, closed_by = NULL, close_reason = NULL,
      sla_warned = 0, inactivity_warned_at = NULL WHERE id = ?`).run(channelId, id),

  /** Memnuniyet puanı (1-5) — yalnız bir kez. true = kaydedildi. */
  rate: (id, score) =>
    db.prepare('UPDATE tickets_v2 SET satisfaction = ? WHERE id = ? AND satisfaction IS NULL')
      .run(score, id).changes > 0,

  markSlaWarned: (id) => db.prepare('UPDATE tickets_v2 SET sla_warned = 1 WHERE id = ?').run(id),
  markInactivityWarned: (id, at = Date.now()) =>
    db.prepare('UPDATE tickets_v2 SET inactivity_warned_at = ? WHERE id = ?').run(at, id),

  /** Kanalı elle silinmiş talebi kapalıya çeker (reconciliation). */
  markOrphanClosed: (id, reason = 'kanal silinmiş (reconciliation)') =>
    db.prepare(`UPDATE tickets_v2 SET status = 'closed', closed_at = ?, close_reason = ?
      WHERE id = ? AND status != 'closed'`).run(Date.now(), reason, id).changes > 0,
};

export const ticketNotes = {
  add: (ticketId, authorId, note) =>
    db.prepare('INSERT INTO ticket_notes (ticket_id, author_id, note, created_at) VALUES (?, ?, ?, ?)')
      .run(ticketId, authorId, note, Date.now()).lastInsertRowid,
  of: (ticketId) =>
    db.prepare('SELECT * FROM ticket_notes WHERE ticket_id = ? ORDER BY id').all(ticketId),
};

export const ticketMessages = {
  add: (ticketId, { messageId = null, authorId = null, authorTag = null, content = null,
    embedsSummary = null, attachments = [], createdAt = Date.now() } = {}) =>
    db.prepare(`INSERT INTO ticket_messages
      (ticket_id, message_id, author_id, author_tag, content, embeds_summary, attachments, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ticketId, messageId, authorId, authorTag, content, embedsSummary,
        JSON.stringify(attachments ?? []), createdAt).lastInsertRowid,
  of: (ticketId) =>
    db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY id').all(ticketId),
  count: (ticketId) =>
    db.prepare('SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = ?').get(ticketId).n,
  lastAt: (ticketId) =>
    db.prepare('SELECT MAX(created_at) AS t FROM ticket_messages WHERE ticket_id = ?').get(ticketId)?.t ?? null,
};

export const ticketBlacklist = {
  add: (userId, reason, addedBy) =>
    db.prepare(`INSERT INTO ticket_blacklist (user_id, reason, added_by, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, added_by = excluded.added_by`)
      .run(userId, reason ?? null, addedBy ?? null, Date.now()),
  remove: (userId) => db.prepare('DELETE FROM ticket_blacklist WHERE user_id = ?').run(userId).changes > 0,
  get: (userId) => db.prepare('SELECT * FROM ticket_blacklist WHERE user_id = ?').get(userId),
  all: () => db.prepare('SELECT * FROM ticket_blacklist ORDER BY created_at DESC').all(),
};

/* ------------------------------------------------------------------ */
/* Processed events (köprü idempotency)                                */
/* ------------------------------------------------------------------ */

const claimEventStmt = db.prepare(
  'INSERT OR IGNORE INTO processed_events (event_id, type, received_at) VALUES (?, ?, ?)',
);
const releaseEventStmt = db.prepare('DELETE FROM processed_events WHERE event_id = ?');
const pruneEventsStmt = db.prepare('DELETE FROM processed_events WHERE received_at < ?');

export const processedEvents = {
  /**
   * Eventi işlenmek üzere sahiplenir. false dönerse aynı eventId daha önce
   * işlenmiş demektir (retry/duplicate) — tekrar yan etki üretme.
   */
  claim: (eventId, type) => claimEventStmt.run(eventId, type, Date.now()).changes > 0,
  /** İşleme başarısız olursa sahipliği bırak ki retry yeniden deneyebilsin. */
  release: (eventId) => releaseEventStmt.run(eventId),
  /** 7 günden eski kayıtları temizle (açılışta çağrılır). */
  prune: (maxAgeMs = 7 * 24 * 3600 * 1000) => pruneEventsStmt.run(Date.now() - maxAgeMs).changes,
};

/* ------------------------------------------------------------------ */
/* /maç-bildirim DM abonelikleri                                       */
/* ------------------------------------------------------------------ */

export const dmSubscriptions = {
  isEnabled: (userId) => {
    const row = db.prepare('SELECT enabled FROM dm_subscriptions WHERE user_id = ?').get(userId);
    return !!row?.enabled;
  },
  set: (userId, enabled) =>
    db.prepare(`INSERT INTO dm_subscriptions (user_id, enabled, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`)
      .run(userId, enabled ? 1 : 0, Date.now()),
  /** Aktif abonelerin user_id listesi. */
  enabledUserIds: () =>
    db.prepare('SELECT user_id FROM dm_subscriptions WHERE enabled = 1').all().map((r) => r.user_id),
  /** Son teslimat hatasını kaydet (kullanıcı tekrar açarken uyarı gösterilir). */
  recordError: (userId, error) =>
    db.prepare('UPDATE dm_subscriptions SET last_error = ?, last_error_at = ? WHERE user_id = ?')
      .run(String(error).slice(0, 200), Date.now(), userId),
  clearError: (userId) =>
    db.prepare('UPDATE dm_subscriptions SET last_error = NULL, last_error_at = NULL WHERE user_id = ?')
      .run(userId),
  lastError: (userId) =>
    db.prepare('SELECT last_error, last_error_at FROM dm_subscriptions WHERE user_id = ?').get(userId) ?? {},
};

/* ------------------------------------------------------------------ */
/* Guard (anti-nuke) hit log                                           */
/* ------------------------------------------------------------------ */

const addGuardHitStmt = db.prepare(
  'INSERT INTO guard_hits (user_id, kind, detail, created_at) VALUES (?, ?, ?, ?)',
);

export function addGuardHit(userId, kind, detail) {
  addGuardHitStmt.run(userId, kind, detail ?? null, Date.now());
}
