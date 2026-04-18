'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Client,
  init,
  capture,
  identify,
  captureError,
  log,
  llmCall,
  flush,
  shutdown,
  isEnabled,
  diagnostics,
  middleware,
} = require('../src/index');
const { BoundedBuffer } = require('../src/buffers');
const { DecorrelatedBackoff } = require('../src/backoff');
const { createRedactor, luhnValid } = require('../src/redact');
const { CircuitBreaker } = require('../src/transport');
const { CIRCUIT } = require('../src/types');

// Helper: capturing transport that records every request.
function recordingTransport() {
  const calls = [];
  const handler = async (url, opts) => {
    calls.push({ url, opts });
    return { status: 200, body: '{"ok":true}' };
  };
  handler.calls = calls;
  return handler;
}

function failingTransport(status, nTimes) {
  let n = 0;
  return async () => {
    if (n < nTimes) {
      n++;
      return { status, body: 'err' };
    }
    return { status: 200, body: 'ok' };
  };
}

test('BoundedBuffer drops oldest on overflow', () => {
  const b = new BoundedBuffer('events', 3);
  b.push('a');
  b.push('b');
  b.push('c');
  b.push('d');
  assert.equal(b.size, 3);
  assert.equal(b.dropped, 1);
  const drained = b.drain(10);
  assert.deepEqual(drained, ['b', 'c', 'd']);
});

test('BoundedBuffer requeueFront preserves order', () => {
  const b = new BoundedBuffer('x', 5);
  b.push(1);
  b.push(2);
  b.push(3);
  const taken = b.drain(2);
  assert.deepEqual(taken, [1, 2]);
  b.requeueFront(taken);
  assert.deepEqual(b.drain(10), [1, 2, 3]);
});

test('DecorrelatedBackoff stays within bounds', () => {
  const b = new DecorrelatedBackoff(100, 5000, () => 0.5);
  for (let i = 0; i < 50; i++) {
    const d = b.next();
    assert.ok(d >= 100 && d <= 5000, 'delay ' + d + ' out of bounds');
  }
});

test('Redactor scrubs emails, JWTs, API keys, Luhn cards, phones', () => {
  assert.equal(luhnValid('4242424242424242'), true);
  assert.equal(luhnValid('1234567890123456'), false);
  const r = createRedactor();
  const out = r.redact({
    email: 'user@example.com',
    description: 'call me at 415-555-0199',
    api_key: ['sk', 'live', 'abcdefghijklmnop1234567890'].join('_'),
    token: 'eyJabc.eyJdef.ghijkl',
    password: 'hunter2',
    card: '4242 4242 4242 4242',
    nested: { note: 'visit me at foo@bar.io' },
  });
  assert.equal(out.email, '[REDACTED]');
  assert.equal(out.api_key, '[REDACTED]');
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.password, '[REDACTED]');
  assert.ok(!/4242/.test(String(out.card)));
  assert.ok(!/@/.test(String(out.nested.note)));
  const stats = r.stats();
  assert.ok(stats.emails >= 1);
  assert.ok(stats.fields >= 1);
});

test('CircuitBreaker trips after threshold and recovers via HALF_OPEN', () => {
  let now = 1000;
  const clock = { now: () => now };
  const cb = new CircuitBreaker({ threshold: 3, openMs: 1000, clock });
  assert.equal(cb.state(), CIRCUIT.CLOSED);
  for (let i = 0; i < 3; i++) {
    assert.equal(cb.canPass(), true);
    cb.recordFailure();
  }
  assert.equal(cb.state(), CIRCUIT.OPEN);
  assert.equal(cb.canPass(), false);
  now += 2000;
  assert.equal(cb.canPass(), true); // HALF_OPEN probe
  assert.equal(cb.state(), CIRCUIT.HALF_OPEN);
  cb.recordSuccess();
  assert.equal(cb.state(), CIRCUIT.CLOSED);
});

test('Client with dryRun records no HTTP calls but still buffers', async () => {
  const t = recordingTransport();
  const c = new Client('sbk_live_test', { transport: t, dryRun: true, flushInterval: 99999 });
  c.capture('signed_up', { plan: 'pro' }, 'user_1');
  c.identify('user_1', { email: 'hi@example.com' });
  c.log('info', 'hello');
  c.llmCall({ provider: 'openai', model: 'gpt-4o', promptTokens: 10 });
  c.captureError(new Error('boom'), { op: 'test' });
  await c.flush();
  assert.equal(t.calls.length, 0);
  const diag = c.diagnostics();
  assert.equal(diag.dry_run, true);
  assert.ok(diag.transport.dryRunCalls >= 1);
  await c.shutdown();
});

