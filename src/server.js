import './env.js';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, UPLOAD_DIR, DEFAULT_SETTINGS, getSettings, saveSettings } from './db.js';
import { hashPin, validPin, checkPin, startSession, endSession, requireProfile, requireHouse, unlockHouse, houseLocked } from './auth.js';
import { parseFood, ParseError } from './parse.js';
import { aiInfo } from './ai.js';
import { mealRoutes, mealForHour } from './meals.js';
import { UNITS, formatQuantity, withGrams } from '../public/units.js';
import { localDate, localTime, weekOf, addDays } from './dates.js';
import { NUTRIENTS, FOOD_DIR, matchLocally, lookupBarcode, searchOnline, searchLocal, bestMatch, nutrientsFor, saveLabel, saveProduct, productLabel } from './fooddb.js';

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
  const t = Object.fromEntries(NUTRIENTS.map((k) => [k, 0]));
  for (const r of rows) for (const k of NUTRIENTS) t[k] += r[k] || 0;
  return Object.fromEntries(NUTRIENTS.map((k) => [k, k === 'kcal' ? Math.round(t[k]) : round1(t[k])]));
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
  const entries = db.prepare(`SELECT e.*, f.name AS product_name, f.brand AS product_brand FROM entries e LEFT JOIN food_db f ON f.id = e.product_id
                              WHERE e.profile_id = ? AND e.date = ? ORDER BY e.id`).all(pid, date);
  const messages = db.prepare('SELECT id, created_at, text, images, note, error, model, cleared, relabel_entry_id FROM messages WHERE profile_id = ? AND date = ? ORDER BY id').all(pid, date)
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
    if (!m) throw new ParseError('That image format isn’t one Plateful can read.');
    return { mediaType: m[1], data: m[2] };
  });
}

// Puts each item the AI returned against the household food list: a product it picked from the
// list, a barcode it read, or (for a branded item) a search of the list and then Open Food Facts.
// A match replaces the estimate with the product's own per 100 g figures. A branded item nobody
// has figures for is flagged so the app can ask for a photo of its label.
async function matchProducts(items, candidates, ctx) {
  let searched = 0;
  for (const it of items) {
    it.product_id = null;
    it.needs_label = 0;
    if (it.source === 'label') {
      it.product_id = saveLabel(it, ctx)?.id ?? null;
      continue;
    }
    if (it.source === 'saved') continue;
    let product = candidates.find((p) => p.id === it.product) || null;
    if (!product && it.barcode) product = await lookupBarcode(it.barcode).catch(() => null);
    const query = `${it.brand || ''} ${it.name}`;
    if (!product && it.branded) product = bestMatch(query, searchLocal(query, 30));
    // A few online searches per message keeps the wait and the rate limit in check
    if (!product && it.branded && it.brand && searched++ < 3) product = bestMatch(query, await searchOnline(query));
    if (product && it.grams > 0) {
      Object.assign(it, nutrientsFor(product, it.grams), { source: 'db', product_id: product.id, product_name: productLabel(product) });
    } else {
      if (it.source === 'db') it.source = 'est.';
      if (it.branded) it.needs_label = 1;
    }
  }
  return items;
}

const insertEntry = db.prepare(`INSERT INTO entries (profile_id, date, meal, name, quantity, amount, unit, grams, density, each_g,
    ${NUTRIENTS.join(', ')}, source, origin, message_id, product_id, needs_label)
  VALUES (@profile_id, @date, @meal, @name, @quantity, @amount, @unit, @grams, @density, @each_g,
    ${NUTRIENTS.map((k) => `@${k}`).join(', ')}, @source, @origin, @message_id, @product_id, @needs_label)`);

const loadImages = (m) => JSON.parse(m.images).map((url) => {
  const file = path.join(UPLOAD_DIR, path.basename(url));
  return { mediaType: `image/${path.extname(file).slice(1).replace('jpg', 'jpeg')}`, data: fs.readFileSync(file).toString('base64') };
});

const nutrientValues = (it) => Object.fromEntries(NUTRIENTS.map((k) => [k, it[k] == null ? null : k === 'kcal' ? Math.round(it[k]) : round1(it[k])]));

