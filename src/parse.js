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
        required: ['name', 'amount', 'unit', 'grams', 'kcal', 'fat', 'carbs', 'protein', 'source', 'meal'],
        properties: {
          name: { type: 'string' },
          amount: { type: 'number' },
          unit: { type: 'string', enum: UNIT_KEYS },
          grams: { type: 'number' },
          kcal: { type: 'number' },
          fat: { type: 'number' },
          carbs: { type: 'number' },
          protein: { type: 'number' },
          source: { type: 'string', enum: ['label', 'saved', 'est.'] },
          meal: { type: 'string', enum: MEALS },
        },
      },
    },
    note: { type: 'string' },
  },
};

const SYSTEM = `You turn food descriptions and photos into calorie diary entries for a UK user.

For each distinct food or drink, return one item with name, amount, unit, grams, kcal and grams of fat, carbs and protein for the amount eaten.
- amount and unit say how much was eaten in the user's own terms. Units are UK: tsp 5 ml, dsp 10 ml, tbsp 15 ml, cup 250 ml, floz 28.4 ml, pint 568 ml; us_cup, us_floz and us_pint only if the user says US. Use "each" for whole things ("2 eggs" is amount 2, unit each), and slice, piece, handful, portion, bowl, pack and so on where they fit.
- grams is your best estimate of the total weight eaten, so the app can convert to other units later. For drinks, that's the volume in ml times the drink's density.
- If a nutrition label is visible, read it and scale to the amount eaten; source "label".
- If the food matches one of the user's saved foods, use those values scaled to the amount; source "saved".
- Otherwise use typical UK values (supermarket own-brand or McCance and Widdowson style figures) for a realistic UK portion; source "est.".
- For a plate photo with no label, estimate each component separately from what is visible.
- Pick the meal from what the user says; if they don't say, use the time of day given.
- Round kcal to whole numbers and macros to one decimal place.
- If the message has no food in it, return no items.

note: one or two short sentences in British English for the user, naming any assumption that moves the total by more than about 50 kcal (portion size, cooking oil, brand). Leave it empty if nothing needs saying.`;

export class ParseError extends Error {}

const SOURCES = ['label', 'saved', 'est.'];
const NUMS = ['amount', 'grams', 'kcal', 'fat', 'carbs', 'protein'];

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
      name: it.name.trim(),
      unit: UNIT_KEYS.includes(it.unit) ? it.unit : 'each',
      source: SOURCES.includes(it.source) ? it.source : 'est.',
      meal: MEALS.includes(it.meal) ? it.meal : 'snacks',
    });
  }
  return { value: { items, note: typeof out.note === 'string' ? out.note : '' } };
}

const schemaText = `Reply with only a JSON object, no other text, matching this JSON Schema:\n${JSON.stringify(SCHEMA)}`;

export async function parseFood({ text, images, savedFoods, localTime, modelMode }) {
  const problem = provider.ready();
  if (problem) throw new ParseError(`Larder’s AI (${provider.label}) isn’t set up yet: ${problem} Saved foods and presets still work.`);

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
  const base = `Saved foods:\n${foodList}\n\nLocal time: ${localTime}\n\nWhat I ate:\n${text || '(see photo)'}`;
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
