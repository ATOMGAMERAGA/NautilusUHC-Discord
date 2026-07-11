import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
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
/* Guard (anti-nuke) hit log                                           */
/* ------------------------------------------------------------------ */

const addGuardHitStmt = db.prepare(
  'INSERT INTO guard_hits (user_id, kind, detail, created_at) VALUES (?, ?, ?, ?)',
);

export function addGuardHit(userId, kind, detail) {
  addGuardHitStmt.run(userId, kind, detail ?? null, Date.now());
}
