// The household food list: products from Open Food Facts (free, crowd-sourced, strong on UK
// supermarket own brands) and anything read off a label you photographed, kept per 100 g so
// every later use is a local lookup that costs no tokens.
import fs from 'node:fs';
import path from 'node:path';
import { db, UPLOAD_DIR } from './db.js';

export const FOOD_DIR = path.join(UPLOAD_DIR, 'food');
fs.mkdirSync(FOOD_DIR, { recursive: true });

const OFF = 'https://world.openfoodfacts.org';
const SEARCH = 'https://search.openfoodfacts.org/search';
// Open Food Facts asks every app to identify itself
const HEADERS = { 'user-agent': 'Plateful/1.0 (self-hosted calorie diary)' };
const FIELDS = 'code,product_name,product_name_en,brands,nutriments,serving_quantity';
export const NUTRIENTS = ['kcal', 'fat', 'carbs', 'protein', 'fibre', 'sugars', 'sat_fat', 'salt'];
const OFF_KEYS = {
  kcal: 'energy-kcal_100g', fat: 'fat_100g', carbs: 'carbohydrates_100g', protein: 'proteins_100g',
  fibre: 'fiber_100g', sugars: 'sugars_100g', sat_fat: 'saturated-fat_100g', salt: 'salt_100g',
};
export const SHOPS = ['tesco', 'sainsbury', 'asda', 'aldi', 'lidl', 'morrisons', 'waitrose', 'm&s', 'marks', 'co-op', 'coop', 'iceland', 'ocado', 'boots'];

const num = (x) => (x === '' || x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 100) / 100);

// One Open Food Facts product → a food_db row, or null if it has no calories to go on
function fromOff(p) {
  const n = p?.nutriments || {};
  let kcal = num(n[OFF_KEYS.kcal]);
  if (kcal == null && n['energy_100g'] != null) kcal = num(Number(n['energy_100g']) / 4.184); // kJ only
  const name = (p?.product_name_en || p?.product_name || '').trim();
  if (kcal == null || !name) return null;
  // All the brands, since own-brand lines are often listed as "Brooklea, Aldi"
  const brands = (Array.isArray(p.brands) ? p.brands.join(', ') : String(p.brands || '')).split(',').map((b) => b.trim()).filter(Boolean).join(', ').slice(0, 80);
  return {
    name, brand: brands, barcode: p.code ? String(p.code) : null, source: 'off',
    ...Object.fromEntries(NUTRIENTS.filter((k) => k !== 'kcal').map((k) => [k, num(n[OFF_KEYS[k]])])),
    kcal, serving_g: num(p.serving_quantity),
  };
}

const upsert = db.prepare(`INSERT INTO food_db (name, brand, barcode, source, kcal, fat, carbs, protein, fibre, sugars, sat_fat, salt, serving_g)
  VALUES (@name, @brand, @barcode, @source, @kcal, @fat, @carbs, @protein, @fibre, @sugars, @sat_fat, @salt, @serving_g)
  ON CONFLICT DO UPDATE SET kcal = excluded.kcal, fat = excluded.fat, carbs = excluded.carbs, protein = excluded.protein,
    fibre = excluded.fibre, sugars = excluded.sugars, sat_fat = excluded.sat_fat, salt = excluded.salt,
    barcode = COALESCE(excluded.barcode, food_db.barcode), serving_g = COALESCE(excluded.serving_g, food_db.serving_g),
    source = excluded.source, updated_at = datetime('now')
  RETURNING *`);

