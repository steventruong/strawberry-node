'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { CIRCUIT, DEFAULTS } = require('./types');
const { DecorrelatedBackoff, sleep } = require('./backoff');

// Per-endpoint circuit breaker. Trips after N consecutive failures, stays open
// for a cooldown window, then allows a single probe in HALF_OPEN.
class CircuitBreaker {
  constructor(opts) {
    opts = opts || {};
    this.threshold = opts.threshold || DEFAULTS.CIRCUIT_FAIL_THRESHOLD;
    this.openMs = opts.openMs || DEFAULTS.CIRCUIT_OPEN_MS;
    this._clock = opts.clock || { now: () => Date.now() };
    this._state = CIRCUIT.CLOSED;
    this._fails = 0;
    this._openedAt = 0;
    this._probing = false;
    this._trips = 0;
  }

  state() {
    return this._state;
  }

  canPass() {
    if (this._state === CIRCUIT.CLOSED) return true;
    if (this._state === CIRCUIT.HALF_OPEN) {
      if (this._probing) return false;
      this._probing = true;
      return true;
    }
    // OPEN -> check for cooldown elapse.
    if (this._clock.now() - this._openedAt >= this.openMs) {
      this._state = CIRCUIT.HALF_OPEN;
      this._probing = true;
      return true;
    }
    return false;
  }

  recordSuccess() {
    this._fails = 0;
    this._probing = false;
    this._state = CIRCUIT.CLOSED;
  }

  recordFailure() {
    this._probing = false;
    this._fails++;
    if (this._state === CIRCUIT.HALF_OPEN) {
      this._state = CIRCUIT.OPEN;
      this._openedAt = this._clock.now();
      this._trips++;
      return;
    }
    if (this._fails >= this.threshold && this._state === CIRCUIT.CLOSED) {
      this._state = CIRCUIT.OPEN;
      this._openedAt = this._clock.now();
      this._trips++;
    }
  }

  snapshot() {
    return { state: this._state, fails: this._fails, trips: this._trips };
  }
}

// DefaultHttpTransport uses Node's http/https modules. Returns
// { status, body } and throws only on connection/timeout errors.
function defaultHttpTransport() {
  return function request(url, { method, headers, body, timeoutMs }) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (e) {
        reject(e);
        return;
      }
      const mod = parsed.protocol === 'http:' ? http : https;
      const req = mod.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
          path: parsed.pathname + parsed.search,
          method,
          headers,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve({ status: res.statusCode || 0, body: buf.toString('utf8') });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (timeoutMs) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error('request timeout after ' + timeoutMs + 'ms'));
        });
      }
      if (body != null) req.write(body);
      req.end();
    });
  };
}

// Transport orchestrates circuit breakers, retries, and redaction-free delivery.
// Redaction happens before items reach the transport.
class Transport {
  constructor(opts) {
    opts = opts || {};
    this.host = opts.host || DEFAULTS.HOST;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs || DEFAULTS.REQUEST_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries != null ? opts.maxRetries : DEFAULTS.MAX_RETRIES;
    this.dryRun = !!opts.dryRun;
    this._http = opts.transport || defaultHttpTransport();
    this._clock = opts.clock || { now: () => Date.now(), setTimeout };
    this._rng = opts.rng || Math.random;
    this._breakers = new Map();
    this._stats = { retries: 0, failures: 0, successes: 0, dryRunCalls: 0 };
  }

  _breaker(endpoint) {
    let b = this._breakers.get(endpoint);
    if (!b) {
      b = new CircuitBreaker({ clock: this._clock });
      this._breakers.set(endpoint, b);
    }
    return b;
  }

  async send(endpoint, payload) {
    const url = this.host.replace(/\/+$/, '') + endpoint;
    const body = JSON.stringify(payload);
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
      authorization: 'Bearer ' + (this.apiKey || ''),
      'user-agent': 'strawberry-node/1.0.0',
    };

    if (this.dryRun) {
      this._stats.dryRunCalls++;
      return { ok: true, status: 0, dryRun: true };
    }

    const breaker = this._breaker(endpoint);
    if (!breaker.canPass()) {
      return { ok: false, status: 0, error: 'circuit_open' };
    }

    const backoff = new DecorrelatedBackoff(
      DEFAULTS.BACKOFF_BASE_MS,
      DEFAULTS.BACKOFF_CAP_MS,
      this._rng,
    );

    let attempt = 0;
    let lastErr = null;
    // Total tries = 1 + maxRetries.
    while (attempt <= this.maxRetries) {
      attempt++;
      try {
        const res = await this._http(url, {
          method: 'POST',
          headers,
          body,
          timeoutMs: this.timeoutMs,
        });
        if (res.status >= 200 && res.status < 300) {
          breaker.recordSuccess();
          this._stats.successes++;
          return { ok: true, status: res.status };
        }
        // 4xx (except 429) are not retryable.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          breaker.recordFailure();
          this._stats.failures++;
          return { ok: false, status: res.status, error: 'client_error', body: res.body };
        }
        lastErr = 'status_' + res.status;
      } catch (e) {
        lastErr = (e && e.message) || String(e);
      }

      if (attempt > this.maxRetries) break;
      this._stats.retries++;
      await sleep(backoff.next(), this._clock);
    }

    breaker.recordFailure();
    this._stats.failures++;
    return { ok: false, status: 0, error: lastErr || 'unknown' };
  }

  snapshot() {
    const circuits = {};
    for (const [k, b] of this._breakers) circuits[k] = b.snapshot();
    return Object.assign({}, this._stats, { circuits });
  }
}

module.exports = { Transport, CircuitBreaker, defaultHttpTransport };
