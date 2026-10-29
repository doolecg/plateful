// The AI that reads food. Larder works with anything that can take a prompt (and ideally a photo)
// and reply with JSON: a coding CLI signed in on this machine, a local model server, or any
// command you give it. Pick one with LARDER_AI in .env; see SETUP.md.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const env = process.env;
const TIMEOUT_MS = (Number(env.LARDER_AI_TIMEOUT) || 180) * 1000;

export class AiError extends Error {}

// Empty settings from .env ("CODEX_API_KEY=") are dropped so no tool mistakes them for a real key
const childEnv = { ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')), NO_COLOR: '1' };

// Runs a program with a prompt on stdin and resolves with what it printed
function run(cmd, args, { input = '', cwd, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new AiError(`“${cmd}” isn’t installed where Larder runs. See SETUP.md, “Choosing an AI”.`) : e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') return reject(new AiError(`${cmd} took longer than ${TIMEOUT_MS / 1000} seconds. Raise LARDER_AI_TIMEOUT for slow models.`));
      if (code !== 0 && !stdout.trim()) {
        console.error(`${cmd} exited ${code}: ${stderr.slice(-1500)}`);
        // Show the person the tool's own complaint (bad key, not signed in...), not a stack of JSON
        const err = stripAnsi(stderr);
        const said = [...err.matchAll(/\\*"message\\*"\s*:\s*\\*"([^"\\]{8,200})/g)].pop()?.[1]
          || err.split('\n').map((l) => l.trim()).filter((l) => /[a-z]{3}/i.test(l) && !/^at\s/.test(l)).pop() || `exit code ${code}`;
        return reject(new AiError(`${cmd} failed: ${said.slice(0, 200)}`));
      }
      resolve({ stdout, stderr, code });
    });
    child.stdin.on('error', () => {}); // some CLIs never read stdin
    child.stdin.end(input);
  });
}

