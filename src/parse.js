import { UNIT_KEYS } from '../public/units.js';
import { provider, pickModel, canSeePhotos, extractJson, AiError } from './ai.js';

const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'note'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'brand', 'barcode', 'branded', 'product', 'serving_g', 'pack_g', 'amount', 'unit', 'grams', 'kcal', 'fat', 'carbs', 'protein', 'fibre', 'sugars', 'sat_fat', 'salt', 'source', 'meal'],
        properties: {
          name: { type: 'string' },
          brand: { type: 'string' },
          barcode: { type: 'string' },
          branded: { type: 'boolean' },
          product: { type: 'integer' },
          serving_g: { type: 'number' },
          pack_g: { type: 'number' },
          amount: { type: 'number' },
          unit: { type: 'string', enum: UNIT_KEYS },
          grams: { type: 'number' },
          kcal: { type: 'number' },
          fat: { type: 'number' },
          carbs: { type: 'number' },
          protein: { type: 'number' },
          fibre: { type: 'number' },
          sugars: { type: 'number' },
          sat_fat: { type: 'number' },
          salt: { type: 'number' },
          source: { type: 'string', enum: ['label', 'saved', 'db', 'est.'] },
          meal: { type: 'string', enum: MEALS },
        },
      },
    },
    note: { type: 'string' },
  },
};

const SYSTEM = `You turn food descriptions and photos into calorie diary entries for a UK user.

Return one item for every separate thing the user ate or drank, listing everything they mention or show: "cheese on toast with a cup of tea" is the bread, the cheese, any butter, the tea and the milk in it. Include spreads, oils, sauces, dressings, milk and sugar in drinks, as their own items, whenever they are mentioned or clearly part of the dish. Don't merge things into one "meal" item.

For each item give name, amount, unit, grams, kcal, and grams of fat, carbs, protein, fibre, sugars, saturated fat (sat_fat) and salt for the amount eaten.
- amount and unit say how much was eaten in the user's own terms. Units are UK: tsp 5 ml, dsp 10 ml, tbsp 15 ml, cup 250 ml, floz 28.4 ml, pint 568 ml; us_cup, us_floz and us_pint only if the user says US. Use "each" for whole things ("2 eggs" is amount 2, unit each), and slice, piece, handful, portion, bowl, pack and so on where they fit.
- grams is your best estimate of the total weight eaten, so the app can convert to other units later. For drinks, that's the volume in ml times the drink's density.
- brand: the shop or maker if the user says or a photo shows it (Tesco, Sainsbury's, Asda, Aldi, Lidl, M&S, Co-op, Morrisons, Waitrose, Heinz, Warburtons...), otherwise "". barcode: digits of a barcode you can read in a photo, otherwise "". branded: true when the item is a specific packaged product from a shop or brand, false for home-made or generic food.
- serving_g and pack_g: from a label, the serving size and the whole pack's weight in grams (or ml for drinks), as printed; 0 when there's no label or it doesn't say. Read the barcode digits too if they're legible.
- product: if the item is one of the numbered products in the food list below, its number; otherwise 0. Only pick one that really is the same product.
- Where the numbers come from, in order of preference:
  1. A nutrition label visible in a photo: read it and scale to the amount eaten; source "label".
  2. One of the user's saved foods: those values scaled to the amount; source "saved".
  3. A product from the food list: its per 100 g values scaled by grams; source "db".
  4. Otherwise typical UK values (supermarket own-brand, or McCance and Widdowson's composition of foods) for a realistic UK portion; source "est.".
- For a plate photo with no label, estimate each component separately from what is visible.
- Pick the meal from what the user says; if they don't say, use the time of day given.
- Round kcal to whole numbers and the other values to one decimal place.
- If the message has no food in it, return no items.

note: one or two short sentences in British English for the user, naming any assumption that moves the total by more than about 50 kcal (portion size, cooking oil, brand). Leave it empty if nothing needs saying.`;

export class ParseError extends Error {}

const SOURCES = ['label', 'saved', 'db', 'est.'];
const NUMS = ['amount', 'grams', 'kcal', 'fat', 'carbs', 'protein'];
// Some models leave these out; they're filled with nothing rather than sent back
const OPTIONAL = ['fibre', 'sugars', 'sat_fat', 'salt', 'serving_g', 'pack_g', 'product'];
const optional = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) || Number(x) < 0 ? null : Number(x));

