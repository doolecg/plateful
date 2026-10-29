import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, UPLOAD_DIR, DEFAULT_SETTINGS, getSettings, saveSettings } from './db.js';
import { hashPin, validPin, checkPin, startSession, endSession, requireProfile, requireHouse, unlockHouse, houseLocked } from './auth.js';
import { parseFood, ParseError } from './parse.js';
import { aiInfo } from './ai.js';
import { mealRoutes } from './meals.js';
import { UNITS, formatQuantity, withGrams } from '../public/units.js';
import { localDate, localTime, weekOf, addDays } from './dates.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Trust a reverse proxy on the same machine or Docker network (Caddy for cloud installs)
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(here, '../public')));
app.use('/fonts/fraunces', express.static(path.join(here, '../node_modules/@fontsource/fraunces/files')));
app.use('/fonts/plex', express.static(path.join(here, '../node_modules/@fontsource/ibm-plex-sans/files')));

const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const round1 = (n) => Math.round(n * 10) / 10;

function totalsFor(rows) {
  const t = { kcal: 0, fat: 0, carbs: 0, protein: 0 };
  for (const r of rows) for (const k of Object.keys(t)) t[k] += r[k];
  return { kcal: Math.round(t.kcal), fat: round1(t.fat), carbs: round1(t.carbs), protein: round1(t.protein) };
}

const kcalByDate = db.prepare('SELECT date, SUM(kcal) AS kcal FROM entries WHERE profile_id = ? AND date BETWEEN ? AND ? GROUP BY date');

// Daily targets for a Mon–Sun week. One day a week gets the flex target: either a fixed
// weekday, or (auto) the first day that went over the normal daily target.
function weekSummary(profileId, date, settings, today) {
  const days = weekOf(date);
  const eaten = Object.fromEntries(kcalByDate.all(profileId, days[0], days[6]).map((r) => [r.date, Math.round(r.kcal)]));
  let flexDate = null;
  if (settings.flex_day === 'auto') {
    flexDate = days.find((d) => d <= today && (eaten[d] || 0) > settings.daily_kcal) || null;
  } else {
    const idx = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(settings.flex_day);
    if (idx >= 0) flexDate = days[idx];
  }
  const budget = settings.daily_kcal * 6 + settings.flex_kcal;
  const out = days.map((d) => ({
    date: d,
    kcal: eaten[d] || 0,
    target: d === flexDate ? settings.flex_kcal : settings.daily_kcal,
    flex: d === flexDate,
    future: d > today,
  }));
  const used = out.reduce((s, d) => s + d.kcal, 0);
  return { days: out, budget, used, flexDate, flexFree: !flexDate };
}

function weightSummary(profileId, settings) {
  const rows = db.prepare('SELECT id, date, kg FROM weights WHERE profile_id = ? ORDER BY date').all(profileId);
  if (!rows.length) return { rows, stats: null };
  const first = rows[0];
  const last = rows[rows.length - 1];
  // Rate from a least-squares fit over the last 8 weeks (or everything, if that's under two points)
  const cutoff = addDays(last.date, -56);
  let fit = rows.filter((r) => r.date >= cutoff);
  if (fit.length < 2) fit = rows;
  let ratePerWeek = null;
  if (fit.length >= 2) {
    const t0 = Date.parse(fit[0].date);
    const xs = fit.map((r) => (Date.parse(r.date) - t0) / 86400000 / 7);
    const ys = fit.map((r) => r.kg);
    const mx = xs.reduce((a, b) => a + b) / xs.length;
    const my = ys.reduce((a, b) => a + b) / ys.length;
    const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    if (den > 0) ratePerWeek = Math.round(-xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den * 100) / 100;
  }
  const goal = settings.goal_kg;
  const toGo = goal == null ? null : round1(last.kg - goal);
  const weeksLeft = ratePerWeek > 0 && toGo > 0 ? toGo / ratePerWeek : null;
  return {
    rows,
    stats: {
      start: first,
      latest: last,
      lost: round1(first.kg - last.kg),
      toGo,
      ratePerWeek,
      projectedDate: weeksLeft ? addDays(last.date, Math.round(weeksLeft * 7)) : null,
      progress: goal == null || first.kg === goal ? null : Math.max(0, Math.min(1, (first.kg - last.kg) / (first.kg - goal))),
    },
  };
}

/* ---------- Household password, profiles and sign-in (the only routes open without a session) ---------- */

app.post('/api/unlock', unlockHouse);
app.use(['/api', '/uploads'], requireHouse);

app.get('/api/profiles', (req, res) => {
  res.json(db.prepare('SELECT id, name, pin_hash IS NOT NULL AS hasPin FROM profiles ORDER BY id').all()
    .map((p) => ({ ...p, hasPin: !!p.hasPin })));
});