export function saveProduct(row) {
  // A barcode already on file under another name wins, so one product doesn't end up twice
  const byCode = row.barcode && db.prepare('SELECT id FROM food_db WHERE barcode = ?').get(row.barcode);
  if (byCode) {
    db.prepare(`UPDATE food_db SET ${NUTRIENTS.map((k) => `${k} = @${k}`).join(', ')}, source = @source, updated_at = datetime('now') WHERE id = @id`)
      .run({ ...row, id: byCode.id });
    return db.prepare('SELECT * FROM food_db WHERE id = ?').get(byCode.id);
  }
  return upsert.get({ fat: null, carbs: null, protein: null, fibre: null, sugars: null, sat_fat: null, salt: null, serving_g: null, barcode: null, brand: '', ...row });
}

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${new URL(url).host} said ${res.status}`);
  return res.json();
}

export async function lookupBarcode(code) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length < 8) return null;
  const known = db.prepare('SELECT * FROM food_db WHERE barcode = ?').get(clean);
  if (known) return known;
  const out = await getJson(`${OFF}/api/v2/product/${clean}?fields=${FIELDS}`);
  const row = out.status === 1 && fromOff(out.product);
  return row ? saveProduct({ ...row, barcode: clean }) : null;
}

// Open Food Facts text search is rate-limited (about 10 a minute) and sometimes down, so it's only
// used when asked and its results are kept. Search-a-licious first, the older search as a fallback.
const recent = [];
export async function searchOnline(q) {
  // Stay under Open Food Facts' limit of 10 searches a minute from this server
  const now = Date.now();
  while (recent.length && now - recent[0] > 60_000) recent.shift();
  if (recent.length >= 8) return [];
  recent.push(now);
  const tries = [
    async () => (await getJson(`${SEARCH}?q=${encodeURIComponent(q)}&langs=en&page_size=12&fields=${FIELDS}`)).hits,
    async () => (await getJson(`${OFF}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&json=1&page_size=12&fields=${FIELDS}`
      + '&tagtype_0=countries&tag_contains_0=contains&tag_0=united-kingdom')).products,
  ];
  for (const t of tries) {
    try {
      const rows = (await t() || []).map(fromOff).filter(Boolean);
      if (rows.length) return db.transaction(() => rows.map(saveProduct))();
    } catch (err) {
      console.error(`Open Food Facts search: ${err.message}`);
    }
  }
  return [];
}

const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3 || w === 'm&s');
const STOP = new Set(['and', 'the', 'with', 'for', 'had', 'ate', 'some', 'half', 'one', 'two', 'three', 'cup', 'bowl', 'slice', 'slices', 'pack', 'from', 'small', 'large', 'big']);

// Products in the list that share words with the text, best first
export function searchLocal(text, limit = 12) {
  const terms = [...new Set(words(text).filter((w) => !STOP.has(w)))].slice(0, 12);
  if (!terms.length) return [];
  const rows = db.prepare(`SELECT * FROM food_db WHERE ${terms.map(() => "(lower(name) || ' ' || lower(brand)) LIKE ?").join(' OR ')} LIMIT 300`)
    .all(...terms.map((t) => `%${t}%`));
  const score = (r) => terms.filter((t) => `${r.name} ${r.brand}`.toLowerCase().includes(t)).length;
  return rows.map((r) => ({ ...r, score: score(r) })).sort((a, b) => b.score - a.score || a.name.length - b.name.length).slice(0, limit);
}

// A product counts as the one meant only if every word of the query is in its name or brand
export function bestMatch(query, rows) {
  const terms = words(query).filter((w) => !STOP.has(w));
  if (!terms.length) return null;
  return rows.find((r) => terms.every((t) => `${r.name} ${r.brand}`.toLowerCase().replace(/['’]/g, '').includes(t.replace(/['’]/g, '')))) || null;
}

// Scales a per-100 g product to an item's weight
export function nutrientsFor(product, grams) {
  const k = grams / 100;
  return Object.fromEntries(NUTRIENTS.map((n) => [n, product[n] == null ? null : n === 'kcal' ? Math.round(product[n] * k) : Math.round(product[n] * k * 10) / 10]));
}

// Saves what was read off a label as a per-100 g product, so the next time it's a lookup.
// Keeps the serving and pack size, who it came from, and a copy of the photo for the Foods screen.
export function saveLabel(item, { profileId = null, image = null } = {}) {
  if (!(item.grams > 0) || !(item.kcal >= 0) || !item.name) return null;
  const k = 100 / item.grams;
  const per100 = Object.fromEntries(NUTRIENTS.map((n) => [n, item[n] == null ? null : Math.round(item[n] * k * 100) / 100]));
  const p = saveProduct({ ...per100, name: item.name, brand: item.brand || '', barcode: String(item.barcode || '').replace(/\D/g, '') || null, source: 'label' });
  const size = (x) => (Number(x) > 0 ? Number(x) : null);
  let photo = null;
  if (image) {
    const file = path.join(UPLOAD_DIR, path.basename(image));
    if (fs.existsSync(file)) {
      photo = `${p.id}-${Date.now()}${path.extname(file)}`;
      fs.copyFileSync(file, path.join(FOOD_DIR, photo));
      if (p.photo) fs.rmSync(path.join(FOOD_DIR, path.basename(p.photo)), { force: true });
    }
  }
  db.prepare(`UPDATE food_db SET serving_g = COALESCE(@serving_g, serving_g), pack_g = COALESCE(@pack_g, pack_g),
      added_by = COALESCE(added_by, @profileId), photo = COALESCE(@photo, photo) WHERE id = @id`)
    .run({ serving_g: size(item.serving_g), pack_g: size(item.pack_g), profileId, photo: photo && `/uploads/food/${photo}`, id: p.id });
  return db.prepare('SELECT * FROM food_db WHERE id = ?').get(p.id);
}

// "Tesco Finest Sourdough" rather than "Tesco Tesco Finest Sourdough"
export const productLabel = (p) => {
  const brand = String(p.brand || '').split(',').map((b) => b.trim()).find((b) => b && !p.name.toLowerCase().includes(b.toLowerCase()));
  return p.brand && brand === undefined ? p.name : `${brand ? `${brand} ` : ''}${p.name}`;
};

// Typed messages made only of foods already in the list ("63g of the protein granola, a pack of
// Tesco crisps") are logged here without asking the AI. Anything it isn't sure of returns null,
// and the whole message goes to the AI as usual.
const NUMBER_WORDS = { a: 1, an: 1, one: 1, half: 0.5, two: 2, three: 3, four: 4 };
const MEAL_WORDS = { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', tea: 'dinner', supper: 'dinner', snack: 'snacks', snacks: 'snacks' };
const PACK_UNITS = /^(packs?|bags?|pots?|tins?|cans?|bars?|tubs?|bottles?|cartons?|boxe?s?)$/;
const SERVING_UNITS = /^(servings?|portions?|bowls?)$/;

export function matchLocally(text) {
  let meal = null;
  const clean = String(text || '').replace(/\b(?:for|at|with)\s+(breakfast|lunch|dinner|tea|supper|snacks?)\b/gi, (_, w) => { meal = MEAL_WORDS[w.toLowerCase()]; return ' '; })
    .replace(/^\s*(?:i(?:'ve| have)?\s+)?(?:just\s+)?(?:had|ate|eaten)\s+/i, '');
  const parts = clean.split(/,|\n|;|\+|\band\b|\bplus\b/i).map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.length > 8) return null;
  const items = [];
  for (const part of parts) {
    const m = /^(\d+(?:\.\d+)?|a|an|one|half|two|three|four)\s*(g|grams?|kg|ml|[a-z]+)?\s+(?:of\s+)?(?:(?:the|my|a|an|some)\s+)?(.+)$/i.exec(part)
      || /^(\d+(?:\.\d+)?)(g|kg|ml)\s*(?:of\s+)?(?:(?:the|my)\s+)?(.+)$/i.exec(part);
    if (!m) return null;
    let amount = NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1]);
    let unitWord = (m[2] || '').toLowerCase();
    let name = m[3];
    // "half a pack of", "a slice of": the unit sat after an article
    const inner = /^(?:a|an)\s+([a-z]+)\s+of\s+(.+)$/i.exec(name);
    if (!unitWord || NUMBER_WORDS[unitWord]) { if (inner) { unitWord = inner[1].toLowerCase(); name = inner[2]; } }
    // Every word typed must be in the product, and the words typed must cover at least half of its
    // name, so "granola" alone doesn't silently become one particular granola
    const typed = new Set(words(name).filter((w) => !STOP.has(w)));
    const covers = (r) => { const own = words(r.name).filter((w) => !STOP.has(w)); return own.filter((w) => typed.has(w)).length >= own.length / 2; };
    const matches = searchLocal(name, 30).filter((r) => bestMatch(name, [r]) && covers(r));
    if (matches.length !== 1) return null; // nothing, or more than one product fits: let the AI decide
    const p = matches[0];
    let grams;
    let unit;
    if (/^(g|grams?)$/.test(unitWord)) { grams = amount; unit = 'g'; }
    else if (unitWord === 'kg') { grams = amount * 1000; amount *= 1000; unit = 'g'; }
    else if (unitWord === 'ml') { grams = amount; unit = 'ml'; }
    else if (PACK_UNITS.test(unitWord) && p.pack_g) { grams = amount * p.pack_g; unit = 'pack'; }
    else if (SERVING_UNITS.test(unitWord) && p.serving_g) { grams = amount * p.serving_g; unit = 'portion'; }
    else return null;
    items.push({ name: productLabel(p), amount, unit, grams, ...nutrientsFor(p, grams), source: 'db', meal, product_id: p.id, product_name: productLabel(p), needs_label: 0, local: true });
  }
  return items;
}