// Sends one stored message to the AI and writes the resulting entries against it.
// With relabel, the message is a label photo for an entry already in the diary, which gets updated instead.
async function runMessage(msgId, relabel = null) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
  try {
    const candidates = relabel ? [] : searchLocal(m.text, 15);
    const images = JSON.parse(m.images);
    // Foods the house already knows, typed with an amount, need no AI at all
    const local = !relabel && !images.length && matchLocally(m.text);
    const result = local ? {
      items: local.map((it) => ({ ...it, meal: it.meal || mealForHour(Number(localTime().match(/(\d{2}):/)[1])) })),
      note: `Matched from your food list, so no AI was needed.`,
      model: 'local', usage: { input_tokens: 0, output_tokens: 0 },
    } : await parseFood({
      text: relabel
        ? `This photo is the nutrition label for ${relabel.name}${relabel.quantity ? `; I had ${relabel.quantity}` : ''}${relabel.grams ? ` (about ${Math.round(relabel.grams)} g)` : ''}. Return just that one item, read from the label.`
        : m.text,
      images: loadImages(m),
      savedFoods: relabel ? [] : db.prepare('SELECT * FROM foods WHERE profile_id = ? ORDER BY name').all(m.profile_id),
      products: candidates,
      localTime: `${m.date} ${localTime()}`,
      modelMode: getSettings(m.profile_id).model_mode,
    });
    const items = local ? result.items : await matchProducts(result.items, candidates, { profileId: m.profile_id, image: images[0] });
    const unknown = items.filter((it) => it.needs_label).map((it) => it.name);
    const note = [result.note, unknown.length
      ? `I couldn’t find ${unknown.length > 1 ? `${unknown.slice(0, -1).join(', ')} and ${unknown.at(-1)}` : unknown[0]} in the food list, so ${unknown.length > 1 ? 'those are estimates' : 'that’s an estimate'}. Open ${unknown.length > 1 ? 'each one' : 'it'} and add a photo of the label, and I’ll know it from then on.`
      : ''].filter(Boolean).join(' ');

    db.transaction(() => {
      if (relabel) {
        const it = items[0];
        if (!it || it.source !== 'label') throw new ParseError('I couldn’t read a nutrition label in that photo. Try again closer up, with the table flat and in focus.');
        // Keep the amount that was logged, and take the new numbers per gram from the label
        const grams = relabel.grams > 0 ? relabel.grams : it.grams;
        const product = db.prepare('SELECT * FROM food_db WHERE id = ?').get(it.product_id);
        const values = product && grams > 0 ? nutrientsFor(product, grams) : nutrientValues(it);
        db.prepare(`UPDATE entries SET ${NUTRIENTS.map((k) => `${k} = @${k}`).join(', ')}, source = 'label', product_id = @product_id, needs_label = 0,
            label_message_id = @msg WHERE id = @id`).run({ ...values, product_id: it.product_id, msg: msgId, id: relabel.id });
      } else {
        for (const it of items) {
          const unit = UNITS[it.unit] ? it.unit : 'each';
          const amt = withGrams({ amount: it.amount, unit, grams: it.grams });
          insertEntry.run({
            profile_id: m.profile_id, date: m.date, meal: MEALS.includes(it.meal) ? it.meal : 'snacks', name: it.name,
            quantity: formatQuantity(it.amount, unit), amount: it.amount, unit, grams: amt.grams ?? null, density: amt.density ?? null, each_g: amt.each_g ?? null,
            ...nutrientValues(it), source: it.source,
            origin: it.local ? `Matched by Plateful to “${it.product_name}” in your food list, without asking the AI` : it.product_name ? `Food list: ${it.product_name}` : null,
            message_id: msgId, product_id: it.product_id, needs_label: it.needs_label,
          });
        }
      }
      db.prepare('UPDATE messages SET note = ?, error = NULL, input_tokens = ?, output_tokens = ?, model = ? WHERE id = ?')
        .run(relabel ? `Read the label for ${relabel.name} and updated it.` : note || (items.length ? null : 'I couldn’t spot any food in that.'),
          result.usage.input_tokens, result.usage.output_tokens, result.model, msgId);
    })();
    return { ok: true, message_id: msgId, added: relabel ? 0 : items.length, updated: relabel ? 1 : 0 };
  } catch (err) {
    console.error(err);
    const error = err instanceof ParseError ? err.message : 'Couldn’t reach the AI just now. Your message is saved, so tap retry in a minute.';
    db.prepare('UPDATE messages SET error = ? WHERE id = ?').run(error, msgId);
    return { error };
  }
}

