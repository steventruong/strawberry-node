'use strict';

// Always-on PII redactor.
// Runs on every outgoing event's properties, error context, log attrs, etc.
// Replaces matches with "[REDACTED]" and increments a counter reachable via
// diagnostics(). The redactor operates recursively on objects and arrays.

const REDACTED = '[REDACTED]';

// Field-name denylist. Match is case-insensitive, substring-based so e.g.
// "user_password_hash" also matches "password".
const DENYLIST_FIELDS = [
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'cookie',
  'session',
  'ssn',
  'credit_card',
  'card_number',
  'cvv',
  'pin',
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone: permissive international / US formats with optional separators.
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
// JWT: three base64url segments separated by dots.
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// Known API-key prefixes. Lengths vary so use a generous tail match.
const API_KEY_RE =
  /\b(?:sk|sbk|berry|wt_live|ghp)_[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b/g;
// Candidate credit-card numbers (13-19 digits with optional spaces / dashes).
// Additional Luhn check weeds out non-card numerics like IDs.
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;

function luhnValid(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const c = digits.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return false;
    let d = c;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0 && digits.length >= 13 && digits.length <= 19;
}

function isDenied(fieldName) {
  if (!fieldName) return false;
  const lower = String(fieldName).toLowerCase();
  for (const needle of DENYLIST_FIELDS) {
    if (lower.indexOf(needle) !== -1) return true;
  }
  return false;
}

function redactString(s, counter) {
  if (typeof s !== 'string' || s.length === 0) return s;
  let out = s;

  const before = out;
  out = out.replace(API_KEY_RE, () => {
    counter.api_keys++;
    return REDACTED;
  });
  out = out.replace(JWT_RE, () => {
    counter.jwts++;
    return REDACTED;
  });
  out = out.replace(EMAIL_RE, () => {
    counter.emails++;
    return REDACTED;
  });
  // Cards before phones so 16-digit numerics are handled first.
  out = out.replace(CARD_CANDIDATE_RE, (match) => {
    const digits = match.replace(/[^0-9]/g, '');
    if (luhnValid(digits)) {
      counter.cards++;
      return REDACTED;
    }
    return match;
  });
  out = out.replace(PHONE_RE, (match) => {
    const digits = match.replace(/[^0-9]/g, '');
    if (digits.length < 10) return match;
    counter.phones++;
    return REDACTED;
  });

  if (out !== before) counter.strings_modified++;
  return out;
}

function redactValue(value, counter, keyName) {
  if (value == null) return value;

  if (keyName && isDenied(keyName) && typeof value !== 'object') {
    counter.fields++;
    return REDACTED;
  }

  if (typeof value === 'string') return redactString(value, counter);

  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = redactValue(value[i], counter, null);
    return out;
  }

  if (typeof value === 'object') {
    if (keyName && isDenied(keyName)) {
      // Entire sub-object gets nuked.
      counter.fields++;
      return REDACTED;
    }
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = redactValue(value[k], counter, k);
    }
    return out;
  }

  return value;
}

// Build a fresh redactor instance. Each client holds its own so diagnostics
// can be reset independently across tests and reinit.
function createRedactor() {
  const counter = {
    emails: 0,
    phones: 0,
    cards: 0,
    jwts: 0,
    api_keys: 0,
    fields: 0,
    strings_modified: 0,
  };
  return {
    redact(value) {
      return redactValue(value, counter, null);
    },
    stats() {
      return Object.assign({}, counter);
    },
  };
}

module.exports = { createRedactor, luhnValid, REDACTED };
