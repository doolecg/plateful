// Units of measure, shared by the browser and the server. Every amount is converted through
// grams: weights exactly, volumes via the food's density (g per ml, water = 1), and counts
// (slices, handfuls...) via the food's grams per one of them.

export const UNITS = {
  // weight: grams per unit
  g: { kind: 'weight', g: 1, label: 'g' },
  kg: { kind: 'weight', g: 1000, label: 'kg' },
  oz: { kind: 'weight', g: 28.3495, label: 'oz' },
  lb: { kind: 'weight', g: 453.592, label: 'lb' },
  st: { kind: 'weight', g: 6350.29, label: 'st' },
  // volume: ml per unit (UK measures unless marked US)
  ml: { kind: 'volume', ml: 1, label: 'ml' },
  cl: { kind: 'volume', ml: 10, label: 'cl' },
  l: { kind: 'volume', ml: 1000, label: 'l' },
  tsp: { kind: 'volume', ml: 5, label: 'tsp' },
  dsp: { kind: 'volume', ml: 10, label: 'dessertspoon', plural: 'dessertspoons' },
  tbsp: { kind: 'volume', ml: 15, label: 'tbsp' },
  cup: { kind: 'volume', ml: 250, label: 'cup', plural: 'cups' },
  us_cup: { kind: 'volume', ml: 236.588, label: 'US cup', plural: 'US cups' },
  floz: { kind: 'volume', ml: 28.4131, label: 'fl oz' },
  us_floz: { kind: 'volume', ml: 29.5735, label: 'US fl oz' },
  pint: { kind: 'volume', ml: 568.261, label: 'pint', plural: 'pints' },
  half_pint: { kind: 'volume', ml: 284.131, label: 'half pint', plural: 'half pints' },
  us_pint: { kind: 'volume', ml: 473.176, label: 'US pint', plural: 'US pints' },
  shot: { kind: 'volume', ml: 25, label: 'shot', plural: 'shots' },
  glass: { kind: 'volume', ml: 250, label: 'glass', plural: 'glasses' },
  mug: { kind: 'volume', ml: 300, label: 'mug', plural: 'mugs' },
  can: { kind: 'volume', ml: 330, label: 'can', plural: 'cans' },
  bottle: { kind: 'volume', ml: 500, label: 'bottle', plural: 'bottles' },
  // count: rough grams for one, used only until the food's own figure is known
  each: { kind: 'count', g: 100, label: '', plural: '' },
  slice: { kind: 'count', g: 35, label: 'slice', plural: 'slices' },
  piece: { kind: 'count', g: 30, label: 'piece', plural: 'pieces' },
  handful: { kind: 'count', g: 30, label: 'handful', plural: 'handfuls' },
  portion: { kind: 'count', g: 150, label: 'portion', plural: 'portions' },
  bowl: { kind: 'count', g: 250, label: 'bowl', plural: 'bowls' },
  plate: { kind: 'count', g: 400, label: 'plate', plural: 'plates' },
  pack: { kind: 'count', g: 100, label: 'pack', plural: 'packs' },
  bar: { kind: 'count', g: 40, label: 'bar', plural: 'bars' },
  scoop: { kind: 'count', g: 30, label: 'scoop', plural: 'scoops' },
  pinch: { kind: 'count', g: 0.5, label: 'pinch', plural: 'pinches' },
};

export const UNIT_GROUPS = [
  ['Weight', ['g', 'kg', 'oz', 'lb', 'st']],
  ['Spoons and cups', ['tsp', 'dsp', 'tbsp', 'cup', 'us_cup']],
  ['Liquids', ['ml', 'cl', 'l', 'floz', 'us_floz', 'shot', 'glass', 'mug', 'half_pint', 'pint', 'us_pint', 'can', 'bottle']],
  ['Pieces and portions', ['each', 'slice', 'piece', 'handful', 'scoop', 'bar', 'pinch', 'portion', 'bowl', 'plate', 'pack']],
];

