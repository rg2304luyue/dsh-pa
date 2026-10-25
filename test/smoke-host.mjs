/**
 * Offline smoke test for the host half of dsh-pa.
 *
 * Fakes the web server, the request/response pair and the LLM runtime, then drives the
 * registered endpoint through its success and error paths. 
 * 
 */
import assert from 'node:assert';
import { EventEmitter } from 'node:events';

const plugin = await import('../index.js');

assert.strictEqual(plugin.name, 'dsh-pa');
assert.deepStrictEqual(plugin.inject, ['webServer', 'llm']);

let route = null;
let captured = null;
const ctx = {
  effect(factory) {
    return factory();
  },
  webServer: {
    register(options) {
      route = options;
      return () => {
        route = null;
      };
    },
  },
  llm: {
    async listProviders() {
      return [{ id: 'deepseek' }];
    },
    async listModels(provider) {
      return provider === 'deepseek' ? [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] : [];
    },
    stream(options) {
      captured = options;
      return (async function* generate() {
        yield { type: 'text-delta', index: 0, text: '## 目标\n' };
        yield { type: 'text-delta', index: 0, text: '实现 dsh-pa 插件。' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  },
};

plugin.apply(ctx, {});
assert.ok(route !== null, 'the endpoint must register');
assert.strictEqual(route.kind, 'exact');
assert.strictEqual(route.path, '/api/dsh-pa/enhance');

function makeRequest(method, { headers = {}, body = void 0, remoteAddress = '127.0.0.1' } = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.headers = headers;
  request.socket = { remoteAddress };
  request.destroy = () => {};
  setImmediate(() => {
    if (body !== void 0) request.emit('data', Buffer.from(body, 'utf8'));
    request.emit('end');
  });
  return request;
}

function makeResponse() {
  const response = {
    statusCode: void 0,
    headers: void 0,
    payload: '',
    writableEnded: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk) {
      if (typeof chunk === 'string') this.payload += chunk;
      this.writableEnded = true;
    },
  };
  return response;
}

const trusted = {
  host: '127.0.0.1:4637',
  origin: 'http://127.0.0.1:4637',
  'sec-fetch-site': 'same-origin',
  'x-dsh-pa': '1',
  'content-type': 'application/json',
};

async function call(method, options) {
  const request = makeRequest(method, options);
  const response = makeResponse();
  await route.handler(request, response);
  return {
    status: response.statusCode,
    headers: response.headers,
    body: response.payload === '' ? null : JSON.parse(response.payload),
  };
}

// Unsupported verb (GET/HEAD are the config reader, POST generates).
const notAllowed = await call('PUT', { headers: trusted });
assert.strictEqual(notAllowed.status, 405);
assert.strictEqual(notAllowed.headers.allow, 'GET, HEAD, POST');

// The config reader answers with the two settings the UI half applies locally.
const settings = await call('GET', { headers: trusted });
assert.strictEqual(settings.status, 200);
assert.strictEqual(settings.body.ok, true);
assert.deepStrictEqual(settings.body.config, { structuredMinChars: 800, cacheTtlMs: 300000 });
assert.strictEqual((await call('GET', { headers: { ...trusted, 'x-dsh-pa': '0' } })).status, 403);

// Row config reaches the handler: clamped numbers, model override, and both settings.
plugin.apply(ctx, {
  model: 'other/other-model',
  temperature: 5,
  timeoutMs: 10,
  structuredMinChars: 0,
  cacheTtlMs: 0,
});
const clamped = await call('GET', { headers: trusted });
assert.deepStrictEqual(clamped.body.config, { structuredMinChars: 0, cacheTtlMs: 0 });
const overridden = await call('POST', { headers: trusted, body: JSON.stringify({ draft: 'hello' }) });
assert.strictEqual(overridden.body.provider, 'other');
assert.strictEqual(overridden.body.model, 'other-model');
assert.strictEqual(captured.temperature, 2, 'temperature must be clamped to the documented range');

// A hand-edited row below the documented floor falls back to the defaults instead of
// rejecting drafts or timing out instantly.
plugin.apply(ctx, { maxDraftChars: 'nonsense', timeoutMs: -5 });
const restored = await call('GET', { headers: trusted });
assert.strictEqual(restored.body.config.structuredMinChars, 800);
assert.strictEqual(restored.body.config.cacheTtlMs, 300000);

// Missing plugin header.
const forbidden = await call('POST', { headers: { ...trusted, 'x-dsh-pa': '0' }, body: '{"draft":"x"}' });
assert.strictEqual(forbidden.status, 403);
assert.strictEqual(forbidden.body.ok, false);

// Non-loopback peer.
const remote = await call('POST', {
  headers: trusted,
  body: '{"draft":"x"}',
  remoteAddress: '10.0.0.9',
});
assert.strictEqual(remote.status, 403);

// Cross-origin page.
const crossOrigin = await call('POST', {
  headers: { ...trusted, origin: 'http://evil.example' },
  body: '{"draft":"x"}',
});
assert.strictEqual(crossOrigin.status, 403);

// Empty draft.
const empty = await call('POST', { headers: trusted, body: '{"draft":"   "}' });
assert.strictEqual(empty.status, 400);
assert.strictEqual(empty.body.error.code, 'EMPTY_DRAFT');

// Invalid JSON.
const badJson = await call('POST', { headers: trusted, body: '{oops' });
assert.strictEqual(badJson.status, 400);

// Success path with the session's selected model.
const ok = await call('POST', {
  headers: trusted,
  body: JSON.stringify({ draft: '帮我写个插件呗，就是输入框左边加个闪电，点了就增强提示词', provider: 'deepseek', model: 'deepseek-chat' }),
});
assert.strictEqual(ok.status, 200);
assert.strictEqual(ok.body.ok, true);
assert.strictEqual(ok.body.text, '## 目标\n实现 dsh-pa 插件。');
assert.strictEqual(ok.body.provider, 'deepseek');
assert.strictEqual(ok.body.model, 'deepseek-chat');

// Fallback resolution when the UI sends no selection.
const fallback = await call('POST', { headers: trusted, body: JSON.stringify({ draft: 'hello' }) });
assert.strictEqual(fallback.status, 200);
assert.strictEqual(fallback.body.model, 'deepseek-chat');

// Provider failure surfaces as 502 with the model failure code.
const failingCtx = {
  effect: (factory) => factory(),
  webServer: { register: (options) => ((route = options), () => {}) },
  llm: {
    async listProviders() {
      return [{ id: 'deepseek' }];
    },
    async listModels() {
      return [{ id: 'deepseek-chat' }];
    },
    stream() {
      return (async function* generate() {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad credential' } } };
      })();
    },
  },
};
plugin.apply(failingCtx);
const failed = await call('POST', { headers: trusted, body: JSON.stringify({ draft: 'hello' }) });
assert.strictEqual(failed.status, 502);
assert.strictEqual(failed.body.error.code, 'AUTH');
assert.strictEqual(failed.body.error.message, 'bad credential');

// No provider at all.
const noModelCtx = {
  effect: (factory) => factory(),
  webServer: { register: (options) => ((route = options), () => {}) },
  llm: {
    async listProviders() {
      return [];
    },
    async listModels() {
      return [];
    },
    stream() {
      throw new Error('must not be called');
    },
  },
};
plugin.apply(noModelCtx);
const noModel = await call('POST', { headers: trusted, body: JSON.stringify({ draft: 'hello' }) });
assert.strictEqual(noModel.status, 503);
assert.strictEqual(noModel.body.error.code, 'NO_MODEL');

// Local absolute paths never leak into a browser-visible message.
const leakCtx = {
  effect: (factory) => factory(),
  webServer: { register: (options) => ((route = options), () => {}) },
  llm: {
    async listProviders() {
      return [{ id: 'deepseek' }];
    },
    async listModels() {
      return [{ id: 'deepseek-chat' }];
    },
    stream() {
      throw new Error('config missing at C:\\Users\\someone\\.dsh\\auth.json');
    },
  },
};
plugin.apply(leakCtx);
const leaked = await call('POST', { headers: trusted, body: JSON.stringify({ draft: 'hello' }) });
assert.strictEqual(leaked.status, 502);
assert.ok(!leaked.body.error.message.includes('Users'), 'absolute paths must be redacted');

console.log('HOST_SMOKE_OK');
