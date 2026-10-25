// Config contract: no schema library, plain standard-schema `~standard` validator.
import assert from 'node:assert/strict';
import { Config } from '../index.js';

assert.equal(Config.type, 'object');
assert.deepEqual(Object.keys(Config.dict).sort(), [
  'cacheTtlMs', 'maxDraftChars', 'model', 'structuredMinChars', 'temperature', 'timeoutMs',
]);
for (const [key, value] of Object.entries(Config.dict)) {
  assert.equal(typeof value.meta.description, 'string', `${key} needs a description`);
  assert.ok(value.meta.description.length > 10, `${key} description is too short`);
  assert.ok(['string', 'number'].includes(value.type), `${key} has an odd type`);
}
assert.equal(Config['~standard'].version, 1);
assert.equal(Config['~standard'].vendor, 'dsh-pa');
assert.equal(typeof Config['~standard'].validate, 'function');

/** Mirrors `cordis`'s resolveConfig: sync only, issues throw, value passes through. */
function resolve(raw) {
  const result = Config['~standard'].validate(raw);
  assert.ok(!('then' in result), 'validation must stay synchronous');
  if (result.issues) throw new Error(result.issues[0].message);
  return result.value;
}

const defaults = resolve(undefined);
assert.deepEqual(defaults, {
  model: '',
  target: null,
  temperature: 0,
  timeoutMs: 120_000,
  maxDraftChars: 24_000,
  structuredMinChars: 800,
  cacheTtlMs: 300_000,
});

const clamped = resolve({ model: '  other/other-model  ', temperature: 5, timeoutMs: 10, structuredMinChars: 0, cacheTtlMs: 0 });
assert.equal(clamped.model, 'other/other-model');
assert.deepEqual(clamped.target, { provider: 'other', model: 'other-model' });
assert.equal(clamped.temperature, 2, 'temperature clamps to 2');
assert.equal(clamped.timeoutMs, 5_000, 'timeoutMs clamps to 5000');
assert.equal(clamped.structuredMinChars, 0, '0 survives (disables the length gate)');
assert.equal(clamped.cacheTtlMs, 0, '0 survives (disables reuse)');

assert.deepEqual(resolve({ temperature: 'nonsense', timeoutMs: -5 }), {
  ...defaults,
  temperature: 0,
  timeoutMs: 5_000,
}, 'a non-numeric value falls back and an out-of-range value clamps, so the row never breaks');

for (const bad of ['nope', 3, [], null]) {
  const result = Config['~standard'].validate(bad);
  assert.ok(result.issues?.length, `${JSON.stringify(bad)} must be rejected`);
  assert.equal(result.issues[0].message, 'config must be an object');
}
assert.equal(Config['~standard'].validate('nope').value, undefined, 'a rejected row yields no value');

assert.deepEqual(resolve(resolve({ temperature: 1 })), resolve({ temperature: 1 }), 'normalizing twice changes nothing');

const serialized = Config.toJSON();
assert.equal(serialized.toJSON, undefined, 'toJSON must not serialize itself');
assert.deepEqual(Object.keys(serialized.dict).length, 6, 'descriptors survive JSON');
JSON.parse(JSON.stringify(Config));
assert.equal(typeof Config.dict.model.meta.description, 'string', 'toJSON leaves the live tree intact');

// Regression: the harness settings page serializes *each volatile child*, not only the
// root (`volatileForm` -> `plainSchema(child)` -> `child.toJSON()`). A field descriptor
// without its own toJSON took down the whole `settings/describe` RPC on 0.4.5.
for (const [key, child] of Object.entries(Config.dict)) {
  assert.equal(typeof child.toJSON, 'function', `${key} must provide toJSON for the settings form`);
  const detached = child.toJSON();
  assert.deepEqual(Object.keys(detached).sort(), ['meta', 'type'], `${key} serializes as plain data`);
  assert.equal(typeof detached.meta.volatile, 'boolean', `${key} keeps volatile metadata`);
  assert.equal(detached.toJSON, undefined, `${key} must not serialize the function itself`);
}
const volatileChildren = Object.values(Config.dict).filter((child) => child.meta.volatile);
assert.equal(volatileChildren.length, 6, 'every field stays live-editable');
const stripped = Object.fromEntries(Object.entries(Config.dict).map(([k, c]) => [k, { type: c.type, meta: { ...c.meta } }]));
assert.throws(
  () => stripped.model.toJSON(),
  /toJSON is not a function/,
  'a descriptor without toJSON reproduces the 0.4.5 crash',
);
const detachedRoot = Config.toJSON();
assert.equal(typeof detachedRoot.dict.model.toJSON, 'undefined', 'toJSON drops functions from the whole tree');

console.log('CONFIG_SMOKE_OK');