app.post('/api/profiles', (req, res) => {
  const { name, pin, daily_kcal, flex_kcal, goal_kg, start_kg } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Give the profile a name.' });
  if (!validPin(pin)) return res.status(400).json({ error: 'The PIN needs to be 4 to 8 digits.' });
  const id = db.transaction(() => {
    const pid = db.prepare('INSERT INTO profiles (name, pin_hash) VALUES (?, ?)').run(name.trim(), hashPin(pin)).lastInsertRowid;
    saveSettings(pid, { ...DEFAULT_SETTINGS, daily_kcal, flex_kcal, goal_kg });
    if (Number(start_kg) >= 30 && Number(start_kg) <= 400) db.prepare('INSERT INTO weights (profile_id, date, kg) VALUES (?, ?, ?)').run(pid, localDate(), Number(start_kg));
    return pid;
  })();
  startSession(res, id);
  res.json({ ok: true });
});

// Signs this device in as a profile. A profile with no PIN yet (the original one, after an
// upgrade) takes the PIN entered here as its new PIN.
app.post('/api/session', (req, res) => {
  const { profile_id, pin } = req.body;
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profile_id);
  if (!profile) return res.status(404).json({ error: 'No such profile.' });
  if (!profile.pin_hash) {
    if (!validPin(pin)) return res.status(400).json({ error: 'The PIN needs to be 4 to 8 digits.' });
    db.prepare('UPDATE profiles SET pin_hash = ? WHERE id = ?').run(hashPin(pin), profile.id);
  } else {
    const check = checkPin(profile, pin);
    if (check.error) return res.status(403).json(check);
  }
  startSession(res, profile.id);
  res.json({ ok: true });
});

app.delete('/api/session', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

app.use(['/api', '/uploads'], requireProfile);

app.get('/uploads/:name', (req, res) => {
  const msgId = Number.parseInt(req.params.name, 10);
  const owned = db.prepare('SELECT 1 FROM messages WHERE id = ? AND profile_id = ?').get(msgId, req.profile.id);
  if (!owned || !/^\d+-\d+\.(jpg|png|webp|gif)$/.test(req.params.name)) return res.sendStatus(404);
  res.sendFile(path.join(UPLOAD_DIR, req.params.name), { maxAge: '30d', immutable: true });
});

app.put('/api/pin', (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(req.profile.id);
  const check = checkPin(profile, req.body.current);
  if (check.error) return res.status(403).json(check);
  if (!validPin(req.body.pin)) return res.status(400).json({ error: 'The new PIN needs to be 4 to 8 digits.' });
  db.prepare('UPDATE profiles SET pin_hash = ? WHERE id = ?').run(hashPin(req.body.pin), profile.id);
  res.json({ ok: true });
});

/* ---------- Everything below is scoped to the signed-in profile ---------- */

mealRoutes(app);

app.get('/api/summary', (req, res) => {
  const pid = req.profile.id;
  const today = localDate();
  const date = isDate(req.query.date) ? req.query.date : today;
  const settings = getSettings(pid);
  const entries = db.prepare('SELECT * FROM entries WHERE profile_id = ? AND date = ? ORDER BY id').all(pid, date);
  const messages = db.prepare('SELECT id, created_at, text, images, note, error, model FROM messages WHERE profile_id = ? AND date = ? ORDER BY id').all(pid, date)
    .map((m) => ({ ...m, images: JSON.parse(m.images) }));
  const week = weekSummary(pid, date, settings, today);
  const dayInfo = week.days.find((d) => d.date === date);
  res.json({
    today,
    date,
    profile: req.profile,
    settings,
    server: { ai: aiInfo(), password: houseLocked },
    day: { entries, messages, totals: totalsFor(entries), target: dayInfo.target, flex: dayInfo.flex },
    week,
    weight: weightSummary(pid, settings),
    foods: db.prepare('SELECT * FROM foods WHERE profile_id = ? ORDER BY name').all(pid),
  });
});

// "weight 127.9", "w 127.9kg", "20st 3lb" are logged here without spending tokens
function parseWeight(text) {
  const kg = text.match(/^\s*(?:weight|weigh|w)\s*[:=]?\s*(\d{2,3}(?:\.\d+)?)\s*(?:kg)?\s*$/i);
  if (kg) return Number(kg[1]);
  const st = text.match(/^\s*(?:(?:weight|weigh|w)\s*[:=]?\s*)?(\d{1,2})\s*st(?:one)?s?\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:lb|lbs|pounds?)?)?\s*$/i);
  if (st) return round1((Number(st[1]) * 14 + Number(st[2] || 0)) * 0.45359237);
  return null;
}

