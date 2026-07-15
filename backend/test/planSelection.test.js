// The entry-plan choice, tested against a fake client so the real SQL ordering
// and filtering is exercised without a database.
//
// Why this file exists: the original ordering was `(key='starter') DESC,
// price_monthly ASC`. The seeded 'enterprise' plan is priced 0 (it means
// "Custom — call us") with unlimited seats and every feature. So for any catalog
// with no plan keyed 'starter' — i.e. any partner who named their entry tier
// something else — the cheapest plan WAS enterprise, and every signup under that
// partner silently got unlimited Enterprise, free, forever.

const { test } = require('node:test');
const assert = require('node:assert');
const { createWorkspace } = require('../src/services/signup');

// Minimal stand-in for a pg client: answers the queries createWorkspace makes,
// and records the plan-selection SQL so we can assert on it.
function fakeClient(plans, { reseller = null } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params = []) {
      seen.push({ sql, params });
      if (/FROM coexistence\.resellers/.test(sql)) {
        return { rows: reseller ? [reseller] : [] };
      }
      if (/FROM coexistence\.plans/.test(sql)) {
        // Apply the real predicate + ordering the query asks for.
        const scoped = plans.filter(p => p.is_active);
        const noEnterprise = /key <> 'enterprise'/.test(sql)
          ? scoped.filter(p => p.key !== 'enterprise')
          : scoped;
        const sorted = noEnterprise.slice().sort((a, b) => {
          if (/\(key = 'starter'\) DESC/.test(sql)) {
            const s = (b.key === 'starter') - (a.key === 'starter');
            if (s) return s;
          }
          if (/position ASC, price_monthly ASC/.test(sql)) {
            return (a.position - b.position) || (a.price_monthly - b.price_monthly);
          }
          return (a.price_monthly - b.price_monthly) || (a.position - b.position);
        });
        return { rows: sorted.length ? [{ id: sorted[0].id }] : [] };
      }
      if (/SELECT 1 FROM coexistence\.(z_chat_users|tenants)/.test(sql)) return { rows: [] };
      if (/INSERT INTO coexistence\.tenants/.test(sql)) return { rows: [{ id: 10 }] };
      if (/INSERT INTO coexistence\.organizations/.test(sql)) return { rows: [{ id: 20 }] };
      if (/INSERT INTO coexistence\.z_chat_users/.test(sql)) return { rows: [{ id: 30 }] };
      return { rows: [] };
    },
  };
}

// Mirrors db/migrations/063 exactly: note enterprise is priced 0.
const SEEDED = [
  { id: 1, key: 'starter', price_monthly: 0, position: 0, is_active: true },
  { id: 2, key: 'growth', price_monthly: 3999, position: 1, is_active: true },
  { id: 3, key: 'professional', price_monthly: 11999, position: 2, is_active: true },
  { id: 4, key: 'enterprise', price_monthly: 0, position: 3, is_active: true },
];

async function planChosenFor(plans) {
  const client = fakeClient(plans);
  await createWorkspace(client, { email: 'a@b.com', password: 'supersecret1', displayName: 'A' });
  const insert = client.seen.find(q => /INSERT INTO coexistence\.tenants/.test(q.sql));
  return insert.params[2]; // plan_id
}

test('the platform catalog puts a signup on starter, not the 0-priced enterprise', async () => {
  assert.equal(await planChosenFor(SEEDED), 1);
});

test('a catalog with NO starter key never falls through to enterprise', async () => {
  // The exact shape that gave away unlimited Enterprise for free: a partner whose
  // entry tier is named something else, plus a 0-priced enterprise.
  const partnerCatalog = [
    { id: 7, key: 'basic', price_monthly: 999, position: 0, is_active: true },
    { id: 8, key: 'pro', price_monthly: 4999, position: 1, is_active: true },
    { id: 9, key: 'enterprise', price_monthly: 0, position: 2, is_active: true },
  ];
  const chosen = await planChosenFor(partnerCatalog);
  assert.notEqual(chosen, 9, 'signup landed on the free-priced Enterprise plan');
  assert.equal(chosen, 7, 'expected the operator-ordered entry tier');
});