test('Client flushes events through injected transport', async () => {
  const t = recordingTransport();
  const c = new Client('sbk_live_test', { transport: t, flushInterval: 99999 });
  c.capture('evt_1', { a: 1 }, 'u1');
  c.capture('evt_2', { email: 'bob@x.com' }, 'u2');
  await c.flush();
  assert.ok(t.calls.length >= 1);
  const first = t.calls[0];
  assert.equal(first.opts.method, 'POST');
  assert.match(first.url, /\/api\/v1\/ingest$/);
  const body = JSON.parse(first.opts.body);
  assert.equal(body.api_key, 'sbk_live_test');
  assert.ok(Array.isArray(body.events));
  assert.ok(body.events.length >= 2);
  // PII redaction survived to the wire.
  const serialized = JSON.stringify(body);
  assert.ok(!/bob@x\.com/.test(serialized));
  // Auth header present.
  assert.equal(first.opts.headers.authorization, 'Bearer sbk_live_test');
  await c.shutdown();
});

test('Client routes errors and logs to dedicated endpoints', async () => {
  const t = recordingTransport();
  const c = new Client('sbk_live_test', { transport: t, flushInterval: 99999 });
  c.captureError(new Error('kaboom'), { foo: 1 });
  c.log('warn', 'careful', 'svc', { n: 1 });
  await c.flush();
  const urls = t.calls.map((x) => x.url);
  assert.ok(urls.some((u) => /\/api\/v1\/errors\/ingest$/.test(u)));
  assert.ok(urls.some((u) => /\/api\/v1\/logs$/.test(u)));
  await c.shutdown();
});

test('Client retries on 5xx and eventually succeeds', async () => {
  const t = failingTransport(503, 2);
  let calls = 0;
  const wrapped = async (url, opts) => {
    calls++;
    return t(url, opts);
  };
  const c = new Client('k', {
    transport: wrapped,
    flushInterval: 99999,
    clock: { now: () => Date.now(), setTimeout: (fn) => setTimeout(fn, 0) },
  });
  c.capture('evt');
  await c.flush();
  assert.ok(calls >= 3, 'expected at least 3 attempts, got ' + calls);
  await c.shutdown();
});

test('Client is non-blocking when uninitialized (module-level)', () => {
  // The functional API should silently no-op when nothing is initialized.
  capture('never_sent', { a: 1 });
  identify('x');
  log('info', 'hi');
  llmCall({ provider: 'x', model: 'y' });
  captureError(new Error('noop'));
  assert.equal(isEnabled(), false);
  const diag = diagnostics();
  assert.equal(diag.enabled, false);
  const mw = middleware();
  let called = false;
  mw({}, { on: () => {} }, () => {
    called = true;
  });
  assert.equal(called, true);
});

test('Module-level init wires a singleton', async () => {
  const t = recordingTransport();
  init('sbk_live_fn', { transport: t, flushInterval: 99999 });
  assert.equal(isEnabled(), true);
  capture('hi', { n: 1 });
  await flush();
  assert.ok(t.calls.length >= 1);
  await shutdown();
  assert.equal(isEnabled(), false);
});

test('Middleware emits $http_request on finish', async () => {
  const t = recordingTransport();
  const c = new Client('k', { transport: t, flushInterval: 99999 });
  const mw = c.middleware();
  const listeners = {};
  const res = {
    statusCode: 200,
    on: (evt, fn) => {
      listeners[evt] = fn;
    },
  };
  const req = { method: 'GET', url: '/test?foo=1', headers: { 'user-agent': 'x' } };
  mw(req, res, () => {});
  listeners.finish();
  await c.flush();
  const body = JSON.parse(t.calls[0].opts.body);
  const evt = body.events[0];
  assert.equal(evt.event_type, '$http_request');
  assert.equal(evt.properties.$path, '/test');
  assert.equal(evt.properties.$method, 'GET');
  await c.shutdown();
});

test('Diagnostics reports buffers, transport, and redactions', async () => {
  const t = recordingTransport();
  const c = new Client('k', { transport: t, flushInterval: 99999 });
  c.capture('e1', { email: 'a@b.com' });
  const diag = c.diagnostics();
  assert.ok(diag.buffers.events);
  assert.ok(typeof diag.transport.retries === 'number');
  assert.ok(typeof diag.redactions.emails === 'number');
  await c.shutdown();
});

test('Shutdown is idempotent and stops further work', async () => {
  const t = recordingTransport();
  const c = new Client('k', { transport: t, flushInterval: 99999 });
  c.capture('a');
  await c.shutdown();
  // Further calls no-op cleanly.
  c.capture('b');
  await c.flush();
  await c.shutdown();
  assert.equal(c.isEnabled(), false);
});
