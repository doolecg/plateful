import { db } from './db.js';
import { addDays } from './dates.js';
import { UNITS, formatQuantity } from '../public/units.js';

const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const round1 = (n) => Math.round(n * 10) / 10;
const ITEM_COLS = 'name, quantity, amount, unit, grams, density, each_g, kcal, fat, carbs, protein, fibre, sugars, sat_fat, salt';
const ITEM_PARAMS = '@name, @quantity, @amount, @unit, @grams, @density, @each_g, @kcal, @fat, @carbs, @protein, @fibre, @sugars, @sat_fat, @salt';
const opt = (x) => (x === '' || x == null || !Number.isFinite(Number(x)) ? null : round1(Number(x)));
const SOURCE_WORDS = { label: 'read from a label', saved: 'a saved food', 'est.': 'Claude’s estimate', db: 'the food list', manual: 'typed in by hand', preset: 'a preset', copied: 'copied' };

// Same slots the app uses when it guesses a meal from the clock
export const mealForHour = (h) => (h < 11 ? 'breakfast' : h < 15 ? 'lunch' : h >= 17 && h < 22 ? 'dinner' : 'snacks');

const insertEntry = db.prepare(`INSERT INTO entries (profile_id, date, meal, ${ITEM_COLS}, source, origin)
                                VALUES (@profile_id, @date, @meal, ${ITEM_PARAMS}, @source, @origin)`);

function visiblePresets(profileId) {
  const presets = db.prepare(`SELECT p.id, p.name, p.meal, p.profile_id IS NULL AS shared, p.created_by, c.name AS created_by_name
                              FROM presets p LEFT JOIN profiles c ON c.id = p.created_by
                              WHERE p.profile_id = ? OR p.profile_id IS NULL ORDER BY p.name COLLATE NOCASE`).all(profileId);
  const items = db.prepare(`SELECT preset_id, ${ITEM_COLS} FROM preset_items WHERE preset_id IN (SELECT id FROM presets WHERE profile_id = ? OR profile_id IS NULL) ORDER BY id`).all(profileId);
  return presets.map((p) => {
    const its = items.filter((i) => i.preset_id === p.id);
    return { ...p, shared: !!p.shared, items: its, kcal: Math.round(its.reduce((s, i) => s + i.kcal, 0)) };
  });
}

// A meal's "signature" is its item names, so the same breakfast logged on different days matches
const signature = (items) => items.map((i) => i.name.trim().toLowerCase()).sort().join('|');