export const UNIT_KEYS = Object.keys(UNITS);

const ALIASES = {
  g: 'g', gram: 'g', grams: 'g', gr: 'g', kg: 'kg', kilo: 'kg', kilos: 'kg', oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', ml: 'ml', millilitre: 'ml', millilitres: 'ml', cl: 'cl',
  l: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l', tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  dessertspoon: 'dsp', dessertspoons: 'dsp', dsp: 'dsp', tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup', 'fl oz': 'floz', floz: 'floz', pint: 'pint', pints: 'pint', 'half pint': 'half_pint',
  shot: 'shot', shots: 'shot', glass: 'glass', glasses: 'glass', mug: 'mug', mugs: 'mug', can: 'can', cans: 'can',
  bottle: 'bottle', bottles: 'bottle', slice: 'slice', slices: 'slice', piece: 'piece', pieces: 'piece',
  handful: 'handful', handfuls: 'handful', portion: 'portion', portions: 'portion', serving: 'portion', servings: 'portion',
  bowl: 'bowl', bowls: 'bowl', plate: 'plate', plates: 'plate', pack: 'pack', packs: 'pack', packet: 'pack', packets: 'pack',
  bar: 'bar', bars: 'bar', scoop: 'scoop', scoops: 'scoop', pinch: 'pinch', each: 'each', whole: 'each',
  pot: 'pack', pots: 'pack', tub: 'pack', tubs: 'pack', sachet: 'pack', sachets: 'pack',
};

// "146 g", "2 slices", "1 pack (1 serving)" → { amount, unit }; null when it can't tell
export function parseQuantity(text) {
  const m = /^\s*(\d+(?:\.\d+)?|\d+\/\d+)\s*([a-z][a-z .]*?)?\s*(?:\(.*\))?\s*$/i.exec(text || '');
  if (!m) return null;
  const amount = m[1].includes('/') ? Number(m[1].split('/')[0]) / Number(m[1].split('/')[1]) : Number(m[1]);
  if (!m[2]) return { amount, unit: 'each' };
  const words = m[2].toLowerCase().trim();
  const unit = ALIASES[words] || ALIASES[words.split(' ').pop()];
  return unit ? { amount, unit } : null;
}

// What the unit picker shows: spoons and cups say how big they are, since UK and US differ
export function unitOption(key) {
  const u = UNITS[key];
  if (key === 'each') return 'each (whole item)';
  if (u.kind === 'volume' && u.ml !== 1 && key !== 'l' && key !== 'cl') return `${u.label} (${Math.round(u.ml * 10) / 10} ml)`;
  return u.label;
}

const trim = (x) => String(Math.round(x * 100) / 100);

export function formatQuantity(amount, unit) {
  const u = UNITS[unit];
  if (!u || amount == null) return '';
  if (unit === 'each') return trim(amount);
  const label = amount === 1 || !u.plural ? u.label : u.plural;
  return `${trim(amount)} ${label}`;
}

// Grams in `amount` of `unit` for one item, given what's known about that food
export function toGrams(amount, unit, { density, each_g: eachG } = {}) {
  const u = UNITS[unit];
  if (!u) return null;
  if (u.kind === 'weight') return amount * u.g;
  if (u.kind === 'volume') return amount * u.ml * (density || 1);
  return amount * (eachG || u.g);
}

// Fills in grams and the per-unit figure an item needs to be converted later
export function withGrams(item) {
  const u = UNITS[item.unit];
  if (!u || !(item.amount > 0)) return item;
  const out = { ...item };
  if (!(out.grams > 0)) out.grams = toGrams(out.amount, out.unit, out);
  if (u.kind === 'volume' && !out.density) out.density = out.grams / (out.amount * u.ml);
  if (u.kind === 'count' && !out.each_g) out.each_g = out.grams / out.amount;
  out.grams = Math.round(out.grams * 10) / 10;
  return out;
}