test('an inactive plan is never chosen', async () => {
  const chosen = await planChosenFor([
    { id: 1, key: 'starter', price_monthly: 0, position: 0, is_active: false },
    { id: 2, key: 'growth', price_monthly: 3999, position: 1, is_active: true },
  ]);
  assert.equal(chosen, 2);
});

test('operator ordering (position) wins over raw price', async () => {
  // Without an explicit 'starter', the operator's own ordering is the best signal
  // of what the entry tier is — not whichever row happens to be cheapest.
  const chosen = await planChosenFor([
    { id: 1, key: 'lite', price_monthly: 500, position: 0, is_active: true },
    { id: 2, key: 'micro', price_monthly: 100, position: 5, is_active: true },
  ]);
  assert.equal(chosen, 1);
});

test('a free plan gets NO period end; a paid plan does', async () => {
  // A stamped period on a zero-price plan meant every free signup went past_due
  // at day 30 and lost all access at day 33 — the funnel expired on a timer.
  const client = fakeClient(SEEDED);
  await createWorkspace(client, { email: 'a@b.com', password: 'supersecret1' });
  const sub = client.seen.find(q => /INSERT INTO coexistence\.subscriptions/.test(q.sql));
  assert.match(sub.sql, /price_monthly = 0 THEN NULL/,
    'subscription insert must leave current_period_end NULL for a free plan');
});

test('signup under a SUSPENDED partner is refused, not silently reassigned to us', async () => {
  // Treating suspended like unknown handed the partner's own prospect, on the
  // partner's own link, to the platform owner — with no way to un-assign.
  const client = fakeClient(SEEDED, { reseller: { id: 3, status: 'suspended', deleted_at: null } });
  await assert.rejects(
    () => createWorkspace(client, { email: 'a@b.com', password: 'supersecret1', partnerSlug: 'skyline' }),
    (err) => err.code === 'PARTNER_UNAVAILABLE'
  );
});

test('signup under a DELETED partner is refused', async () => {
  const client = fakeClient(SEEDED, { reseller: { id: 3, status: 'active', deleted_at: new Date() } });
  await assert.rejects(
    () => createWorkspace(client, { email: 'a@b.com', password: 'supersecret1', partnerSlug: 'gone' }),
    (err) => err.code === 'PARTNER_UNAVAILABLE'
  );
});

test('an UNKNOWN slug is not an error — the visitor is simply platform-direct', async () => {
  // A typo must not reject a paying customer.
  const client = fakeClient(SEEDED);
  await createWorkspace(client, { email: 'a@b.com', password: 'supersecret1', partnerSlug: 'nope' });
  const insert = client.seen.find(q => /INSERT INTO coexistence\.tenants/.test(q.sql));
  assert.equal(insert.params[3], null, 'reseller_id should be NULL for an unknown slug');
});

test('a Facebook signup is recorded as having no usable password', async () => {
  const client = fakeClient(SEEDED);
  await createWorkspace(client, { email: 'a@b.com', password: null, source: 'facebook', fbUserId: '99' });
  const insert = client.seen.find(q => /INSERT INTO coexistence\.z_chat_users/.test(q.sql));
  // password_set = FALSE is what lets us offer "set a password" instead of
  // stranding them when they lose Facebook access.
  assert.equal(insert.params[7], false);
});

test('a password signup is recorded as having a usable password', async () => {
  const client = fakeClient(SEEDED);
  await createWorkspace(client, { email: 'a@b.com', password: 'supersecret1' });
  const insert = client.seen.find(q => /INSERT INTO coexistence\.z_chat_users/.test(q.sql));
  assert.equal(insert.params[7], true);
});