// Stores a message and its photos; returns its id
function storeMessage(profileId, date, text, decoded, kind = null) {
  const msgId = db.prepare('INSERT INTO messages (profile_id, date, text, relabel_entry_id) VALUES (?, ?, ?, ?)').run(profileId, date, text, kind).lastInsertRowid;
  const files = decoded.map((img, i) => {
    const name = `${msgId}-${i}.${img.mediaType.split('/')[1].replace('jpeg', 'jpg')}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(img.data, 'base64'));
    return `/uploads/${name}`;
  });
  db.prepare('UPDATE messages SET images = ? WHERE id = ?').run(JSON.stringify(files), msgId);
  return msgId;
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

    const msgId = storeMessage(req.profile.id, date, text, decodeImages(images));
    const result = await runMessage(msgId);
    res.status(result.error ? 502 : 200).json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/api/messages/:id/retry', async (req, res, next) => {
  try {
    const m = db.prepare('SELECT * FROM messages WHERE id = ? AND profile_id = ?').get(req.params.id, req.profile.id);
    if (!m) return res.status(404).json({ error: 'Not found.' });
    const relabel = m.relabel_entry_id && db.prepare('SELECT * FROM entries WHERE id = ? AND profile_id = ?').get(m.relabel_entry_id, req.profile.id);
    const result = await runMessage(m.id, relabel || null);
    res.status(result.error ? 502 : 200).json(result);
  } catch (err) {
    next(err);
  }
});

// Hides a day's "What you sent" list. The messages stay, so items keep their photos and the story behind their numbers.
app.post('/api/messages/clear', (req, res) => {
  if (!isDate(req.body.date)) return res.status(400).json({ error: 'Need a date.' });
  const r = db.prepare('UPDATE messages SET cleared = 1 WHERE profile_id = ? AND date = ? AND error IS NULL').run(req.profile.id, req.body.date);
  res.json({ ok: true, cleared: r.changes });
});

app.delete('/api/messages/:id', (req, res) => {
  db.prepare('DELETE FROM messages WHERE id = ? AND profile_id = ?').run(req.params.id, req.profile.id);
  res.json({ ok: true });
});

const EXTRA = ['fibre', 'sugars', 'sat_fat', 'salt'];
const ENTRY_FIELDS = ['date', 'meal', 'name', 'quantity', 'amount', 'unit', 'grams', 'density', 'each_g', ...NUTRIENTS, 'origin', 'product_id'];

function cleanEntry(body) {
  const e = {};
  for (const k of ENTRY_FIELDS) if (body[k] !== undefined) e[k] = body[k];
  for (const k of ['kcal', 'fat', 'carbs', 'protein']) if (e[k] !== undefined) e[k] = Number(e[k]) || 0;
  // The newer nutrients stay NULL ("not known") rather than 0 when left blank
  for (const k of EXTRA) if (e[k] !== undefined) e[k] = e[k] === '' || e[k] == null || !Number.isFinite(Number(e[k])) ? null : Number(e[k]);
  if (e.product_id !== undefined) e.product_id = Number(e.product_id) || null;
  for (const k of ['amount', 'grams', 'density', 'each_g']) if (e[k] !== undefined) e[k] = Number(e[k]) > 0 ? Number(e[k]) : null;
  if (e.unit !== undefined && !UNITS[e.unit]) e.unit = null;
  // Keep the display text in step with a structured amount
  if (e.amount && e.unit) e.quantity = formatQuantity(e.amount, e.unit);
  if (e.meal && !MEALS.includes(e.meal)) delete e.meal;
  if (e.date && !isDate(e.date)) delete e.date;
  return e;
}

app.post('/api/entries', (req, res) => {
  const e = { meal: 'snacks', quantity: '', amount: null, unit: null, grams: null, density: null, each_g: null, origin: null, product_id: null,
    fat: 0, carbs: 0, protein: 0, fibre: null, sugars: null, sat_fat: null, salt: null, ...cleanEntry(req.body),
    source: ['saved', 'db'].includes(req.body.source) ? req.body.source : 'manual', message_id: null, needs_label: 0 };
  if (!e.name || !isDate(e.date)) return res.status(400).json({ error: 'Name and date are needed.' });
  const { lastInsertRowid } = insertEntry.run({ ...e, profile_id: req.profile.id });
  res.json({ ok: true, id: Number(lastInsertRowid) });
});

// The Add sheet's "Recent" list: the last time you had each thing in the past two months
app.get('/api/recent', (req, res) => {
  const rows = db.prepare(`SELECT e.*, r.times FROM entries e
      JOIN (SELECT MAX(id) AS id, COUNT(*) AS times FROM entries WHERE profile_id = ? AND date >= ? GROUP BY lower(trim(name))) r ON r.id = e.id
      ORDER BY e.id DESC LIMIT 200`).all(req.profile.id, addDays(localDate(), -60));
  res.json({ entries: rows });
});

app.patch('/api/entries/:id', (req, res) => {
  const e = cleanEntry(req.body);
  if (['amount', 'unit', 'grams', ...NUTRIENTS].some((k) => k in e)) e.edited_at = new Date().toISOString();
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

// A label photo for an item already in the diary
app.post('/api/entries/:id/label', async (req, res, next) => {
  try {
    const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND profile_id = ?').get(req.params.id, req.profile.id);
    if (!entry) return res.status(404).json({ error: 'No such item.' });
    if (!req.body.images?.length) return res.status(400).json({ error: 'Add a photo of the label.' });
    const msgId = storeMessage(req.profile.id, entry.date, `Label for ${entry.name}`, decodeImages(req.body.images.slice(0, 3)), entry.id);
    const result = await runMessage(msgId, entry);
    res.status(result.error ? 502 : 200).json(result);
  } catch (err) {
    next(err);
  }
});

/* ---------- The household food list ---------- */

app.get('/api/fooddb', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (/^\d{8,14}$/.test(q)) {
    const p = await lookupBarcode(q).catch(() => null);
    return res.json({ products: p ? [p] : [], online: true });
  }
  if (q.length < 2) {
    return res.json({ products: db.prepare('SELECT * FROM food_db ORDER BY updated_at DESC LIMIT 20').all(), online: false });
  }
  let products = searchLocal(q, 25);
  const online = req.query.online === '1';
  if (online) {
    const found = await searchOnline(q);
    const seen = new Set(products.map((p) => p.id));
    products = [...products, ...found.filter((p) => !seen.has(p.id))];
  }
  res.json({ products, online });
});

// A product typed in by hand from a label (values per 100 g)
app.post('/api/fooddb', (req, res) => {
  const { name, brand = '', barcode = '' } = req.body;
  if (!name?.trim() || !(Number(req.body.kcal) >= 0)) return res.status(400).json({ error: 'Name and kcal per 100 g are needed.' });
  const nums = Object.fromEntries(NUTRIENTS.map((k) => [k, req.body[k] === '' || req.body[k] == null ? null : Number(req.body[k])]));
  const p = saveProduct({ ...nums, name: name.trim(), brand: String(brand).trim(), barcode: String(barcode).replace(/\D/g, '') || null, source: 'manual',
    serving_g: Number(req.body.serving_g) > 0 ? Number(req.body.serving_g) : null });
  db.prepare('UPDATE food_db SET added_by = COALESCE(added_by, ?), pack_g = COALESCE(?, pack_g) WHERE id = ?')
    .run(req.profile.id, Number(req.body.pack_g) > 0 ? Number(req.body.pack_g) : null, p.id);
  res.json({ ok: true, product: db.prepare('SELECT * FROM food_db WHERE id = ?').get(p.id) });
});

/* ---------- Managing the food list: everyone in the house shares it ---------- */

app.get('/uploads/food/:name', (req, res) => {
  if (!/^\d+-\d+\.(jpg|png|webp)$/.test(req.params.name)) return res.sendStatus(404);
  res.sendFile(path.join(FOOD_DIR, req.params.name), { maxAge: '30d', immutable: true });
});

const PRODUCT_COLS = ['name', 'brand', 'barcode', 'serving_g', 'pack_g', ...NUTRIENTS];
// Per 100 g, nothing can be more than 100 g of anything, or more than 900 kcal (pure fat)
const LIMITS = { kcal: 900, serving_g: 5000, pack_g: 20000 };

// Checks one product from the edit form or an import file; returns { row } or { error }
function cleanProduct(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'not an object' };
  const name = String(raw.name ?? '').trim();
  if (!name) return { error: 'no name' };
  if (name.length > 120) return { error: 'name is over 120 characters' };
  const row = { name, brand: String(raw.brand ?? '').trim().slice(0, 80) };
  const code = String(raw.barcode ?? '').replace(/\s/g, '');
  if (code && !/^\d{8,14}$/.test(code)) return { error: `barcode "${code}" isn't 8 to 14 digits` };
  row.barcode = code || null;
  for (const k of [...NUTRIENTS, 'serving_g', 'pack_g']) {
    const v = raw[k];
    if (v === '' || v == null) { if (k === 'kcal') return { error: 'no kcal' }; row[k] = null; continue; }
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0 || x > (LIMITS[k] ?? 100)) return { error: `${k} ${JSON.stringify(v)} isn't a number from 0 to ${LIMITS[k] ?? 100}` };
    row[k] = Math.round(x * 100) / 100;
  }
  return { row };
}

const productWithOwner = `SELECT f.*, p.name AS added_by_name, (SELECT COUNT(*) FROM entries e WHERE e.product_id = f.id) AS uses
  FROM food_db f LEFT JOIN profiles p ON p.id = f.added_by`;

app.get('/api/fooddb/all', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 8);
  const where = terms.map(() => "(lower(f.name) || ' ' || lower(f.brand) || ' ' || COALESCE(f.barcode, '')) LIKE ?");
  if (['off', 'label', 'manual', 'import'].includes(req.query.source)) where.push('f.source = ?');
  const params = [...terms.map((t) => `%${t}%`), ...(where.length > terms.length ? [req.query.source] : [])];
  const products = db.prepare(`${productWithOwner} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY f.name COLLATE NOCASE LIMIT 1000`).all(...params);
  res.json({ products, total: db.prepare('SELECT COUNT(*) AS n FROM food_db').get().n });
});

