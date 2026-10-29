import { spawn } from 'node:child_process';
import { UNIT_KEYS } from '../public/units.js';

const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';

// 'auto' sends typed-only messages to Haiku (much lighter on usage, fine for "two crumpets with butter")
// and anything with a photo to Sonnet, which reads labels and plates more reliably.
function pickModel(mode, hasImages) {
  if (mode === 'sonnet') return SONNET;
  if (mode === 'haiku') return HAIKU;
  return hasImages ? SONNET : HAIKU;
}
// Runs through the Claude Code CLI, signed in either with a subscription token from
// `claude setup-token` or with an API key from the Claude Console (billed per use)
export const claudeAuth = process.env.ANTHROPIC_API_KEY ? 'api_key' : process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'subscription' : null;
const TIMEOUT_MS = 180_000;

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

// Runs `claude -p` with no tools and returns its final result event
function runClaude(content, model) {
  const args = ['-p', '--model', model, '--effort', 'medium', '--system-prompt', SYSTEM, '--json-schema', JSON.stringify(SCHEMA),
    '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--no-session-persistence',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .findLast((e) => e?.type === 'result');
      if (!result) return reject(new Error(`claude exited ${code} with no result: ${err.slice(-500)}`));
      resolve(result);
    });
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  });
}

export async function parseFood({ text, images, savedFoods, localTime, modelMode }) {
  if (!claudeAuth) throw new ParseError('Larder isn’t signed in to Claude yet (no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in .env), so for now only saved foods and presets work.');

  const foodList = savedFoods.length
    ? savedFoods.map((f) => `- ${f.name}: per ${f.per} ${f.unit} = ${f.kcal} kcal, F${f.fat} C${f.carbs} P${f.protein}`).join('\n')
    : '(none)';

  const content = [
    ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
    { type: 'text', text: `Saved foods:\n${foodList}\n\nLocal time: ${localTime}\n\nWhat I ate:\n${text || '(see photo)'}` },
  ];

  const model = pickModel(modelMode, images.length > 0);
  const result = await runClaude(content, model);
  if (result.is_error) {
    if (result.stop_reason === 'refusal') throw new ParseError('Claude declined to read that one. Try describing it in words.');
    throw new Error(`claude: ${result.subtype} ${String(result.result ?? '').slice(0, 300)}`);
  }
  if (!result.structured_output) throw new ParseError('Claude sent back nothing I could read.');

  const usage = result.usage ?? {};
  return { ...result.structured_output, model, usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } };
}
