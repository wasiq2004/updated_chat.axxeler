// Self-serve signup derivation helpers.
//
// These matter because z_chat_users.username and tenants.slug are both NOT NULL
// and GLOBALLY UNIQUE, and neither is supplied by the person signing up — both
// are derived from free text. A bad derivation is a failed signup or, worse, a
// unique-violation loop.
//
// services/signup pulls in bcryptjs + crypto only (no pg pool), so it imports
// cleanly under `node --test` with no database.

const { test } = require('node:test');
const assert = require('node:assert');
const { slugify, usernameBase } = require('../src/services/signup');

test('slugify produces a URL-safe tenant slug', () => {
  assert.equal(slugify('Acme Pvt Ltd'), 'acme-pvt-ltd');
  assert.equal(slugify('  Spaces  Everywhere  '), 'spaces-everywhere');
  assert.equal(slugify('Ravi & Sons — Traders!'), 'ravi-sons-traders');
  assert.equal(slugify('under_scores.and.dots'), 'under-scores-and-dots');
});

test('slugify never leaves leading/trailing or doubled separators', () => {
  for (const input of ['!!!Acme!!!', '---hi---', '   ', '@@@', 'a  --  b']) {
    const out = slugify(input);
    assert.ok(!out.startsWith('-'), `"${input}" -> "${out}" starts with -`);
    assert.ok(!out.endsWith('-'), `"${input}" -> "${out}" ends with -`);
    assert.ok(!out.includes('--'), `"${input}" -> "${out}" has a doubled -`);
  }
});

test('slugify returns empty (not garbage) when nothing survives', () => {
  // The caller substitutes its own fallback; the contract is "empty", not "-".
  assert.equal(slugify('!!!'), '');
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
});

test('slugify bounds the length so it cannot overflow the column', () => {
  assert.ok(slugify('a'.repeat(200)).length <= 32);
});

test('usernameBase derives from the email local part', () => {
  assert.equal(usernameBase('priya.sharma@acme.com'), 'priya.sharma');
  assert.equal(usernameBase('RAVI@Example.COM'), 'ravi');
  assert.equal(usernameBase('some+tag@x.io'), 'sometag'); // '+' is not allowed
});

test('usernameBase never returns a reserved name', () => {
  // 'admin' is taken by the first-run setup wizard, which hardcodes it — handing
  // it to a signup guarantees a unique violation on username.
  for (const email of ['admin@x.com', 'root@x.com', 'system@x.com', 'support@x.com']) {
    const out = usernameBase(email);
    assert.notEqual(out, email.split('@')[0]);
    assert.ok(/^user\d{4}$/.test(out), `expected a generated name, got "${out}"`);
  }
});

test('usernameBase falls back when the local part is too short or unusable', () => {
  for (const email of ['a@x.com', 'ab@x.com', '!!!@x.com', '@x.com']) {
    assert.ok(/^user\d{4}$/.test(usernameBase(email)), `no fallback for "${email}"`);
  }
});

test('usernameBase output always satisfies the column constraints', () => {
  const samples = [
    'priya.sharma@acme.com', 'RAVI@Example.COM', 'a@x.com', 'admin@x.com',
    'x'.repeat(80) + '@x.com', '..dots..@x.com', 'user-name@x.com',
  ];
  for (const email of samples) {
    const out = usernameBase(email);
    assert.ok(out.length >= 3, `"${email}" -> "${out}" too short`);
    assert.ok(out.length <= 24, `"${email}" -> "${out}" too long`);
    assert.ok(/^[a-z0-9][a-z0-9._-]*$/.test(out), `"${email}" -> "${out}" has bad chars`);
  }
});
