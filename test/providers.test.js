// Each AI provider against a stand-in (fake CLIs in test/fakes, tiny HTTP servers here), so this
// checks Larder's side of the conversation: flags, files, parsing, retries. Not the real services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakes = path.join(here, 'fakes');
const reply = fs.readFileSync(path.join(fakes, 'reply.json'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'larder-test-'));

function parse(envs) {
  const log = path.join(tmp, `log-${Math.random().toString(36).slice(2)}`);
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LARDER_|CLAUDE_CODE|ANTHROPIC_|OLLAMA_)/.test(k)));
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(here, 'run-one.js')], {
      env: { ...clean, PATH: `${fakes}:${process.env.PATH}`, FAKE_LOG: log, DATA_DIR: tmp, ...envs },
    }, (err, stdout) => {
      if (err) return reject(err);
      const out = JSON.parse(stdout.trim().split('\n').pop());
      resolve({ ...out, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' });
    });
  });
}

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => handler(req, JSON.parse(body || '{}'), res));
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
}

const crumpet = (r) => assert.equal(r.ok?.items?.[0]?.name, 'Crumpet with butter', JSON.stringify(r));

test('claude: picks Haiku for text and Sonnet for photos, sends the photo inline', async () => {
  const r = await parse({ CLAUDE_CODE_OAUTH_TOKEN: 'x' });
  crumpet(r);
  assert.equal(r.ok.model, 'claude-haiku-5-5');
  const p = await parse({ CLAUDE_CODE_OAUTH_TOKEN: 'x', WITH_PHOTO: '1' });
  assert.equal(p.ok.model, 'claude-sonnet-5-5');
  assert.match(p.log, /"type":"image"/);
});

test('claude: refuses politely with no token', async () => {
  const r = await parse({});
  assert.match(r.error, /isn’t set up yet/);
});

test('codex: passes the schema, the photo files and a model', async () => {
  const r = await parse({ LARDER_AI: 'codex', LARDER_PHOTO_MODEL: 'gpt-x', WITH_PHOTO: '1' });
  crumpet(r);
  assert.equal(r.ok.model, 'gpt-x');
  assert.match(r.log, /photo1\.png/);
});

test('gemini: references photos as @files and unwraps a fenced reply', async () => {
  const r = await parse({ LARDER_AI: 'gemini', WITH_PHOTO: '1' });
  crumpet(r);
  assert.match(r.log, /@photo1\.png/);
});

test('opencode: digs the JSON out of chatty, coloured output and attaches photos with -f', async () => {
  const r = await parse({ LARDER_AI: 'opencode', LARDER_TEXT_MODEL: 'openai/gpt-x', WITH_PHOTO: '1' });
  crumpet(r);
  assert.match(r.log, /-f \S+photo1\.png/);
});

test('ollama: posts to /api/chat with the schema and base64 photos', async () => {
  let seen;
  const s = await server((req, body, res) => { seen = { url: req.url, body }; res.end(JSON.stringify({ message: { content: reply }, prompt_eval_count: 50, eval_count: 20 })); });
  const r = await parse({ LARDER_AI: 'ollama', LARDER_TEXT_MODEL: 'gemma3', OLLAMA_HOST: `http://127.0.0.1:${s.address().port}`, WITH_PHOTO: '1' });
  s.close();
  crumpet(r);
  assert.equal(seen.url, '/api/chat');
  assert.equal(seen.body.model, 'gemma3');
  assert.equal(seen.body.format.type, 'object');
  assert.equal(seen.body.messages[1].images.length, 1);
});

test('ollama: says what to set when no model is given', async () => {
  const r = await parse({ LARDER_AI: 'ollama' });
  assert.match(r.error, /LARDER_TEXT_MODEL/);
});

test('openai-compatible: falls back to a plain request when json_schema is rejected', async () => {
  const bodies = [];
  const s = await server((req, body, res) => {
    bodies.push(body);
    if (body.response_format) { res.statusCode = 400; return res.end('{"error":"response_format not supported"}'); }
    res.end(JSON.stringify({ choices: [{ message: { content: `Sure:\n${reply}` } }] }));
  });
  const r = await parse({ LARDER_AI: 'openai', LARDER_AI_URL: `http://127.0.0.1:${s.address().port}/v1`, WITH_PHOTO: '1' });
  s.close();
  crumpet(r);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].messages[1].content[1].type, 'image_url');
});

test('custom: retries once with the problem spelled out when the first reply is wrong', async () => {
  const r = await parse({ LARDER_AI: 'custom', LARDER_AI_COMMAND: 'flaky < {prompt_file}' });
  crumpet(r);
  assert.equal(r.log.trim(), '2');
});

test('custom: no image placeholder means words only, with a note saying so', async () => {
  const r = await parse({ LARDER_AI: 'custom', LARDER_AI_COMMAND: `cat ${path.join(fakes, 'reply.json')}`, WITH_PHOTO: '1' });
  crumpet(r);
  assert.match(r.ok.note, /couldn’t look at the photo/);
  const bare = await parse({ LARDER_AI: 'custom', LARDER_AI_COMMAND: 'true', WITH_PHOTO: '1', TEXT: '' });
  assert.match(bare.error, /can’t read photos/);
});

test('a missing CLI gives a clear message', async () => {
  const r = await parse({ LARDER_AI: 'gemini', PATH: '/usr/bin:/bin' });
  assert.match(r.error, /isn’t installed/);
});