app.put('/api/fooddb/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM food_db WHERE id = ?').get(id)) return res.status(404).json({ error: 'No such product.' });
  const { row, error } = cleanProduct(req.body);
  if (error) return res.status(400).json({ error: `Can’t save that: ${error}.` });
  const clash = db.prepare('SELECT name FROM food_db WHERE id != ? AND ((lower(name) = lower(?) AND lower(brand) = lower(?)) OR (barcode IS NOT NULL AND barcode = ?))')
    .get(id, row.name, row.brand, row.barcode);
  if (clash) return res.status(400).json({ error: `“${clash.name}” already has that name and brand or barcode. Edit or delete that one instead.` });
  db.prepare(`UPDATE food_db SET ${PRODUCT_COLS.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...row, id });
  res.json({ ok: true, product: db.prepare(`${productWithOwner} WHERE f.id = ?`).get(id) });
});

// Items already in diaries keep their numbers; they just stop pointing at the product
app.delete('/api/fooddb/:id', (req, res) => {
  const p = db.prepare('SELECT photo FROM food_db WHERE id = ?').get(req.params.id);
  if (!p) return res.json({ ok: true });
  db.transaction(() => {
    db.prepare('UPDATE entries SET product_id = NULL WHERE product_id = ?').run(req.params.id);
    db.prepare('DELETE FROM food_db WHERE id = ?').run(req.params.id);
  })();
  if (p.photo) fs.rmSync(path.join(FOOD_DIR, path.basename(p.photo)), { force: true });
  res.json({ ok: true });
});

app.post('/api/fooddb/:id/photo', (req, res) => {
  const p = db.prepare('SELECT id, photo FROM food_db WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No such product.' });
  const [img] = decodeImages([req.body.image]);
  const name = `${p.id}-${Date.now()}.${img.mediaType.split('/')[1].replace('jpeg', 'jpg')}`;
  fs.writeFileSync(path.join(FOOD_DIR, name), Buffer.from(img.data, 'base64'));
  if (p.photo) fs.rmSync(path.join(FOOD_DIR, path.basename(p.photo)), { force: true });
  db.prepare('UPDATE food_db SET photo = ? WHERE id = ?').run(`/uploads/food/${name}`, p.id);
  res.json({ ok: true, photo: `/uploads/food/${name}` });
});

// A product straight from photos of its label (and front of pack, if there is one), without logging anything
app.post('/api/fooddb/from-label', async (req, res, next) => {
  try {
    const decoded = decodeImages((req.body.images || []).slice(0, 3));
    if (!decoded.length) return res.status(400).json({ error: 'Add a photo of the label.' });
    const result = await parseFood({
      text: 'These photos are of one product: its nutrition label, and maybe the front of the pack. Don\'t log anything eaten. Return exactly one item describing 100 g of the product: amount 100, unit g, grams 100, the per 100 g values from the label, source "label", plus its name, brand, barcode digits if visible, serving_g and pack_g as printed.',
      images: decoded, savedFoods: [], products: [], localTime: localTime(), modelMode: getSettings(req.profile.id).model_mode,
    });
    const it = result.items[0];
    if (!it || it.source !== 'label' || !(it.grams > 0)) return res.status(422).json({ error: 'I couldn’t read a nutrition label in that. Try again closer up, with the table flat and in focus.' });
    // saveLabel copies the photo from the uploads folder, so put the first one there for a moment
    const tmp = `label-${req.profile.id}-${Date.now()}.${decoded[0].mediaType.split('/')[1].replace('jpeg', 'jpg')}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, tmp), Buffer.from(decoded[0].data, 'base64'));
    const saved = saveLabel(it, { profileId: req.profile.id, image: tmp });
    fs.rmSync(path.join(UPLOAD_DIR, tmp), { force: true });
    res.json({ ok: true, product: db.prepare(`${productWithOwner} WHERE f.id = ?`).get(saved.id) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/fooddb/export', (req, res) => {
  const foods = db.prepare(`SELECT ${PRODUCT_COLS.join(', ')}, source FROM food_db ORDER BY name COLLATE NOCASE`).all()
    .map((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null && v !== '')));
  res.setHeader('content-disposition', `attachment; filename="plateful-foods-${localDate()}.json"`);
  res.json({ plateful_foods: 1, per: '100 g', foods });
});

