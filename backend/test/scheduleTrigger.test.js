// Scheduled-trigger fan-out and leasing.
//
// scheduleTiming.test.js covers WHEN a schedule fires. This covers what happens
// once it does — and every case here is a way to message real people twice, or
// to message the wrong people, without anything throwing:
//
//   * a slow fan-out gets re-claimed and everyone hears from us twice
//   * a lost lease is noticed only after the damage; the fencing check must
//     ABORT mid-run, not finish politely
//   * an empty tag filter reads as "everyone"
//   * an id-only tag match silently drops legacy-tagged contacts
//   * a release clears the lease of the run that REPLACED us
//
// The pool is faked, so this needs no database.

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// The fake pool. Tests install a handler that answers by SQL shape.
let handler = () => ({ rows: [] });
const fakePool = {
  async query(sql, params = []) { return handler(sql, params) || { rows: [] }; },
  async connect() { return { query: fakePool.query, release() {} }; },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '../db') return fakePool;
  // Importing the real engine pulls in the queue (and Redis). The fan-out tests
  // only care THAT an execution was started, not what it did.
  if (request === '../engine/automationEngine') {
    return { executeAutomation: async (...a) => { started.push(a); } };
  }
  if (request === './googleSheets' || request === '../services/googleSheets') {
    return { runOp: async (op, opts) => sheetsResponse(op, opts) };
  }
  return origLoad.apply(this, arguments);
};

let started = [];
let sheetsResponse = () => ({ rows: [] });

const schedule = require('../src/services/scheduleTrigger');
const { resolveAudience, fireOne, releaseLease, seedScheduleState, HARD_MAX_CONTACTS } = schedule;

const IST = 'Asia/Kolkata';
// 04:00Z = 09:30 IST — past a 09:00 slot.
const DUE = new Date('2026-07-16T04:00:00Z');
const daily = (over = {}) => ({ scheduleMode: 'daily', timeOfDay: '09:00', timezone: IST, ...over });

function reset() { started = []; handler = () => ({ rows: [] }); sheetsResponse = () => ({ rows: [] }); }

// ── the audience ────────────────────────────────────────────────────────────

test('NO TAGS SELECTED IS NOT EVERYONE — it refuses to run', async () => {
  reset();
  // THE TRAP: an empty filter is the natural way to write this query, and it
  // silently means "no WHERE clause" — i.e. the entire contact list, at 09:00.
  let contactsQueried = false;
  handler = (sql) => {
    if (/FROM coexistence\.contacts/.test(sql)) contactsQueried = true;
    return { rows: [] };
  };
  await assert.rejects(
    () => resolveAudience(daily({ audienceMode: 'contacts', audienceTagIds: [] }), 1),
    /no audience tags/i,
  );
  assert.equal(contactsQueried, false, 'must not even reach the contacts table');

  // Same for the field being absent entirely, not just empty.
  await assert.rejects(
    () => resolveAudience(daily({ audienceMode: 'contacts' }), 1),
    /no audience tags/i,
  );
});

test('a deleted audience tag refuses rather than widening to everyone', async () => {
  reset();
  // The tag rows come back empty — the tag was deleted. Falling through to an
  // unfiltered query is exactly the failure above, by another route.
  handler = (sql) => {
    if (/FROM coexistence\.tags/.test(sql)) return { rows: [] };
    if (/FROM coexistence\.contacts/.test(sql)) assert.fail('must not query contacts with a dead filter');
    return { rows: [] };
  };
  await assert.rejects(
    () => resolveAudience(daily({ audienceMode: 'contacts', audienceTagIds: [99] }), 1),
    /no longer exist|still exist/i,
  );
});

test('tags match on id OR name — an id-only match drops legacy-tagged contacts', async () => {
  reset();
  let contactSql = '';
  let contactParams = [];
  handler = (sql, params) => {
    if (/FROM coexistence\.tags/.test(sql)) return { rows: [{ id: 7, name: 'Hot Lead' }] };
    if (/FROM coexistence\.contacts/.test(sql)) {
      contactSql = sql; contactParams = params;
      return { rows: [{ contact_number: '919', wa_number: '918', tags: [], custom_fields: {} }] };
    }
    return { rows: [] };
  };
  await resolveAudience(daily({ audienceMode: 'contacts', audienceTagIds: [7] }), 1);

  // A contact's tag entry can carry a missing/stale id — automationEngine's
  // Remove Tag says so out loud and matches on name too. Matching on id alone
  // silently shrinks the campaign, and a smaller audience looks exactly like a
  // smaller tag.
  assert.match(contactSql, /LOWER\(t->>'name'\)/, 'must also match by tag NAME');
  assert.ok(contactParams.some(p => Array.isArray(p) && p.includes('hot lead')),
    'the name must be passed lowercased for a case-insensitive match');
  // And the id cast must be guarded — a bare ::bigint throws on a non-numeric id.
  assert.match(contactSql, /~ '\^\[0-9\]\+\$'/, 'the id cast must be regex-guarded');
});

