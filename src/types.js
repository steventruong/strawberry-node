'use strict';

// Channel names used for per-channel buffers.
const CHANNEL = Object.freeze({
  EVENTS: 'events',
  IDENTIFY: 'identify',
  ERRORS: 'errors',
  LOGS: 'logs',
  LLM: 'llm',
});

// Circuit breaker states.
const CIRCUIT = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
});

// Endpoint paths on the Strawberry ingest API.
const ENDPOINT = Object.freeze({
  INGEST: '/api/v1/ingest',
  ERRORS: '/api/v1/errors/ingest',
  LOGS: '/api/v1/logs',
});

// Default client configuration.
const DEFAULTS = Object.freeze({
  HOST: 'https://app.gotstrawberry.com',
  BATCH_SIZE: 100,
  FLUSH_INTERVAL_MS: 5000,
  // Per-channel buffer capacity before drop-oldest kicks in.
  CHANNEL_CAPACITY: {
    events: 10000,
    identify: 1000,
    errors: 2000,
    logs: 5000,
    llm: 2000,
  },
  // Request timeout in ms.
  REQUEST_TIMEOUT_MS: 10000,
  // Circuit breaker config.
  CIRCUIT_FAIL_THRESHOLD: 5,
  CIRCUIT_OPEN_MS: 30000,
  // Retry policy.
  MAX_RETRIES: 3,
  BACKOFF_BASE_MS: 250,
  BACKOFF_CAP_MS: 10000,
  // Shutdown grace in ms.
  SHUTDOWN_TIMEOUT_MS: 5000,
  // Valid log levels accepted by the backend.
  VALID_LOG_LEVELS: ['error', 'warn', 'info', 'debug'],
});

module.exports = { CHANNEL, CIRCUIT, ENDPOINT, DEFAULTS };