// Checks a reply against the schema, mending what's safe to mend (a unit or meal we don't know)
// and naming what isn't, so a model that doesn't enforce schemas can be asked to fix it
function validate(out) {
  if (!out || typeof out !== 'object' || !Array.isArray(out.items)) return { error: 'The reply must be a JSON object with an "items" array and a "note" string.' };
  const items = [];
  for (const [i, it] of out.items.entries()) {
    if (!it || typeof it.name !== 'string' || !it.name.trim()) return { error: `items[${i}] needs a "name".` };
    const bad = NUMS.find((k) => !Number.isFinite(Number(it[k])) || Number(it[k]) < 0);
    if (bad) return { error: `items[${i}].${bad} must be a number of 0 or more.` };
    items.push({
      ...Object.fromEntries(NUMS.map((k) => [k, Number(it[k])])),
      ...Object.fromEntries(OPTIONAL.map((k) => [k, optional(it[k])])),
      name: it.name.trim(),
      brand: typeof it.brand === 'string' ? it.brand.trim() : '',
      barcode: typeof it.barcode === 'string' ? it.barcode.replace(/\D/g, '') : '',
      branded: it.branded === true,
      unit: UNIT_KEYS.includes(it.unit) ? it.unit : 'each',
      source: SOURCES.includes(it.source) ? it.source : 'est.',
      meal: MEALS.includes(it.meal) ? it.meal : 'snacks',
    });
  }
  return { value: { items, note: typeof out.note === 'string' ? out.note : '' } };
}

const schemaText = `Reply with only a JSON object, no other text, matching this JSON Schema:\n${JSON.stringify(SCHEMA)}`;

export async function parseFood({ text, images, savedFoods, products = [], localTime, modelMode }) {
  const problem = provider.ready();
  if (problem) throw new ParseError(`Plateful’s AI (${provider.label}) isn’t set up yet: ${problem} Saved foods and presets still work.`);

  // A provider that can't see photos still reads the words that came with them
  let note = '';
  if (images.length && !canSeePhotos()) {
    if (!text.trim()) throw new ParseError(`${provider.label} can’t read photos as set up here. Describe what you ate in words instead.`);
    images = [];
    note = 'I couldn’t look at the photo, so this is from your words only.';
  }

  const foodList = savedFoods.length
    ? savedFoods.map((f) => `- ${f.name}: per ${f.per} ${f.unit} = ${f.kcal} kcal, F${f.fat} C${f.carbs} P${f.protein}`).join('\n')
    : '(none)';
  const productList = products.length
    ? products.map((p) => `${p.id}. ${p.brand ? `${p.brand} ` : ''}${p.name}: per 100 g ${p.kcal} kcal, F${p.fat ?? '?'} C${p.carbs ?? '?'} P${p.protein ?? '?'}`
      + `${p.serving_g ? `, a serving is ${p.serving_g} g` : ''}`).join('\n')
    : '(none)';
  const base = `Saved foods:\n${foodList}\n\nFood list:\n${productList}\n\nLocal time: ${localTime}\n\nWhat I ate:\n${text || '(see photo)'}`;
  const model = pickModel(modelMode, images.length > 0);

  let prompt = provider.nativeSchema ? base : `${base}\n\n${schemaText}`;
  let usage = { input_tokens: 0, output_tokens: 0 };
  // One retry if the reply isn't usable JSON, telling the model what was wrong
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let reply;
    try {
      reply = await provider.ask({ system: SYSTEM, prompt, images, model, schema: SCHEMA });
    } catch (err) {
      if (err instanceof AiError) throw new ParseError(err.message);
      throw err;
    }
    usage = { input_tokens: usage.input_tokens + (reply.usage?.input_tokens || 0), output_tokens: usage.output_tokens + (reply.usage?.output_tokens || 0) };
    const checked = validate(reply.json ?? extractJson(reply.text));
    if (checked.value) {
      const out = checked.value;
      return { ...out, note: [note, out.note].filter(Boolean).join(' '), model: model || provider.label, usage };
    }
    console.error(`AI reply unusable (attempt ${attempt + 1}): ${checked.error}\n${String(reply.text ?? '').slice(0, 500)}`);
    prompt = `${base}\n\nYour previous reply couldn’t be used: ${checked.error}\n${schemaText}`;
  }
  throw new ParseError(`${provider.label} didn’t send back anything I could read, twice. Try again, or describe it differently.`);
}