function decodeImages(images) {
  return images.map((dataUrl) => {
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(dataUrl);
    if (!m) throw new ParseError('That image format isn’t one Larder can read.');
    return { mediaType: m[1], data: m[2] };
  });
}

// Sends one stored message to the AI and writes the resulting entries against it
async function runMessage(msgId) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
  const images = JSON.parse(m.images).map((url) => {
    const file = path.join(UPLOAD_DIR, path.basename(url));
    return { mediaType: `image/${path.extname(file).slice(1).replace('jpg', 'jpeg')}`, data: fs.readFileSync(file).toString('base64') };
  });
  try {
    const result = await parseFood({
      text: m.text,
      images,
      savedFoods: db.prepare('SELECT * FROM foods WHERE profile_id = ? ORDER BY name').all(m.profile_id),
      localTime: `${m.date} ${localTime()}`,
      modelMode: getSettings(m.profile_id).model_mode,
    });
    const insert = db.prepare(`INSERT INTO entries (profile_id, date, meal, name, quantity, amount, unit, grams, density, each_g, kcal, fat, carbs, protein, source, message_id)
      VALUES (@profile_id, @date, @meal, @name, @quantity, @amount, @unit, @grams, @density, @each_g, @kcal, @fat, @carbs, @protein, @source, @message_id)`);
    db.transaction(() => {
      for (const it of result.items) {
        const unit = UNITS[it.unit] ? it.unit : 'each';
        const amt = withGrams({ amount: it.amount, unit, grams: it.grams });
        insert.run({
          profile_id: m.profile_id, date: m.date, meal: MEALS.includes(it.meal) ? it.meal : 'snacks', name: it.name,
          quantity: formatQuantity(it.amount, unit), amount: it.amount, unit, grams: amt.grams ?? null, density: amt.density ?? null, each_g: amt.each_g ?? null,
          kcal: Math.round(it.kcal), fat: round1(it.fat), carbs: round1(it.carbs), protein: round1(it.protein), source: it.source, message_id: msgId,
        });
      }
      db.prepare('UPDATE messages SET note = ?, error = NULL, input_tokens = ?, output_tokens = ?, model = ? WHERE id = ?')
        .run(result.note || (result.items.length ? null : 'I couldn’t spot any food in that.'),
          result.usage.input_tokens, result.usage.output_tokens, result.model, msgId);
    })();
    return { ok: true, added: result.items.length };
  } catch (err) {
    console.error(err);
    const error = err instanceof ParseError ? err.message : 'Couldn’t reach the AI just now. Your message is saved, so tap retry in a minute.';
    db.prepare('UPDATE messages SET error = ? WHERE id = ?').run(error, msgId);
    return { error };
  }
}