test('the audience is capped, and truncation is reported rather than silent', async () => {
  reset();
  handler = (sql) => {
    if (/FROM coexistence\.tags/.test(sql)) return { rows: [{ id: 7, name: 'Hot' }] };
    if (/FROM coexistence\.contacts/.test(sql)) {
      // The query asks for cap+1 so "exactly at the cap" is distinguishable
      // from "truncated". Return more than asked to prove the slice.
      return { rows: Array.from({ length: 12 }, (_, i) => ({ contact_number: `9${i}`, wa_number: '918', tags: [], custom_fields: {} })) };
    }
    return { rows: [] };
  };
  const out = await resolveAudience(daily({ audienceMode: 'contacts', audienceTagIds: [7], maxPerRun: 10 }), 1);
  assert.equal(out.rows.length, 10, 'capped');
  assert.equal(out.truncated, true, 'and it must SAY it was capped');
});

test('maxPerRun cannot exceed the hard ceiling', async () => {
  reset();
  let limitAsked = null;
  handler = (sql, params) => {
    if (/FROM coexistence\.tags/.test(sql)) return { rows: [{ id: 7, name: 'Hot' }] };
    if (/FROM coexistence\.contacts/.test(sql)) { limitAsked = params[params.length - 1]; return { rows: [] }; }
    return { rows: [] };
  };
  // An operator typing 100000 must not get 100000 messages sent.
  await resolveAudience(daily({ audienceMode: 'contacts', audienceTagIds: [7], maxPerRun: 100000 }), 1);
  assert.equal(limitAsked, HARD_MAX_CONTACTS + 1, `clamped to the ${HARD_MAX_CONTACTS} ceiling (+1 probe)`);
});

test('"once" mode yields exactly one contactless run', async () => {
  reset();
  const out = await resolveAudience(daily({ audienceMode: 'once' }), 1);
  assert.equal(out.rows.length, 1);
  assert.deepEqual(out.rows[0], {}, 'no contact — messaging steps will fail, as documented');
});

// ── the leasing ─────────────────────────────────────────────────────────────

