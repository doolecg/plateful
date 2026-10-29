import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { UNITS, parseQuantity, withGrams } from '../public/units.js';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'larder.db'));
db.pragma('journal_mode = WAL');

const SCHEMA = `
CREATE TABLE profiles (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  pin_hash   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- One row per signed-in device; the token lives in an HttpOnly cookie
CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE settings (
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (profile_id, key)
);
CREATE TABLE messages (
  id            INTEGER PRIMARY KEY,
  profile_id    INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  date          TEXT NOT NULL,
  text          TEXT NOT NULL DEFAULT '',
  images        TEXT NOT NULL DEFAULT '[]',
  note          TEXT,
  error         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER
);
CREATE TABLE entries (
  id         INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  meal       TEXT NOT NULL,
  name       TEXT NOT NULL,
  quantity   TEXT NOT NULL DEFAULT '',
  kcal       REAL NOT NULL,
  fat        REAL NOT NULL DEFAULT 0,
  carbs      REAL NOT NULL DEFAULT 0,
  protein    REAL NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'est.',
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX entries_profile_date ON entries(profile_id, date);
CREATE TABLE weights (
  id         INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  kg         REAL NOT NULL,
  UNIQUE (profile_id, date)
);
-- Saved foods are quick-add chips: values are for one "per" of "unit"
-- (e.g. per 100 g, or per 1 pack), and scaled by the amount entered.
CREATE TABLE foods (
  id         INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name       TEXT NOT NULL COLLATE NOCASE,
  unit       TEXT NOT NULL,
  per        REAL NOT NULL,
  kcal       REAL NOT NULL,
  fat        REAL NOT NULL DEFAULT 0,
  carbs      REAL NOT NULL DEFAULT 0,
  protein    REAL NOT NULL DEFAULT 0,
  UNIQUE (profile_id, name)
);
`;

export const DEFAULT_SETTINGS = {
  daily_kcal: '2000',
  flex_kcal: '2300',
  // 'auto' = the first day of the week that goes over the daily target becomes the flex day
  flex_day: 'auto',
  goal_kg: '',
  // 'auto' = Haiku for typed messages, Sonnet for photos; or 'sonnet' / 'haiku' for everything
  model_mode: 'auto',
};

const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

// user_version 2 = profiles. A database from before profiles has tables but version 0,
// and everything in it becomes the first profile's.
if (db.pragma('user_version', { simple: true }) < 2) {
  db.transaction(() => {
    if (hasTable('entries')) {
      const old = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
      for (const t of ['settings', 'messages', 'entries', 'weights', 'foods']) db.exec(`ALTER TABLE ${t} RENAME TO old_${t}`);
      db.exec('DROP INDEX IF EXISTS entries_date');
      db.exec(SCHEMA);
      db.prepare('INSERT INTO profiles (id, name) VALUES (1, ?)').run(old.name || 'Me');
      const put = db.prepare('INSERT INTO settings (profile_id, key, value) VALUES (1, ?, ?)');
      for (const k of Object.keys(DEFAULT_SETTINGS)) if (old[k] !== undefined) put.run(k, old[k]);
      db.exec(`
        INSERT INTO messages SELECT id, 1, created_at, date, text, images, note, error, input_tokens, output_tokens FROM old_messages;
        INSERT INTO entries SELECT id, 1, date, meal, name, quantity, kcal, fat, carbs, protein, source, message_id, created_at FROM old_entries;
        INSERT INTO weights (id, profile_id, date, kg) SELECT id, 1, date, kg FROM old_weights;
        INSERT INTO foods SELECT id, 1, name, unit, per, kcal, fat, carbs, protein FROM old_foods;
        DROP TABLE old_entries; DROP TABLE old_messages; DROP TABLE old_weights; DROP TABLE old_foods; DROP TABLE old_settings;
      `);
    } else {
      // A fresh install starts empty; the app asks for the first person when it opens
      db.exec(SCHEMA);
    }
    db.pragma('user_version = 2');
  })();
}
// user_version 3 = preset meals. profile_id NULL on a preset means it's shared with everyone.
if (db.pragma('user_version', { simple: true }) < 3) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE presets (
        id         INTEGER PRIMARY KEY,
        profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
        created_by INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
        name       TEXT NOT NULL,
        meal       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE preset_items (
        id        INTEGER PRIMARY KEY,
        preset_id INTEGER NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
        name      TEXT NOT NULL,
        quantity  TEXT NOT NULL DEFAULT '',
        kcal      REAL NOT NULL,
        fat       REAL NOT NULL DEFAULT 0,
        carbs     REAL NOT NULL DEFAULT 0,
        protein   REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE preset_uses (
        id         INTEGER PRIMARY KEY,
        preset_id  INTEGER NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        date       TEXT NOT NULL,
        meal       TEXT NOT NULL
      );
      CREATE INDEX preset_uses_profile ON preset_uses(profile_id, date);
    `);
    db.pragma('user_version = 3');
  })();
}
// user_version 4 = structured amounts. quantity stays as the display text; amount + unit + grams
// (plus density for volumes, each_g for counts) let the app convert between units itself.
if (db.pragma('user_version', { simple: true }) < 4) {
  db.transaction(() => {
    for (const t of ['entries', 'preset_items']) {
      for (const col of ['amount REAL', 'unit TEXT', 'grams REAL', 'density REAL', 'each_g REAL']) db.exec(`ALTER TABLE ${t} ADD COLUMN ${col}`);
      // origin: a short note on where the numbers came from when it's not a Claude message ("Copied from Sam’s log", "Preset: …")
      // edited_at: set when someone changes the amount or numbers by hand
      if (t === 'entries') db.exec('ALTER TABLE entries ADD COLUMN origin TEXT; ALTER TABLE entries ADD COLUMN edited_at TEXT');
      const put = db.prepare(`UPDATE ${t} SET amount = @amount, unit = @unit, grams = @grams, density = @density, each_g = @each_g WHERE id = @id`);
      for (const row of db.prepare(`SELECT id, quantity FROM ${t}`).all()) {
        const q = parseQuantity(row.quantity);
        // A count ("1 pack") has no known weight yet, so leave grams empty rather than guess
        if (q) put.run({ density: null, each_g: null, grams: null, ...(UNITS[q.unit].kind === 'count' ? q : withGrams(q)), id: row.id });
      }
    }
    db.exec('ALTER TABLE messages ADD COLUMN model TEXT');
    db.pragma('user_version = 4');
  })();
}
db.pragma('foreign_keys = ON');

export function getSettings(profileId) {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings WHERE profile_id = ?').all(profileId)) out[row.key] = row.value;
  return {
    daily_kcal: Number(out.daily_kcal),
    flex_kcal: Number(out.flex_kcal),
    flex_day: out.flex_day,
    goal_kg: out.goal_kg === '' ? null : Number(out.goal_kg),
    model_mode: ['auto', 'sonnet', 'haiku'].includes(out.model_mode) ? out.model_mode : 'auto',
  };
}

export function saveSettings(profileId, patch) {
  const put = db.prepare(`INSERT INTO settings (profile_id, key, value) VALUES (?, ?, ?)
                          ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value`);
  db.transaction(() => {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (patch[k] !== undefined) put.run(profileId, k, String(patch[k]));
    }
    if (typeof patch.name === 'string' && patch.name.trim()) {
      db.prepare('UPDATE profiles SET name = ? WHERE id = ?').run(patch.name.trim(), profileId);
    }
  })();
}
