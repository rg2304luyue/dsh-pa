/**
 * dsh-pa — prompt enhancer (host half).
 *
 * The UI half lives in `client.js` and renders a small diamond button inside the
 * composer tool row, immediately left of the model selector
 * (`conversation.input.right`). Clicking it posts the current draft here; this half
 * calls the session's selected model through `ctx.llm` and answers with a rewritten
 * prompt. The UI half keeps the original text so a second click restores it.
 *
 * Transport: one same-origin HTTP endpoint registered on the harness web server, so
 * the plugin needs no generated remote layer and no dynamic-package tooling. POST
 * rewrites a draft, GET reports the settings the UI half enforces locally. The route
 * is loopback-only and guarded by a plugin-scoped header, which keeps it from
 * overlapping any other plugin's route.
 */

/** Endpoint owned by this plugin; no other plugin registers this path. */
const ENDPOINT = '/api/dsh-pa/enhance';
/** Plugin-scoped request header, checked before the body is read. */
const REQUEST_HEADER = 'x-dsh-pa';
const MAX_BODY_BYTES = 512 * 1024;

/** Row defaults; the plugin's `Config` exposes every one of them to `cordis.patch.yml`. */
const DEFAULTS = {
  model: '',
  temperature: 0,
  timeoutMs: 120_000,
  maxDraftChars: 24_000,
  structuredMinChars: 800,
  cacheTtlMs: 5 * 60 * 1000,
};

export const name = 'dsh-pa';
export const inject = ['webServer', 'llm'];

/** One row-config field: a renderable descriptor plus its help text. */
const field = (type, description) => ({ type, meta: { volatile: true, description } });

function configObject(value) {
  if (value === void 0) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config must be an object');
  }
  return value;
}

/**
 * Every tunable value lives here, so users change behaviour in their own patch layer
 * instead of editing the package, and an upgrade keeps their choices.
 *
 * The validator is a hand-written standard-schema (`~standard`) instead of a schema
 * library: `cordis` only needs `validate()` on the row config, and the settings UI only
 * needs the field descriptors. That keeps the plugin free of package dependencies, so it
 * loads in any profile whether or not the harness dependency tree has been pruned.
 */
export const Config = {
  type: 'object',
  meta: {},
  dict: {
    model: field('string', 'Provider or provider/model used for the rewrite, e.g. "deepseek-official/deepseek-flash". Empty follows the session\'s selected model.'),
    temperature: field('number', 'Sampling temperature for the rewrite, 0-2. 0 keeps the output stable.'),
    timeoutMs: field('number', 'Abort one rewrite after this many milliseconds, 5000-600000.'),
    maxDraftChars: field('number', 'Reject drafts longer than this many characters, 200-200000.'),
    structuredMinChars: field('number', 'Drafts at least this long are treated as finished prompts and are not sent, 0-20000. 0 disables only the length check.'),
    cacheTtlMs: field('number', 'Reuse an identical result for this many milliseconds instead of paying again, 0-3600000. 0 disables reuse.'),
  },
  // The harness strips volatile metadata from its validation copy, so hand it a detached
  // tree rather than the live descriptors.
  toJSON() {
    return JSON.parse(JSON.stringify({ ...this, toJSON: void 0 }));
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-pa',
    validate(value) {
      try {
        return { value: normalizeConfig(configObject(value)) };
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
      }
    },
  },
};

const SYSTEM_PROMPT = [
  'You rewrite one composer draft into a ready-to-send prompt for a coding agent. The draft',
  'is the only source of truth.',
  '',
  'Never: answer the request; explain; add a preamble, quotes, or a code fence; change',
  'meaning, scope, terms, numbers, or tone; invent facts, files, APIs, or criteria; rename',
  'identifiers; switch language; add process rules, error handling, tests, or any extra the',
  'draft did not ask for.',
  '',
  'Always:',
  '1. Lead with one sentence naming the goal and the artifact it changes, in the draft\'s own',
  '   words, naming the edited target when the draft revises something already written. Keep',
  '   it first even when the draft is a numbered list.',
  '2. Then add requirements the goal line lacks, mirroring the draft\'s order and numbering',
  '   ("first... second...", 第一/第二), each tracing to the draft or a direct implication. A',
  '   short draft yields a short result, not a padded checklist.',
  '3. Make implied specifics explicit: where the change belongs, how it behaves, what must',
  '   keep working.',
  '4. Close with one output requirement: which files changed and why, or how it was checked.',
  '5. Write every line - the goal sentence, every bullet, the closing line - in the draft\'s',
  '   language. A Chinese draft never gets an English goal line, and an English draft never',
  '   gets Chinese bullets or a Chinese 假设 clause.',
  '',
  'Style: plain markdown. A goal line, a blank line, then "- " bullets - or "1." numbering',
  'instead when the draft itself is numbered - mirroring the draft\'s order. Never combine a',
  'bullet with a 第一/首先 prefix, and never restate the goal as an item. 60-200 words, never',
  'above 250. A question becomes an analysis request ("why is X slow?" -> "list likely causes',
  'and how to verify each"); a statement never becomes a rhetorical question. Re-runs on the',
  'same draft keep wording, structure, and order stable - only the added specifics may vary.',
  'An already precise draft gets the minimum edit; one ambiguity that would change the',
  'implementation (size, position, default state, persistence) gets a single closing',
  '"Assuming"/"假设" clause.',
].join('\n');

