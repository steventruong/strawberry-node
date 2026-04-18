# strawberry-sdk (Node.js)

Node.js SDK for Strawberry analytics, error tracking, logs, and LLM call observability. Stdlib-only (no dependencies), Node 18+.

Features:

- Per-channel bounded buffers (events, errors, logs, identify, llm) with drop-oldest on overflow
- Per-endpoint circuit breaker (CLOSED / OPEN / HALF_OPEN)
- Jittered decorrelated backoff for retries
- Always-on PII redaction (email, phone, Luhn-valid cards, JWTs, API keys, field-name denylist)
- Injectable transport and clock for tests, plus `dryRun`
- Graceful shutdown with timeout and a `process.on('exit')` hook
- Diagnostics accessor for queue depth, drops, retries, failures, circuit states, redactions

## Install

```bash
npm install github:steventruong/strawberry-node#v1.0.0
```

Requires Node 18+.

## Quick start

```js
const strawberry = require('strawberry-sdk');

strawberry.init('berry_xxxxxxxx', {
  host: 'https://straw.berryagents.com',
  releaseVersion: 'v1.2.3',
  environment: 'production',
});

strawberry.capture('user_signed_up', { plan: 'pro' }, 'user_123');
strawberry.identify('user_123', { email: 'a@b.com', plan: 'pro' });
strawberry.log('info', 'sync finished', 'worker', { items: 42 });
strawberry.llmCall({
  provider: 'openai',
  model: 'gpt-4o',
  promptTokens: 120,
  completionTokens: 48,
  latencyMs: 812,
  costUsd: 0.003,
});

try { risky(); } catch (e) { strawberry.captureError(e, { op: 'risky' }); }

process.on('beforeExit', async () => { await strawberry.shutdown(); });
```

## Express middleware

```js
const app = require('express')();
app.use(strawberry.middleware());
```

Emits `$http_request` on every finished response and `$http_error` on 5xx or caught errors.

## Public API

| Function | Notes |
| --- | --- |
| `init(apiKey, opts?)` | `{ host, releaseVersion, environment, batchSize, flushInterval, transport, clock, redactor, dryRun }` |
| `capture(event, props?, distinctId?)` | Non-blocking. |
| `identify(distinctId, props?)` | Non-blocking. |
| `captureError(err, context?)` | Accepts `Error` or string. |
| `log(level, message, category?, attrs?)` | Level is one of `error`, `warn`, `info`, `debug`. |
| `llmCall({ provider, model, promptTokens?, completionTokens?, latencyMs?, costUsd?, status?, streaming?, distinctId?, errorMessage? })` | |
| `flush()` | Returns `Promise<void>`. |
| `shutdown()` | Returns `Promise<void>`. |
| `isEnabled()` | |
| `diagnostics()` | Snapshot of queue depth, drops, retries, failures, circuit states, redactions. |
| `middleware()` | Express / Connect compatible. |

## Wire protocol

- `POST /api/v1/ingest` — batched events + identify + LLM calls
- `POST /api/v1/errors/ingest` — one error per request
- `POST /api/v1/logs` — one structured log per request
- Auth via `Authorization: Bearer <apiKey>` plus `api_key` body fallback

## Design notes

- Buffers never grow unbounded. Overflow drops the oldest entry and increments a `dropped` counter visible in `diagnostics()`.
- The circuit breaker is per-endpoint — a flaky errors endpoint doesn't starve analytics.
- Retries use decorrelated jittered backoff to avoid synchronized stampedes under contention.
- The PII redactor runs on every value before it enters a buffer, so persisted queues never contain unredacted data.
- `dryRun: true` short-circuits all HTTP, useful for local development and tests.