// Local, token-free suggestions: presets you use at this time of day, plus meals you've
// logged in this slot on two or more days in the last 30 that aren't presets yet.
function suggestions(profileId, date, slot) {
  const since = addDays(date, -60);
  const already = db.prepare('SELECT name FROM entries WHERE profile_id = ? AND date = ? AND meal = ?').all(profileId, date, slot);
  const loggedSig = new Set(already.map((e) => e.name.trim().toLowerCase()));
  const usedToday = new Set(db.prepare('SELECT preset_id FROM preset_uses WHERE profile_id = ? AND date = ?').all(profileId, date).map((r) => r.preset_id));
  const uses = db.prepare('SELECT preset_id, date, meal FROM preset_uses WHERE profile_id = ? AND date >= ? AND date < ?').all(profileId, since, date);

  const presets = visiblePresets(profileId);
  const out = [];
  for (const p of presets) {
    if (usedToday.has(p.id)) continue;
    const mine = uses.filter((u) => u.preset_id === p.id);
    const inSlot = mine.filter((u) => u.meal === slot).length;
    const recent = mine.some((u) => u.date >= addDays(date, -7));
    const score = inSlot * 3 + mine.length + (p.meal === slot ? 2 : 0) + (recent ? 1 : 0);
    if (p.meal === slot || inSlot) out.push({ kind: 'preset', id: p.id, name: p.name, meal: slot, items: p.items, kcal: p.kcal, score });
  }

  const presetSigs = new Set(presets.map((p) => signature(p.items)));
  const rows = db.prepare(`SELECT id, date, ${ITEM_COLS} FROM entries WHERE profile_id = ? AND meal = ? AND date >= ? AND date < ? ORDER BY date DESC, id`)
    .all(profileId, slot, addDays(date, -30), date);
  const byDay = new Map();
  for (const r of rows) byDay.set(r.date, [...(byDay.get(r.date) || []), r]);
  const habits = new Map();
  for (const items of byDay.values()) {
    const sig = signature(items);
    const h = habits.get(sig);
    if (h) h.count += 1;
    else habits.set(sig, { count: 1, items }); // rows are newest first, so this keeps the latest portions
  }
  for (const [sig, h] of habits) {
    if (h.count < 2 || presetSigs.has(sig) || h.items.every((i) => loggedSig.has(i.name.trim().toLowerCase()))) continue;
    const names = h.items.map((i) => i.name);
    out.push({
      kind: 'habit',
      name: names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(' & '),
      meal: slot,
      ids: h.items.map((i) => i.id),
      items: h.items.map(({ id, date: _d, ...i }) => i),
      kcal: Math.round(h.items.reduce((s, i) => s + i.kcal, 0)),
      count: h.count,
      score: h.count * 2,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4);
}

export function mealRoutes(app) {
  app.get('/api/presets', (req, res) => {
    const hour = Number(req.query.hour);
    const date = isDate(req.query.date) ? req.query.date : null;
    res.json({
      presets: visiblePresets(req.profile.id),
      suggestions: date && hour >= 0 && hour < 24 ? suggestions(req.profile.id, date, mealForHour(hour)) : [],
    });
  });

  // Saves a preset from entries in your own log (usually one meal of one day)
  app.post('/api/presets', (req, res) => {
    const { name, meal, shared, entry_ids: ids } = req.body;
    if (!name?.trim() || !MEALS.includes(meal) || !Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Need a name, a meal and some items.' });
    const items = db.prepare(`SELECT ${ITEM_COLS} FROM entries WHERE profile_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
      .all(req.profile.id, ...ids.map(Number));
    if (!items.length) return res.status(400).json({ error: 'Those items aren’t in your log.' });
    db.transaction(() => {
      const pid = db.prepare('INSERT INTO presets (profile_id, created_by, name, meal) VALUES (?, ?, ?, ?)')
        .run(shared ? null : req.profile.id, req.profile.id, name.trim(), meal).lastInsertRowid;
      const put = db.prepare(`INSERT INTO preset_items (preset_id, ${ITEM_COLS}) VALUES (@preset_id, ${ITEM_PARAMS})`);
      for (const i of items) put.run({ ...i, preset_id: pid });
    })();
    res.json({ ok: true });
  });

  app.post('/api/presets/:id/add', (req, res) => {
    const { date, meal } = req.body;
    const preset = db.prepare('SELECT * FROM presets WHERE id = ? AND (profile_id = ? OR profile_id IS NULL)').get(req.params.id, req.profile.id);
    if (!preset || !isDate(date)) return res.status(404).json({ error: 'No such preset.' });
    const into = MEALS.includes(meal) ? meal : preset.meal;
    const items = db.prepare(`SELECT ${ITEM_COLS} FROM preset_items WHERE preset_id = ?`).all(preset.id);
    const added = [];
    db.transaction(() => {
      for (const i of items) added.push(Number(insertEntry.run({ ...i, profile_id: req.profile.id, date, meal: into, source: 'preset', origin: `Preset: ${preset.name}` }).lastInsertRowid));
      db.prepare('INSERT INTO preset_uses (preset_id, profile_id, date, meal) VALUES (?, ?, ?, ?)').run(preset.id, req.profile.id, date, into);
    })();
    res.json({ ok: true, added: items.length, ids: added });
  });

  // Replaces a preset's name, meal, sharing and items. Only whoever made a shared preset can unshare it.
  app.put('/api/presets/:id', (req, res) => {
    const preset = db.prepare('SELECT * FROM presets WHERE id = ? AND (profile_id = ? OR profile_id IS NULL)').get(req.params.id, req.profile.id);
    if (!preset) return res.status(404).json({ error: 'No such preset.' });
    const { name, meal, shared, items } = req.body;
    if (!name?.trim() || !MEALS.includes(meal)) return res.status(400).json({ error: 'Need a name and a meal.' });
    const num = (x) => (Number(x) > 0 ? Number(x) : null);
    const clean = (Array.isArray(items) ? items : []).filter((i) => i.name?.trim()).map((i) => ({
      name: i.name.trim(),
      ...(UNITS[i.unit] && num(i.amount)
        ? { amount: num(i.amount), unit: i.unit, quantity: formatQuantity(num(i.amount), i.unit) }
        : { amount: null, unit: null, quantity: String(i.quantity ?? '').trim() }),
      grams: num(i.grams), density: num(i.density), each_g: num(i.each_g),
      kcal: Math.round(Number(i.kcal) || 0), fat: round1(Number(i.fat) || 0), carbs: round1(Number(i.carbs) || 0), protein: round1(Number(i.protein) || 0),
      fibre: opt(i.fibre), sugars: opt(i.sugars), sat_fat: opt(i.sat_fat), salt: opt(i.salt),
    }));
    if (!clean.length) return res.status(400).json({ error: 'A preset needs at least one item. Delete it instead if you’re done with it.' });
    let owner = preset.profile_id;
    if (shared) owner = null;
    else if (preset.profile_id === null) {
      if (preset.created_by !== req.profile.id) return res.status(403).json({ error: 'Only whoever shared this preset can make it private again.' });
      owner = req.profile.id;
    }
    db.transaction(() => {
      db.prepare('UPDATE presets SET name = ?, meal = ?, profile_id = ? WHERE id = ?').run(name.trim(), meal, owner, preset.id);
      db.prepare('DELETE FROM preset_items WHERE preset_id = ?').run(preset.id);
      const put = db.prepare(`INSERT INTO preset_items (preset_id, ${ITEM_COLS}) VALUES (@preset_id, ${ITEM_PARAMS})`);
      for (const i of clean) put.run({ ...i, preset_id: preset.id });
    })();
    res.json({ ok: true });
  });

  app.delete('/api/presets/:id', (req, res) => {
    db.prepare('DELETE FROM presets WHERE id = ? AND (profile_id = ? OR profile_id IS NULL)').run(req.params.id, req.profile.id);
    res.json({ ok: true });
  });

  // Other people in the house, and one day of their log, for copying from
  app.get('/api/people', (req, res) => {
    res.json(db.prepare('SELECT id, name FROM profiles WHERE id != ? ORDER BY id').all(req.profile.id));
  });

  app.get('/api/people/:id/day', (req, res) => {
    if (!isDate(req.query.date)) return res.status(400).json({ error: 'Need a date.' });
    const entries = db.prepare(`SELECT id, meal, source, ${ITEM_COLS} FROM entries WHERE profile_id = ? AND date = ? ORDER BY id`)
      .all(req.params.id, req.query.date);
    res.json({ entries });
  });

  // Copies entries (anyone's in the house, or your own from another day) into your log.
  // meal = null keeps each item's original meal.
  app.post('/api/entries/copy', (req, res) => {
    const { ids, date, meal } = req.body;
    if (!Array.isArray(ids) || !ids.length || !isDate(date)) return res.status(400).json({ error: 'Pick something to copy.' });
    const rows = db.prepare(`SELECT e.meal, e.source, e.origin, e.profile_id, p.name AS who, ${ITEM_COLS.split(', ').map((c) => `e.${c}`).join(', ')}
                             FROM entries e JOIN profiles p ON p.id = e.profile_id WHERE e.id IN (${ids.map(() => '?').join(',')}) ORDER BY e.id`).all(...ids.map(Number));
    const added = [];
    db.transaction(() => {
      for (const r of rows) {
        // Say where it was copied from, and where that person's numbers came from in the first place
        const first = r.origin || SOURCE_WORDS[r.source] || r.source;
        const from = r.profile_id === req.profile.id ? 'another day' : `${r.who}’s log`;
        added.push(Number(insertEntry.run({ ...r, origin: `Copied from ${from}${first ? `; originally ${first}` : ''}`, kcal: Math.round(r.kcal), fat: round1(r.fat), carbs: round1(r.carbs), protein: round1(r.protein),
          profile_id: req.profile.id, date, meal: MEALS.includes(meal) ? meal : r.meal, source: 'copied' }).lastInsertRowid));
      }
    })();
    res.json({ ok: true, added: rows.length, ids: added });
  });
}