export function apply(ctx, rawConfig) {
  // `Config` already validated the row; normalizing again keeps a hand-edited patch
  // layer (or an older row without `config`) on the same, clamped values.
  const config = normalizeConfig(rawConfig);  const webServer = ctx.webServer;
  if (webServer === void 0 || typeof webServer.register !== 'function') {
    console.warn('[dsh-pa] webServer service is unavailable; the prompt enhancer endpoint was not registered.');
    return;
  }
  ctx.effect(() => {
    const dispose = webServer.register({
      kind: 'exact',
      path: ENDPOINT,
      handler: createHandler(ctx, config),
    });
    return typeof dispose === 'function' ? dispose : void 0;
  }, 'dsh-pa: prompt enhancer endpoint');
}

/**
 * Clamp a raw row config into the values the handler uses. Missing or malformed fields
 * fall back to `DEFAULTS` instead of disabling the plugin. Idempotent: `Config` validates
 * with it, and `apply` runs it again so an older row without `config` normalizes the same.
 */
function normalizeConfig(rawConfig) {
  const source = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {};
  const number = (value, fallback, min, max) => {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  };
  const model = typeof source.model === 'string' ? source.model.trim() : '';
  return {
    model,
    target: parseTarget(model),
    temperature: number(source.temperature, DEFAULTS.temperature, 0, 2),
    timeoutMs: number(source.timeoutMs, DEFAULTS.timeoutMs, 5_000, 600_000),
    maxDraftChars: number(source.maxDraftChars, DEFAULTS.maxDraftChars, 200, 200_000),
    structuredMinChars: number(source.structuredMinChars, DEFAULTS.structuredMinChars, 0, 20_000),
    cacheTtlMs: number(source.cacheTtlMs, DEFAULTS.cacheTtlMs, 0, 3_600_000),
  };
}

/** `"provider"` or `"provider/model"`; anything else means "follow the session". */
function parseTarget(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') return null;
  const slash = trimmed.indexOf('/');
  if (slash === -1) return { provider: trimmed, model: '' };
  return { provider: trimmed.slice(0, slash).trim(), model: trimmed.slice(slash + 1).trim() };
}

/** The settings the UI half needs to decide locally, without a rewrite round trip. */
function clientSettings(config) {
  return { structuredMinChars: config.structuredMinChars, cacheTtlMs: config.cacheTtlMs };
}

/* -------------------------------------------------------------------------------------------- */
/* Request handling                                                                              */
/* -------------------------------------------------------------------------------------------- */

