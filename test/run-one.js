// Runs one parseFood call with whatever PLATEFUL_AI settings are in the environment; prints the result
import { parseFood } from '../src/parse.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const images = process.env.WITH_PHOTO ? [{ mediaType: 'image/png', data: png }] : [];
parseFood({ text: process.env.TEXT ?? 'two crumpets with butter', images, savedFoods: [], localTime: '2026-10-29 Thursday 08:10', modelMode: process.env.MODE || 'auto' })
  .then((r) => console.log(JSON.stringify({ ok: r })))
  .catch((e) => console.log(JSON.stringify({ error: e.message, kind: e.constructor.name })));