// Bulk add from a JSON file. preview: true only reports what would happen.
// A product matches an existing one by barcode, or by name and brand ignoring case.
app.post('/api/fooddb/import', (req, res) => {
  const body = req.body;
  const list = Array.isArray(body.foods) ? body.foods : Array.isArray(body.data?.foods) ? body.data.foods : Array.isArray(body.data) ? body.data : null;
  if (!list) return res.status(400).json({ error: 'That file needs a list of foods: either [ {...}, ... ] or { "foods": [ ... ] }.' });
  if (list.length > 5000) return res.status(400).json({ error: 'That’s over 5,000 foods. Split the file and import it in parts.' });
  const findCode = db.prepare('SELECT * FROM food_db WHERE barcode = ?');
  const findName = db.prepare('SELECT * FROM food_db WHERE lower(name) = lower(?) AND lower(brand) = lower(?)');
  const seen = new Map();
  const rows = list.map((raw, i) => {
    const { row, error } = cleanProduct(raw);
    if (error) return { line: i + 1, status: 'error', error, name: raw?.name ?? '' };
    const key = row.barcode || `${row.name.toLowerCase()}|${row.brand.toLowerCase()}`;
    if (seen.has(key)) return { line: i + 1, status: 'duplicate', name: row.name, brand: row.brand, of: seen.get(key) };
    seen.set(key, i + 1);
    const existing = (row.barcode && findCode.get(row.barcode)) || findName.get(row.name, row.brand);
    if (!existing) return { line: i + 1, status: 'new', ...row };
    // Blank fields in the file leave what's there alone, so only filled-in differences count
    const changed = PRODUCT_COLS.some((k) => row[k] != null && row[k] !== '' && row[k] !== existing[k]);
    return { line: i + 1, status: changed ? 'update' : 'same', id: existing.id, ...row };
  });
  const count = (st) => rows.filter((r) => r.status === st).length;
  const summary = { new: count('new'), update: count('update'), same: count('same'), duplicate: count('duplicate'), error: count('error') };
  if (body.preview) return res.json({ summary, rows });
  const updateToo = body.update !== false;
  const add = db.prepare(`INSERT INTO food_db (${PRODUCT_COLS.join(', ')}, source, added_by) VALUES (${PRODUCT_COLS.map((k) => `@${k}`).join(', ')}, 'import', @added_by)`);
  const upd = db.prepare(`UPDATE food_db SET ${PRODUCT_COLS.map((k) => `${k} = COALESCE(@${k}, ${k})`).join(', ')}, updated_at = datetime('now') WHERE id = @id`);
  db.transaction(() => {
    for (const r of rows) {
      const vals = Object.fromEntries(PRODUCT_COLS.map((k) => [k, r[k] === '' ? null : r[k] ?? null]));
      if (r.status === 'new') add.run({ ...vals, brand: r.brand, added_by: req.profile.id });
      else if (r.status === 'update' && updateToo) upd.run({ ...vals, id: r.id });
    }
  })();
  res.json({ ok: true, summary: { ...summary, update: updateToo ? summary.update : 0 } });
});

