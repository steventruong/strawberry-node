'use strict';

// Decorrelated jittered backoff.
// Inspired by the AWS architecture blog "Exponential Backoff And Jitter":
// sleep = random_between(base, min(cap, prev * 3)).
// Keeps retries spread out under contention without synchronized stampedes.
class DecorrelatedBackoff {
  constructor(baseMs, capMs, rng) {
    this.base = baseMs;
    this.cap = capMs;
    this.prev = baseMs;
    this._rng = rng || Math.random;
  }

  next() {
    const upper = Math.min(this.cap, this.prev * 3);
    const low = this.base;
    const high = Math.max(low + 1, upper);
    const delay = Math.floor(low + this._rng() * (high - low));
    this.prev = delay;
    return delay;
  }

  reset() {
    this.prev = this.base;
  }
}

// sleep returns a promise that can be cancelled via the provided clock.
function sleep(ms, clock) {
  return new Promise((resolve) => {
    const setT = (clock && clock.setTimeout) || setTimeout;
    setT(resolve, ms);
  });
}

module.exports = { DecorrelatedBackoff, sleep };
