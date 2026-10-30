// The rest of today, planned from meals you've actually eaten before: no AI, no tokens.
// Each meal that's still empty gets a share of what's left, and the past meals or presets
// that fit that share best are offered first. AI ideas are a separate call, only on request.
import { db, getSettings } from './db.js';
import { addDays, localDate } from './dates.js';
import { mealForHour } from './meals.js';
import { planIdeas, ParseError } from './parse.js';

const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];
// How a day's calories usually split; only the meals still to come share what's left
const SHARE = { breakfast: 25, lunch: 30, dinner: 35, snacks: 10 };
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const sum = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
const signature = (items) => items.map((i) => i.name.trim().toLowerCase()).sort().join('|');

// The meals from now on that have nothing in them yet
function mealsToCome(profileId, date, hour, today) {
  const logged = new Set(db.prepare('SELECT DISTINCT meal FROM entries WHERE profile_id = ? AND date = ?').all(profileId, date).map((r) => r.meal));
  const from = date === today ? MEALS.indexOf(mealForHour(hour)) : date > today ? 0 : MEALS.length - 1;
  return MEALS.filter((m, i) => !logged.has(m) && (i >= from || m === 'snacks'));
}

function candidates(profileId, date, meal) {
  const out = new Map();
  const rows = db.prepare(`SELECT id, date, name, kcal, protein, carbs, fat FROM entries
                           WHERE profile_id = ? AND meal = ? AND date >= ? AND date < ? ORDER BY date DESC, id`)
    .all(profileId, meal, addDays(date, -60), date);
  const byDay = new Map();
  for (const r of rows) byDay.set(r.date, [...(byDay.get(r.date) || []), r]);
  for (const [day, items] of byDay) {
    const sig = signature(items);
    const seen = out.get(sig);
    if (seen) { seen.times += 1; continue; } // newest first, so the latest portions win
    out.set(sig, { kind: 'past', ids: items.map((i) => i.id), last: day, times: 1, items: items.map((i) => i.name),
      kcal: Math.round(sum(items, 'kcal')), protein: sum(items, 'protein') });
  }
  const presets = db.prepare(`SELECT p.id, p.name FROM presets p WHERE (p.profile_id = ? OR p.profile_id IS NULL) AND p.meal = ?`).all(profileId, meal);
  for (const p of presets) {
    const items = db.prepare('SELECT name, kcal, protein FROM preset_items WHERE preset_id = ?').all(p.id);
    if (!items.length) continue;
    out.set(`preset:${p.id}`, { kind: 'preset', id: p.id, name: p.name, times: 0, items: items.map((i) => i.name), kcal: Math.round(sum(items, 'kcal')), protein: sum(items, 'protein') });
  }
  return [...out.values()];
}

// Closest to the budget without going much over, then the ones you have most, then more protein
function rank(list, budget) {
  const score = (c) => {
    const r = c.kcal / budget;
    return (r > 1.1 ? 2 + r : Math.abs(1 - r)) - Math.min(c.times, 5) * 0.03 - Math.min(c.protein / Math.max(c.kcal, 1), 0.15);
  };
  return list.filter((c) => c.kcal > 0).sort((a, b) => score(a) - score(b)).slice(0, 6);
}

export function planRoutes(app) {
  app.get('/api/plan', (req, res) => {
    const date = isDate(req.query.date) ? req.query.date : localDate();
    const hour = Math.min(23, Math.max(0, Number(req.query.hour) || 0));
    const left = Math.round(Number(req.query.left) || 0);
    const meals = mealsToCome(req.profile.id, date, hour, localDate());
    if (left <= 0 || !meals.length) return res.json({ left, meals: [] });
    const total = meals.reduce((s, m) => s + SHARE[m], 0);
    res.json({
      left,
      meals: meals.map((meal) => {
        const budget = Math.round((left * SHARE[meal]) / total);
        return { meal, budget, options: rank(candidates(req.profile.id, date, meal), budget) };
      }),
    });
  });

  // Fresh ideas from the AI, only when asked. Costs one short message.
  app.post('/api/plan/ideas', async (req, res, next) => {
    const { date, hour, left, protein_left: proteinLeft } = req.body;
    const meals = mealsToCome(req.profile.id, isDate(date) ? date : localDate(), Number(hour) || 0, localDate());
    if (!(Number(left) > 0) || !meals.length) return res.json({ ideas: [], note: 'Nothing left to plan for today.' });
    const usual = db.prepare(`SELECT name, COUNT(*) AS n FROM entries WHERE profile_id = ? AND date >= ? GROUP BY lower(trim(name)) ORDER BY n DESC LIMIT 25`)
      .all(req.profile.id, addDays(localDate(), -30)).map((r) => r.name);
    try {
      res.json(await planIdeas({ left: Math.round(left), proteinLeft: Math.round(Number(proteinLeft) || 0), meals, usual, modelMode: getSettings(req.profile.id).model_mode }));
    } catch (err) {
      if (err instanceof ParseError) return res.status(422).json({ error: err.message });
      next(err);
    }
  });
}