/* ---------- Dashboard ---------- */

app.get('/api/stats', (req, res) => {
  const pid = req.profile.id;
  const today = localDate();
  const end = isDate(req.query.date) && req.query.date <= today ? req.query.date : today;
  const settings = getSettings(pid);
  const weekStart = weekOf(end)[0];
  const from = addDays(weekStart, -7 * 7);
  const rows = db.prepare(`SELECT date, meal, name, ${NUTRIENTS.join(', ')} FROM entries WHERE profile_id = ? AND date BETWEEN ? AND ?`).all(pid, from, end);
  const byDate = new Map();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) || []), r]);

  const weeks = [];
  for (let w = 7; w >= 0; w -= 1) {
    const start = addDays(weekStart, -7 * w);
    const sum = weekSummary(pid, start, settings, today);
    const logged = sum.days.filter((d) => byDate.has(d.date));
    const totals = totalsFor(logged.flatMap((d) => byDate.get(d.date)));
    const avg = Object.fromEntries(NUTRIENTS.map((k) => [k, logged.length ? (k === 'kcal' ? Math.round(totals[k] / logged.length) : round1(totals[k] / logged.length)) : null]));
    weeks.push({ start, loggedDays: logged.length, avg, budget: sum.budget, used: sum.used,
      days: sum.days.map((d) => ({ ...d, logged: byDate.has(d.date), totals: totalsFor(byDate.get(d.date) || []) })) });
  }
  const thisWeek = weeks[weeks.length - 1];
  const weekRows = thisWeek.days.flatMap((d) => byDate.get(d.date) || []);
  const meals = Object.fromEntries(MEALS.map((m) => [m, Math.round(weekRows.filter((r) => r.meal === m).reduce((s, r) => s + r.kcal, 0))]));
  const foods = new Map();
  for (const r of weekRows) {
    const key = r.name.trim().toLowerCase();
    const f = foods.get(key) || { name: r.name, times: 0, kcal: 0 };
    f.times += 1;
    f.kcal += r.kcal;
    foods.set(key, f);
  }
  const topFoods = [...foods.values()].sort((a, b) => b.kcal - a.kcal).slice(0, 8).map((f) => ({ ...f, kcal: Math.round(f.kcal) }));
  // Days in a row with something logged, counting back from today (or yesterday, if today is still empty)
  const loggedDates = new Set(db.prepare('SELECT DISTINCT date FROM entries WHERE profile_id = ? AND date >= ?').all(pid, addDays(today, -400)).map((r) => r.date));
  let streak = 0;
  for (let d = loggedDates.has(today) ? today : addDays(today, -1); loggedDates.has(d); d = addDays(d, -1)) streak += 1;

  res.json({ today, date: end, profile: req.profile, settings, weeks, meals, topFoods, streak, weight: weightSummary(pid, settings) });
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
app.listen(port, () => console.log(`Plateful listening on :${port}`));