app.post('/api/log', async (req, res, next) => {
  try {
    const { text = '', images = [], date: rawDate } = req.body;
    const date = isDate(rawDate) ? rawDate : localDate();
    if (!text.trim() && !images.length) return res.status(400).json({ error: 'Nothing to log.' });

    const kg = images.length ? null : parseWeight(text);
    if (kg) {
      db.prepare('INSERT INTO weights (profile_id, date, kg) VALUES (?, ?, ?) ON CONFLICT(profile_id, date) DO UPDATE SET kg = excluded.kg').run(req.profile.id, date, kg);
      return res.json({ ok: true, weight: kg });
    }

    const decoded = decodeImages(images);
    const msgId = db.prepare('INSERT INTO messages (profile_id, date, text) VALUES (?, ?, ?)').run(req.profile.id, date, text).lastInsertRowid;
    const files = decoded.map((img, i) => {
      const name = `${msgId}-${i}.${img.mediaType.split('/')[1].replace('jpeg', 'jpg')}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(img.data, 'base64'));
      return `/uploads/${name}`;
    });
    db.prepare('UPDATE messages SET images = ? WHERE id = ?').run(JSON.stringify(files), msgId);

    const result = await runMessage(msgId);
    res.status(result.error ? 502 : 200).json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/api/messages/:id/retry', async (req, res, next) => {
  try {
    if (!db.prepare('SELECT 1 FROM messages WHERE id = ? AND profile_id = ?').get(req.params.id, req.profile.id)) return res.status(404).json({ error: 'Not found.' });
    const result = await runMessage(Number(req.params.id));
    res.status(result.error ? 502 : 200).json(result);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/messages/:id', (req, res) => {
  db.prepare('DELETE FROM messages WHERE id = ? AND profile_id = ?').run(req.params.id, req.profile.id);
  res.json({ ok: true });
});

const ENTRY_FIELDS = ['date', 'meal', 'name', 'quantity', 'amount', 'unit', 'grams', 'density', 'each_g', 'kcal', 'fat', 'carbs', 'protein', 'origin'];

function cleanEntry(body) {
  const e = {};
  for (const k of ENTRY_FIELDS) if (body[k] !== undefined) e[k] = body[k];
  for (const k of ['kcal', 'fat', 'carbs', 'protein']) if (e[k] !== undefined) e[k] = Number(e[k]) || 0;
  for (const k of ['amount', 'grams', 'density', 'each_g']) if (e[k] !== undefined) e[k] = Number(e[k]) > 0 ? Number(e[k]) : null;
  if (e.unit !== undefined && !UNITS[e.unit]) e.unit = null;
  // Keep the display text in step with a structured amount
  if (e.amount && e.unit) e.quantity = formatQuantity(e.amount, e.unit);
  if (e.meal && !MEALS.includes(e.meal)) delete e.meal;
  if (e.date && !isDate(e.date)) delete e.date;
  return e;
}

app.post('/api/entries', (req, res) => {
  const e = { meal: 'snacks', quantity: '', amount: null, unit: null, grams: null, density: null, each_g: null, origin: null,
    fat: 0, carbs: 0, protein: 0, ...cleanEntry(req.body), source: req.body.source === 'saved' ? 'saved' : 'manual' };
  if (!e.name || !isDate(e.date)) return res.status(400).json({ error: 'Name and date are needed.' });
  db.prepare(`INSERT INTO entries (profile_id, date, meal, name, quantity, amount, unit, grams, density, each_g, kcal, fat, carbs, protein, source, origin)
              VALUES (@profile_id, @date, @meal, @name, @quantity, @amount, @unit, @grams, @density, @each_g, @kcal, @fat, @carbs, @protein, @source, @origin)`)
    .run({ ...e, profile_id: req.profile.id });
  res.json({ ok: true });
});

app.patch('/api/entries/:id', (req, res) => {
  const e = cleanEntry(req.body);
  if (['amount', 'unit', 'grams', 'kcal', 'fat', 'carbs', 'protein'].some((k) => k in e)) e.edited_at = new Date().toISOString();
  const keys = Object.keys(e);
  if (!keys.length) return res.json({ ok: true });
  db.prepare(`UPDATE entries SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id AND profile_id = @profile_id`)
    .run({ ...e, id: req.params.id, profile_id: req.profile.id });
  res.json({ ok: true });
});

app.delete('/api/entries/:id', (req, res) => {
  db.prepare('DELETE FROM entries WHERE id = ? AND profile_id = ?').run(req.params.id, req.profile.id);
  res.json({ ok: true });
});

app.post('/api/foods', (req, res) => {
  const { name, unit, per, kcal, fat = 0, carbs = 0, protein = 0 } = req.body;
  if (!name || !unit || !(per > 0) || !(kcal >= 0)) return res.status(400).json({ error: 'Name, unit, amount and kcal are needed.' });
  db.prepare(`INSERT INTO foods (profile_id, name, unit, per, kcal, fat, carbs, protein) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(profile_id, name) DO UPDATE SET unit = excluded.unit, per = excluded.per, kcal = excluded.kcal,
              fat = excluded.fat, carbs = excluded.carbs, protein = excluded.protein`)
    .run(req.profile.id, name.trim(), unit.trim(), Number(per), Number(kcal), Number(fat), Number(carbs), Number(protein));
  res.json({ ok: true });
});

app.delete('/api/foods/:id', (req, res) => {
  db.prepare('DELETE FROM foods WHERE id = ? AND profile_id = ?').run(req.params.id, req.profile.id);
  res.json({ ok: true });
});

app.post('/api/weights', (req, res) => {
  const { date, kg } = req.body;
  if (!isDate(date) || !(kg > 20 && kg < 400)) return res.status(400).json({ error: 'Need a date and a weight in kg.' });
  db.prepare('INSERT INTO weights (profile_id, date, kg) VALUES (?, ?, ?) ON CONFLICT(profile_id, date) DO UPDATE SET kg = excluded.kg').run(req.profile.id, date, Number(kg));
  res.json({ ok: true });
});

app.delete('/api/weights/:id', (req, res) => {
  db.prepare('DELETE FROM weights WHERE id = ? AND profile_id = ?').run(req.params.id, req.profile.id);
  res.json({ ok: true });
});

app.put('/api/settings', (req, res) => {
  saveSettings(req.profile.id, req.body);
  res.json({ ok: true, settings: getSettings(req.profile.id) });
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err instanceof ParseError ? 400 : 500).json({ error: err instanceof ParseError ? err.message : 'Something went wrong on the server.' });
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => console.log(`Larder listening on :${port}`));