// Photos as files, for CLIs that take paths. Removed again once the reply is in.
async function withImageFiles(images, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'larder-'));
  try {
    const paths = [];
    for (const [i, img] of images.entries()) {
      const p = path.join(dir, `photo${i + 1}.${img.mediaType.split('/')[1].replace('jpeg', 'jpg')}`);
      await fs.writeFile(p, Buffer.from(img.data, 'base64'));
      paths.push(p);
    }
    return await fn(paths, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => { throw new AiError(`Couldn’t reach ${new URL(url).host}: ${e.cause?.code || e.message}. Is it running?`); });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${url} said ${res.status}: ${text.slice(0, 400)}`), { status: res.status });
  return JSON.parse(text);
}

/* Each provider: label, default models for typed messages and for photos, whether it can see
   photos, and ask({ system, prompt, images, model, schema }) → { text | json, usage }.
   `prompt` already includes the JSON schema for providers that can't enforce one themselves. */
export const PROVIDERS = {
  claude: {
    label: 'Claude Code',
    models: { text: 'claude-haiku-5-5', photo: 'claude-sonnet-5-5' },
    images: true,
    nativeSchema: true,
    ready: () => (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN ? null : 'No CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in .env.'),
    async ask({ system, prompt, images, model, schema }) {
      const args = ['-p', '--model', model, '--effort', 'medium', '--system-prompt', system, '--json-schema', JSON.stringify(schema),
        '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--no-session-persistence',
        '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
      const content = [
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
        { type: 'text', text: prompt },
      ];
      const { stdout, stderr } = await run('claude', args, { input: `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n` });
      const result = stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .findLast((e) => e?.type === 'result');
      if (!result) throw new Error(`claude gave no result: ${stderr.slice(-500)}`);
      if (result.is_error) {
        if (result.stop_reason === 'refusal') throw new AiError('Claude declined to read that one. Try describing it in words.');
        throw new Error(`claude: ${result.subtype} ${String(result.result ?? '').slice(0, 300)}`);
      }
      return { json: result.structured_output, text: result.result, usage: result.usage };
    },
  },

  // OpenAI's Codex CLI: `codex exec` with a read-only sandbox, enforcing the schema itself
  codex: {
    label: 'OpenAI Codex',
    models: { text: '', photo: '' },
    images: true,
    nativeSchema: true,
    ready: () => null,
    ask({ system, prompt, images, model, schema }) {
      return withImageFiles(images, async (paths, dir) => {
        const schemaPath = path.join(dir, 'schema.json');
        const outPath = path.join(dir, 'reply.json');
        await fs.writeFile(schemaPath, JSON.stringify(schema));
        // -i takes several values, so each photo gets its own -i and they come before the other flags
        const args = ['exec', ...paths.flatMap((p) => ['-i', p]), '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
          '--output-schema', schemaPath, '-o', outPath, ...(model ? ['-m', model] : []), '-'];
        await run('codex', args, { input: `${system}\n\n${prompt}`, cwd: dir });
        return { text: await fs.readFile(outPath, 'utf8') };
      });
    },
  },

  // Google's Gemini CLI in headless mode; photos are referenced as @files in its working folder
  gemini: {
    label: 'Gemini CLI',
    models: { text: 'flash', photo: 'flash' },
    images: true,
    ready: () => null,
    ask({ system, prompt, images, model }) {
      return withImageFiles(images, async (paths, dir) => {
        const refs = paths.map((p) => `@${path.basename(p)}`).join(' ');
        // --skip-trust: headless runs refuse to start in an untrusted folder, and this one is a fresh temp folder
        const args = ['-p', `${system}\n\n${prompt}${refs ? `\n\nPhotos: ${refs}` : ''}`, '--output-format', 'json', '--skip-trust', ...(model ? ['-m', model] : [])];
        const { stdout } = await run('gemini', args, { cwd: dir });
        const out = JSON.parse(stdout);
        if (out.error) throw new Error(`gemini: ${JSON.stringify(out.error).slice(0, 300)}`);
        return { text: out.response };
      });
    },
  },

  // opencode, which can sit in front of almost any provider (OpenAI, Anthropic, OpenRouter, local)
  opencode: {
    label: 'opencode',
    models: { text: '', photo: '' },
    images: true,
    ready: () => null,
    ask({ system, prompt, images, model }) {
      return withImageFiles(images, async (paths, dir) => {
        // The message goes first: -f takes several values and would swallow it otherwise
        const args = ['run', `${system}\n\n${prompt}`, ...(model ? ['-m', model] : []), ...paths.flatMap((p) => ['-f', p])];
        const { stdout } = await run('opencode', args, { cwd: dir });
        return { text: stripAnsi(stdout) };
      });
    },
  },

  // Ollama's own HTTP API (the same server the `ollama` command talks to), with schema-constrained output
  ollama: {
    label: 'Ollama',
    models: { text: '', photo: '' },
    images: true,
    nativeSchema: true,
    ready: () => (textModel() ? null : 'Set LARDER_TEXT_MODEL in .env to an Ollama model you’ve pulled, for example gemma3.'),
    async ask({ system, prompt, images, model, schema }) {
      const host = (env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
      const out = await postJson(`${host.startsWith('http') ? host : `http://${host}`}/api/chat`, {
        model, stream: false, format: schema, options: { temperature: 0 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt, ...(images.length ? { images: images.map((i) => i.data) } : {}) }],
      });
      return { text: out.message?.content, usage: { input_tokens: out.prompt_eval_count, output_tokens: out.eval_count } };
    },
  },

  // Any OpenAI-compatible server: llama.cpp's llama-server, LM Studio, vLLM, LocalAI, OpenRouter...
  openai: {
    label: 'OpenAI-compatible server',
    models: { text: '', photo: '' },
    images: true,
    nativeSchema: true,
    ready: () => (env.LARDER_AI_URL ? null : 'Set LARDER_AI_URL in .env, for example http://host.docker.internal:8081/v1.'),
    async ask({ system, prompt, images, model, schema }) {
      const url = `${env.LARDER_AI_URL.replace(/\/$/, '')}/chat/completions`;
      const headers = env.LARDER_AI_KEY ? { authorization: `Bearer ${env.LARDER_AI_KEY}` } : {};
      const body = {
        ...(model ? { model } : {}), temperature: 0,
        messages: [{ role: 'system', content: system }, {
          role: 'user',
          content: [{ type: 'text', text: prompt }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } }))],
        }],
      };
      let out;
      try {
        out = await postJson(url, { ...body, response_format: { type: 'json_schema', json_schema: { name: 'diary_entries', strict: true, schema } } }, headers);
      } catch (err) {
        // Plenty of local servers don't do json_schema; the schema is in the prompt too, so ask plainly
        if (err.status !== 400 && err.status !== 422) throw err;
        out = await postJson(url, body, headers);
      }
      return { text: out.choices?.[0]?.message?.content, usage: { input_tokens: out.usage?.prompt_tokens, output_tokens: out.usage?.completion_tokens } };
    },
  },

  // Anything else: a shell command. {prompt_file}, {prompt}, {image}, {images} and {model} are filled
  // in (quoted); without {prompt} or {prompt_file} the prompt goes on stdin. Must print the JSON.
  custom: {
    label: 'Custom command',
    models: { text: '', photo: '' },
    get images() { return /\{images?\}/.test(env.LARDER_AI_COMMAND || ''); },
    ready: () => (env.LARDER_AI_COMMAND ? null : 'Set LARDER_AI_COMMAND in .env.'),
    ask({ system, prompt, images, model }) {
      const template = env.LARDER_AI_COMMAND;
      return withImageFiles(images, async (paths, dir) => {
        const full = `${system}\n\n${prompt}`;
        const promptFile = path.join(dir, 'prompt.txt');
        await fs.writeFile(promptFile, full);
        const cmd = template
          .replaceAll('{prompt_file}', shellQuote(promptFile))
          .replaceAll('{prompt}', shellQuote(full))
          .replaceAll('{images}', paths.map(shellQuote).join(' '))
          .replaceAll('{image}', paths.length ? shellQuote(paths[0]) : "''")
          .replaceAll('{model}', shellQuote(model || ''));
        const viaStdin = !/\{prompt(_file)?\}/.test(template);
        const { stdout } = await run('sh', ['-c', cmd], { input: viaStdin ? full : '', cwd: dir });
        return { text: stripAnsi(stdout) };
      });
    },
  },
};

// Claude stays the default, so an existing install with just a Claude token keeps working
export const providerId = PROVIDERS[env.LARDER_AI] ? env.LARDER_AI : 'claude';
export const provider = PROVIDERS[providerId];
const textModel = () => env.LARDER_TEXT_MODEL || provider.models.text;
const photoModel = () => env.LARDER_PHOTO_MODEL || provider.models.photo || textModel();
// LARDER_AI_IMAGES=false for a model that can't see (most small local text models)
export const canSeePhotos = () => provider.images && env.LARDER_AI_IMAGES !== 'false';

// 'auto' = the lighter model for typing and the stronger one for photos; 'best' / 'fast' = one for everything.
// 'sonnet' and 'haiku' are the names older installs saved.
export function pickModel(mode, hasImages) {
  if (mode === 'best' || mode === 'sonnet') return photoModel();
  if (mode === 'fast' || mode === 'haiku') return textModel();
  return hasImages ? photoModel() : textModel();
}

export function aiInfo() {
  return { id: providerId, label: provider.label, text: textModel() || 'its default model', photo: photoModel() || 'its default model', photos: canSeePhotos(), problem: provider.ready() };
}

// Pulls a JSON object out of a chatty reply: code fences, a sentence before it, ANSI colours...
export function extractJson(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text ?? '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  for (let end = s.lastIndexOf('}'); start >= 0 && end > start; end = s.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* try a shorter span */ }
  }
  return null;
}