test('losing the race claims nothing and is NOT an error', async () => {
  reset();
  handler = (sql) => {
    if (/SELECT \* FROM coexistence\.schedule_trigger_state/.test(sql)) return { rows: [] };
    // The guarded UPDATE matched nothing — someone else holds the slot.
    if (/INSERT INTO coexistence\.schedule_trigger_state/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
  const r = await fireOne({ automation: { id: 1, tenant_id: 1 }, trigger: daily({ audienceMode: 'once' }) }, DUE);
  assert.equal(r.skipped, 'not_claimed');
  assert.equal(started.length, 0, 'a lost race must send nothing');
});

test('THE FENCING CHECK: losing the lease mid-run ABORTS the fan-out', async () => {
  reset();
  // THE TRAP a fixed lease can't fix: a 1000-contact run outlives any lease, the
  // next tick re-claims it, and now two runs are messaging the same list. The
  // loser must notice and STOP — not finish politely.
  let ownershipChecks = 0;
  handler = (sql) => {
    if (/SELECT \* FROM coexistence\.schedule_trigger_state/.test(sql)) return { rows: [] };
    if (/INSERT INTO coexistence\.schedule_trigger_state/.test(sql)) return { rows: [{ lease_token: 'tok' }] };
    if (/FROM coexistence\.tags/.test(sql)) return { rows: [{ id: 7, name: 'Hot' }] };
    if (/FROM coexistence\.contacts/.test(sql)) {
      return { rows: Array.from({ length: 5 }, (_, i) => ({ contact_number: `9${i}`, wa_number: '918', tags: [], custom_fields: {} })) };
    }
    if (/WHERE chatbot_id = \$1 AND lease_token = \$2/.test(sql) && /^SELECT/.test(sql.trim())) {
      ownershipChecks++;
      // We own it for the first two contacts, then get re-claimed.
      return { rows: ownershipChecks <= 2 ? [{ '?column?': 1 }] : [] };
    }
    return { rows: [] };
  };
  const r = await fireOne({ automation: { id: 1, tenant_id: 1 }, trigger: daily({ audienceMode: 'contacts', audienceTagIds: [7] }) }, DUE);
  assert.equal(r.fired, true);
  assert.equal(r.contacts, 2, 'exactly the two we still owned — the other three must NOT be messaged');
  assert.equal(started.length, 2);
});

test('the slot is stamped AT CLAIM, before any message goes out', async () => {
  reset();
  const order = [];
  handler = (sql) => {
    if (/SELECT \* FROM coexistence\.schedule_trigger_state/.test(sql)) return { rows: [] };
    if (/INSERT INTO coexistence\.schedule_trigger_state/.test(sql)) { order.push('claim'); return { rows: [{ lease_token: 'tok' }] }; }
    if (/FROM coexistence\.tags/.test(sql)) return { rows: [{ id: 7, name: 'Hot' }] };
    if (/FROM coexistence\.contacts/.test(sql)) { order.push('audience'); return { rows: [{ contact_number: '91', wa_number: '918', tags: [], custom_fields: {} }] }; }
    if (/lease_token = \$2/.test(sql) && /^SELECT/.test(sql.trim())) return { rows: [{ x: 1 }] };
    return { rows: [] };
  };
  await fireOne({ automation: { id: 1, tenant_id: 1 }, trigger: daily({ audienceMode: 'contacts', audienceTagIds: [7] }) }, DUE);
  assert.equal(order[0], 'claim', 'claim first — a crash mid-fan-out must FORFEIT the slot, not replay it to everyone');
});

test('release only fires when we still hold the token', async () => {
  reset();
  let releaseSql = '';
  handler = (sql) => {
    if (/SET lease_token = NULL/.test(sql)) { releaseSql = sql; }
    return { rows: [] };
  };
  await releaseLease(1, 'tok', { contacts: 3, error: null });
  // THE TRAP: an unconditional release clears the lease of the run that
  // REPLACED us, and a third run starts on top of the second.
  assert.match(releaseSql, /lease_token = \$2/, 'the release must be token-guarded');
});

test('one bad contact does not abort the other four', async () => {
  reset();
  // This is exactly what the per-contact fan-out buys over a loop node.
  handler = (sql) => {
    if (/SELECT \* FROM coexistence\.schedule_trigger_state/.test(sql)) return { rows: [] };
    if (/INSERT INTO coexistence\.schedule_trigger_state/.test(sql)) return { rows: [{ lease_token: 'tok' }] };
    if (/FROM coexistence\.tags/.test(sql)) return { rows: [{ id: 7, name: 'Hot' }] };
    if (/FROM coexistence\.contacts/.test(sql)) {
      return { rows: Array.from({ length: 5 }, (_, i) => ({ contact_number: `9${i}`, wa_number: '918', tags: [], custom_fields: {} })) };
    }
    if (/lease_token = \$2/.test(sql) && /^SELECT/.test(sql.trim())) return { rows: [{ x: 1 }] };
    return { rows: [] };
  };
  const origLog = console.error; console.error = () => {};
  try {
    // Blow up on the third contact only.
    const realLoad = Module._load;
    Module._load = function (request) {
      if (request === '../engine/automationEngine') {
        return { executeAutomation: async (...a) => {
          started.push(a);
          if (started.length === 3) throw new Error('boom');
        } };
      }
      return realLoad.apply(this, arguments);
    };
    const r = await fireOne({ automation: { id: 1, tenant_id: 1 }, trigger: daily({ audienceMode: 'contacts', audienceTagIds: [7] }) }, DUE);
    Module._load = realLoad;
    assert.equal(started.length, 5, 'all five were attempted');
    assert.equal(r.contacts, 4, 'four succeeded — the failure is isolated, not fatal');
  } finally { console.error = origLog; }
});

test('a schedule that is not due claims nothing', async () => {
  reset();
  handler = (sql) => {
    if (/SELECT \* FROM coexistence\.schedule_trigger_state/.test(sql)) {
      return { rows: [{ last_fired_date: '2026-07-16', last_fired_at: '2026-07-16T04:00:00Z', last_fired_tz: IST }] };
    }
    if (/INSERT INTO coexistence\.schedule_trigger_state/.test(sql)) assert.fail('must not claim a slot that already fired');
    return { rows: [] };
  };
  const r = await fireOne({ automation: { id: 1, tenant_id: 1 }, trigger: daily({ audienceMode: 'once' }) }, new Date('2026-07-16T05:00:00Z'));
  assert.equal(r.skipped, 'already_fired_today');
});

// ── activation seeding ──────────────────────────────────────────────────────

test('activating BEFORE the slot seeds null, so it still fires today', async () => {
  reset();
  let seeded;
  handler = (sql, params) => {
    if (/INSERT INTO coexistence\.schedule_trigger_state/.test(sql)) { seeded = params[1]; return { rowCount: 1, rows: [] }; }
    return { rows: [] };
  };
  const config = { nodes: [{ type: 'trigger', triggerKind: 'schedule', ...daily({ timeOfDay: '18:00' }) }] };
  const r = await seedScheduleState(9, config, DUE); // 09:30 IST — 18:00 still ahead
  assert.equal(seeded, null, 'seeding today unconditionally silently SKIPS the first run');
  assert.equal(r.firesToday, true);
});

test('activating AFTER the slot seeds today, so it does not back-fire', async () => {
  reset();
  let seeded;
  handler = (sql, params) => {
    if (/INSERT INTO coexistence\.schedule_trigger_state/.test(sql)) { seeded = params[1]; return { rowCount: 1, rows: [] }; }
    return { rows: [] };
  };
  const config = { nodes: [{ type: 'trigger', triggerKind: 'schedule', ...daily({ timeOfDay: '09:00' }) }] };
  await seedScheduleState(9, config, new Date('2026-07-16T13:00:00Z')); // 18:30 IST
  assert.equal(seeded, '2026-07-16', 'today’s 09:00 already passed — suppress it, do not blast');
});

test('seeding never yanks the ground out from under a live fan-out', async () => {
  reset();
  let sql = '';
  handler = (s) => { if (/INSERT INTO coexistence\.schedule_trigger_state/.test(s)) sql = s; return { rowCount: 0, rows: [] }; };
  const config = { nodes: [{ type: 'trigger', triggerKind: 'schedule', ...daily() }] };
  await seedScheduleState(9, config, DUE);
  assert.match(sql, /lease_token IS NULL/, 'the seed must skip a chatbot that is mid-run');
});

test('seeding a non-schedule flow is a no-op, not a write', async () => {
  reset();
  handler = (sql) => {
    if (/schedule_trigger_state/.test(sql)) assert.fail('a keyword flow must not touch schedule state');
    return { rows: [] };
  };
  const r = await seedScheduleState(9, { nodes: [{ type: 'trigger', triggerKind: 'keyword', keyword: 'HI' }] }, DUE);
  assert.equal(r.seeded, false);
});

// ── the query that would have crashed every tick ─────────────────────────────

test('the trigger lookup uses status, not the is_active column that does not exist', async () => {
  reset();
  let sql = '';
  handler = (s) => { sql = s; return { rows: [] }; };
  await schedule.findScheduleTriggers();
  // chatbots has `status TEXT NOT NULL DEFAULT 'draft'` and NO is_active column.
  // Querying is_active throws on EVERY tick — a poller that never once runs.
  assert.doesNotMatch(sql, /is_active/, 'chatbots has no is_active column');
  assert.match(sql, /status = 'active'/);
});

// ── triggerAccounts: phone numbers, not ids ─────────────────────────────────

test('triggerAccounts are matched as PHONE NUMBERS — an id cast throws', async () => {
  reset();
  // THE TRAP: the name reads like ids, and two of the three call sites treated
  // them as ids. The builder's checkbox stores acc.displayPhoneNumber, and
  // automationEngine matches triggerAccounts against messageRecord.wa_number.
  // `id = ANY($1::bigint[])` with ['+91 98765 43210'] throws at the cast — the
  // whole fan-out dies before anyone is messaged.
  let waSql = '', waParams = [];
  handler = (sql, params) => {
    if (/SELECT \* FROM coexistence\.schedule_trigger_state/.test(sql)) return { rows: [] };
    if (/INSERT INTO coexistence\.schedule_trigger_state/.test(sql)) return { rows: [{ lease_token: 'tok' }] };
    if (/FROM coexistence\.whatsapp_accounts/.test(sql)) {
      waSql = sql; waParams = params;
      return { rows: [{ display_phone_number: '+91 98765 43210' }] };
    }
    if (/lease_token = \$2/.test(sql) && /^SELECT/.test(sql.trim())) return { rows: [{ x: 1 }] };
    return { rows: [] };
  };
  await fireOne({
    automation: { id: 1, tenant_id: 1 },
    trigger: daily({ audienceMode: 'once', triggerAccounts: ['+91 98765 43210'] }),
  }, DUE);

  assert.doesNotMatch(waSql, /bigint/, 'a phone number is not a bigint');
  assert.match(waSql, /regexp_replace/, 'both sides must compare digits-only — the stored number is formatted');
  assert.deepEqual(waParams[0], ['919876543210'], 'the formatted number must be normalised before matching');
});
