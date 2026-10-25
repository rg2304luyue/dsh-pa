/**
 * Offline smoke test for the client half of dsh-pa.
 *
 * It fakes the module loader, React, the slot registry and the locale service, then renders
 * the registered composer button as a plain function so reference errors and bad hook usage
 * surface without a running harness. Run it with `node test/smoke-client.cjs`.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

const effectFns = [];
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect(fn) {
    effectFns.push(fn);
  },
  useRef(value) {
    return { current: value };
  },
};

let plugin = null;
global.window = {
  __ModuleLoader__: {
    load(options) {
      assert.strictEqual(options.id, 'dsh-pa', 'module id must be the package name');
      plugin = options.factory((name) => {
        if (name === 'react') return fakeReact;
        throw new Error(`unexpected require: ${name}`);
      });
    },
  },
};

const styleElement = { dataset: {}, remove() {} };
global.document = {
  createElement() {
    return styleElement;
  },
  head: { appendChild() {} },
};

require(path.join(root, 'client.js'));

assert.ok(plugin !== null, 'the bundle must register a factory');
assert.deepStrictEqual(plugin.inject, ['slots', 'locale'], 'inject list must stay minimal');
assert.strictEqual(typeof plugin.apply, 'function', 'the plugin must expose apply()');

let registered = null;
const disposers = [];
let effectCount = 0;
const ctx = {
  effect(factory) {
    effectCount += 1;
    const dispose = factory();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  },
  locale: {
    register() {},
    bind() {
      return (key) => `T:${key}`;
    },
    getSnapshot: () => ({ active: 'zh' }),
  },
  slots: {
    inject(name, callback) {
      assert.strictEqual(name, 'conversation.input.right');
      callback();
    },
    register(options, component) {
      registered = { options, component };
    },
  },
};

plugin.apply(ctx);

assert.ok(registered !== null, 'the button must register into conversation.input.right');
assert.strictEqual(registered.options.id, 'dsh-pa/enhance');
assert.strictEqual(registered.options.name, 'conversation.input.right');
assert.strictEqual(typeof registered.options.order, 'number');
assert.strictEqual(registered.options.locale, 'dsh-pa', 'the registration keeps its own locale namespace');
assert.strictEqual(effectCount, 2, 'styles and dictionaries must both be effects');

// Idle, empty draft: disabled.
const emptyProps = {
  sessionId: 's1',
  inputActions: { setDraft() {} },
  useInput: (select) => select({ draft: '', phase: 'idle' }),
  useProjection: () => ({ next: { provider: 'deepseek', model: 'deepseek-chat' } }),
  t: (key) => key,
};
const idle = registered.component(emptyProps);
assert.strictEqual(idle.type, 'button');
assert.strictEqual(idle.props.disabled, true, 'an empty draft disables the button');
assert.strictEqual(idle.props['data-dsh-pa-state'], 'idle');

// Draft present: enabled.
const ready = registered.component({
  ...emptyProps,
  useInput: (select) => select({ draft: '帮我写个插件', phase: 'idle' }),
});
assert.strictEqual(ready.props.disabled, false, 'a draft enables the button');
assert.strictEqual(ready.props['aria-label'], 'button.enhance');
assert.strictEqual(ready.props['aria-pressed'], 'false');

// Submitting phase blocks a fresh enhancement.
const blocked = registered.component({
  ...emptyProps,
  useInput: (select) => select({ draft: '帮我写个插件', phase: 'submitting' }),
});
assert.strictEqual(blocked.props.disabled, true, 'a submitting draft must not be rewritten');

// Missing inputActions: visible but inert, never hidden silently.
const inert = registered.component({ ...emptyProps, inputActions: void 0 });
assert.strictEqual(inert.props.disabled, true);
assert.strictEqual(inert.props['aria-label'], 'button.unsupported');

// No session id: render nothing rather than writing into the wrong composer.
const detached = registered.component({ ...emptyProps, sessionId: void 0 });
assert.strictEqual(detached, null);

// Restore state: the stored enhanced text equals the current draft.
const store = registered.component({
  ...emptyProps,
  useInput: (select) => select({ draft: '帮我写个插件', phase: 'idle' }),
});
assert.strictEqual(store.props['data-dsh-pa-state'], 'idle');

// A draft that already reads like a finished prompt is not sent at all.
const structuredDraft = [
  '基于我原有的提示词完成以下两处修改：',
  '1. 把按钮文案改成「导出」',
  '2. 点击后导出设置页配置',
  '输出要求：说明改了哪些文件。',
].join('\n');
const structured = registered.component({
  ...emptyProps,
  useInput: (select) => select({ draft: structuredDraft, phase: 'idle' }),
});
assert.strictEqual(structured.props.disabled, true, 'a structured prompt must not be rewritten');
assert.strictEqual(structured.props['aria-label'], 'button.structured');
assert.strictEqual(structured.props['data-dsh-pa-state'], 'disabled');

// Long plain prose crosses the default length gate as well.
const longDraft = '把首页改成深色模式，注意别影响其它页面。'.repeat(40);
const longGate = registered.component({
  ...emptyProps,
  useInput: (select) => select({ draft: longDraft, phase: 'idle' }),
});
assert.strictEqual(longGate.props.disabled, true, 'a very long draft is treated as a finished prompt');

// The row config is read once per mount from the same endpoint, with the plugin header.
const configCalls = [];
global.fetch = async (url, init) => {
  configCalls.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ ok: true, config: { structuredMinChars: 0, cacheTtlMs: 0 } }) };
};
const configEffect = effectFns.find((fn) => String(fn).includes('GET'));
assert.ok(typeof configEffect === 'function', 'the component must read the row config on mount');
const cleanup = configEffect();
assert.strictEqual(configCalls.length, 1, 'the effect must call fetch synchronously');
assert.strictEqual(configCalls[0].url, 'api/dsh-pa/enhance', 'the request must be document-relative');
assert.strictEqual(configCalls[0].init.method, 'GET');
assert.strictEqual(configCalls[0].init.headers['x-dsh-pa'], '1');
assert.strictEqual(configCalls[0].init.credentials, 'same-origin');
assert.strictEqual(typeof cleanup, 'function', 'the config effect must dispose its listener');

// A list without any output expectation is still a raw note: keep it enhancable.
const bulletNote = registered.component({
  ...emptyProps,
  useInput: (select) => select({ draft: '1. 换个颜色\n2. 字体大一点点 看着舒服', phase: 'idle' }),
});
assert.strictEqual(bulletNote.props.disabled, false, 'a plain list stays enhancable');

// The same draft is only paid for once: the second press reuses the cached rewrite.
const calls = { fetch: 0, drafts: [] };
global.fetch = async () => {
  calls.fetch += 1;
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, text: 'Rewrite the plugin loader.' }),
  };
};
const cachedProps = {
  ...emptyProps,
  inputActions: {
    setDraft(text) {
      calls.drafts.push(text);
    },
  },
  useInput: (select) => select({ draft: '帮我改一下插件加载器', phase: 'idle' }),
};
const cachedButton = registered.component(cachedProps);
const event = { preventDefault() {} };
(async () => {
  await cachedButton.props.onClick(event);
  assert.strictEqual(calls.fetch, 1, 'the first press calls the endpoint');
  assert.deepStrictEqual(calls.drafts, ['Rewrite the plugin loader.'], 'the rewrite lands in the draft');
  await cachedButton.props.onClick(event);
  assert.strictEqual(calls.fetch, 1, 'the second press is served from the cache');
  assert.deepStrictEqual(calls.drafts, ['Rewrite the plugin loader.', 'Rewrite the plugin loader.']);
  console.log('CLIENT_SMOKE_OK');
})();