function createHandler(ctx, config) {
  return async (request, response) => {
    try {
      const method = request.method;
      if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
        response.writeHead(405, { allow: 'GET, HEAD, POST', 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (!isTrustedRequest(request)) {
        json(response, 403, failure('FORBIDDEN', 'Only same-origin requests from this machine may enhance a prompt.'));
        return;
      }
      // GET/HEAD publish the settings the UI half applies locally; only POST generates.
      if (method !== 'POST') {
        if (method === 'HEAD') {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          response.end();
          return;
        }
        json(response, 200, { ok: true, config: clientSettings(config) });
        return;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        json(response, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, failure('BAD_REQUEST', messageOf(error)));
        return;
      }
      const draft = typeof body?.draft === 'string' ? body.draft : '';
      if (draft.trim() === '') {
        json(response, 400, failure('EMPTY_DRAFT', 'The draft is empty.'));
        return;
      }
      if (draft.length > config.maxDraftChars) {
        json(response, 413, failure('DRAFT_TOO_LARGE', `The draft is longer than ${config.maxDraftChars} characters.`));
        return;
      }
      const target = await resolveTarget(ctx.llm, body?.provider, body?.model, config.target);
      if (target === null) {
        json(response, 503, failure('NO_MODEL', 'No language model is available to enhance the draft.'));
        return;
      }
      let text;
      try {
        text = await enhance(ctx.llm, target, draft, config);
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'LLM_ERROR';
        json(response, code === 'ABORTED' ? 504 : 502, failure(code, messageOf(error)));
        return;
      }
      json(response, 200, { ok: true, text, provider: target.provider, model: target.model });
    } catch (error) {
      if (!response.writableEnded) json(response, 500, failure('INTERNAL', messageOf(error)));
    }
  };
}

function failure(code, message) {
  return { ok: false, error: { code, message } };
}

function json(response, statusCode, value) {
  if (response.writableEnded) return;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function messageOf(error) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (message === '') return 'The prompt enhancer failed.';
  return redactPath(message).slice(0, 400);
}

/** Keep absolute local paths out of browser-visible error text. */
function redactPath(message) {
  return message.replace(/[A-Za-z]:[\\/][^\s"']*|\/(?:home|root|Users|var|tmp)\/[^\s"']*/g, '<path>');
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(Object.assign(new Error('The request body is too large.'), { code: 'BODY_TOO_LARGE' }));
        if (typeof request.destroy === 'function') request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', fail);
    request.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(Object.assign(new Error('The request body is not valid JSON.'), { code: 'BAD_JSON' }));
      }
    });
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Same-origin guard                                                                             */
/* -------------------------------------------------------------------------------------------- */

function header(request, name) {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackAddress(value) {
  const address = typeof value === 'string' ? value.toLowerCase().replace(/^\[|\]$/g, '') : '';
  return (
    address === 'localhost' ||
    address === 'localhost.' ||
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  );
}

function isTrustedRequest(request) {
  if (header(request, REQUEST_HEADER) !== '1') return false;
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const site = header(request, 'sec-fetch-site');
  if (site !== void 0 && site !== 'same-origin') return false;
  const host = header(request, 'host');
  if (host === void 0 || host === '') return false;
  const origin = header(request, 'origin');
  if (origin === void 0 || origin === '') {
    try {
      return isLoopbackAddress(new URL(`http://${host}`).hostname);
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      isLoopbackAddress(url.hostname) &&
      url.host === host
    );
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Model resolution + generation                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * Resolve the model to enhance with. An explicit `model` from the row config wins, then the
 * session selection the UI sent; when neither names a pair we fall back to the first
 * configured provider/model so the button still works on a fresh session.
 *
 * @param {{ provider: string, model: string } | null} preferred row-config override
 * @returns {Promise<{ provider: string, model: string } | null>}
 */
async function resolveTarget(llm, provider, model, preferred) {
  if (llm === void 0 || typeof llm.stream !== 'function') return null;
  const wantedProvider = isIdentifier(preferred?.provider)
    ? preferred.provider
    : isIdentifier(provider)
      ? provider
      : void 0;
  const wantedModel = isIdentifier(preferred?.model)
    ? preferred.model
    : isIdentifier(model)
      ? model
      : void 0;
  if (wantedProvider !== void 0 && wantedModel !== void 0) return { provider: wantedProvider, model: wantedModel };
  const ids = [];
  try {
    const providers = await llm.listProviders();
    for (const entry of Array.isArray(providers) ? providers : []) {
      if (isIdentifier(entry?.id) && !ids.includes(entry.id)) ids.push(entry.id);
    }
  } catch {
    return null;
  }
  const ordered =
    wantedProvider !== void 0 ? [wantedProvider, ...ids.filter((id) => id !== wantedProvider)] : ids;
  for (const candidate of ordered) {
    let models;
    try {
      models = await llm.listModels(candidate);
    } catch {
      continue;
    }
    const list = Array.isArray(models) ? models.filter((entry) => isIdentifier(entry?.id)) : [];
    if (list.length === 0) continue;
    const wanted = wantedModel !== void 0 ? list.find((entry) => entry.id === wantedModel) : void 0;
    return { provider: candidate, model: wanted === void 0 ? list[0].id : wanted.id };
  }
  return null;
}

function isIdentifier(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Stream one rewrite. Accumulates text deltas and reports the terminal failure of the
 * stream, so the caller can answer with a precise error instead of an empty string.
 *
 * @returns {Promise<string>}
 */
async function enhance(llm, target, draft, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let text = '';
  let terminal = null;
  try {
    const stream = llm.stream({
      provider: target.provider,
      model: target.model,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: `Draft to rewrite:\n<draft>\n${draft}\n</draft>` }],
        },
      ],
      temperature: config.temperature,
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text;
      } else if (chunk?.type === 'finish') {
        const reason = chunk.reason;
        if (reason !== void 0 && reason?.kind !== 'stop') terminal = reason;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw withCode('ABORTED', 'The enhancement timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (terminal !== null) {
    const code = typeof terminal.failure?.code === 'string' ? terminal.failure.code : String(terminal.kind ?? 'LLM_ERROR');
    const message = typeof terminal.failure?.message === 'string' && terminal.failure.message !== ''
      ? terminal.failure.message
      : 'The model call did not complete.';
    throw withCode(code, message);
  }
  const enhanced = unwrap(text.trim());
  if (enhanced === '') throw withCode('EMPTY_RESULT', 'The model returned no text.');
  return enhanced;
}

function withCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Strip a wrapping code fence, a fully-quoted answer, or a leading label line. */
function unwrap(text) {
  const fenced = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/u.exec(text);
  let body = fenced !== null ? fenced[1].trim() : text;
  const newline = body.indexOf('\n');
  const firstLine = (newline === -1 ? body : body.slice(0, newline)).trim();
  if (
    newline !== -1
    && firstLine.length <= 40
    && /[:：]$/u.test(firstLine)
    && /提示词|prompt/iu.test(firstLine)
  ) {
    body = body.slice(newline + 1).trim();
  }
  if (body.length > 1 && body.startsWith('"') && body.endsWith('"')) body = body.slice(1, -1).trim();
  return body;
}
