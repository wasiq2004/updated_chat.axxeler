// Embedded Signup helpers. facebookAuth reads env lazily and pulls in no pg
// pool, so it loads cleanly under `node --test` with no database.

const { test } = require('node:test');
const assert = require('node:assert');
const facebookAuth = require('../src/services/facebookAuth');

test('generateTwoStepPin always returns exactly six digits', () => {
  // Meta rejects anything that isn't a 6-digit PIN. The zero-padding case is the
  // one that bites: randomInt(0, 1000000) legitimately returns e.g. 42, and an
  // unpadded "42" would be sent to /register and rejected.
  for (let i = 0; i < 5000; i++) {
    const pin = facebookAuth.generateTwoStepPin();
    assert.match(pin, /^[0-9]{6}$/, `bad pin: "${pin}"`);
  }
});

test('generateTwoStepPin uses the full keyspace, including leading zeros', () => {
  const pins = Array.from({ length: 5000 }, () => facebookAuth.generateTwoStepPin());
  // A naive randomInt(100000, 999999) never emits a leading zero and quietly
  // drops 10% of the keyspace. Assert we do emit them.
  assert.ok(pins.some(p => p.startsWith('0')), 'no leading-zero PIN in 5000 draws');
  // Sanity: not a constant.
  assert.ok(new Set(pins).size > 4000, 'PINs are not sufficiently random');
});

test('registerPhoneNumber refuses to call Meta with missing arguments', async () => {
  // Guard against a silent no-op turning into a "registered" claim.
  for (const args of [[null, 'tok', '123456'], ['pid', null, '123456'], ['pid', 'tok', null]]) {
    const r = await facebookAuth.registerPhoneNumber(...args);
    assert.equal(r.ok, false);
    assert.equal(r.skipped, true);
  }
});

test('getPublicConfig never leaks the app secret', () => {
  process.env.FB_APP_ID = '123';
  process.env.FB_APP_SECRET = 'super-secret-value';
  process.env.FB_LOGIN_CONFIG_ID = '1517165402986606';
  const cfg = facebookAuth.getPublicConfig();
  const serialized = JSON.stringify(cfg);
  assert.ok(!serialized.includes('super-secret-value'), 'FB_APP_SECRET leaked to the browser!');
  assert.equal(cfg.appId, '123');
  assert.equal(cfg.configId, '1517165402986606');
  delete process.env.FB_APP_ID;
  delete process.env.FB_APP_SECRET;
  delete process.env.FB_LOGIN_CONFIG_ID;
});
