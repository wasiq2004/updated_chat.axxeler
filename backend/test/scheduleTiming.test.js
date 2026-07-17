// Scheduled trigger timing.
//
// Every case here is a stated trap, and each was a real bug. They share a shape:
// none of them throws. A schedule that skips its first run, or fires twice, or
// re-fires on a timezone change, just quietly does the wrong thing to real
// customers' phones.
//
// The functions are pure and take `now`, so this needs no clock mocking.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  shouldFire, seedFiredDate, isScheduledDay, partsInTz, parseTimeOfDay, daysInMonth,
} = require('../src/services/scheduleTiming');

const IST = 'Asia/Kolkata';
// 2026-07-16 is a Thursday. IST is UTC+5:30, so 04:00Z = 09:30 IST.
const at = (iso) => new Date(iso);

test('local wall-clock parts are computed in the trigger timezone', () => {
  const p = partsInTz(at('2026-07-16T04:00:00Z'), IST);
  assert.equal(p.date, '2026-07-16');
  assert.equal(p.hour, 9);
  assert.equal(p.minute, 30);
  assert.equal(p.weekday, 4); // Thursday
});

test('a UTC date and an IST date can be DIFFERENT days — the whole reason for the model', () => {
  // 20:00Z on the 15th is already 01:30 IST on the 16th.
  const late = at('2026-07-15T20:00:00Z');
  assert.equal(partsInTz(late, 'UTC').date, '2026-07-15');
  assert.equal(partsInTz(late, IST).date, '2026-07-16');
});

test('parseTimeOfDay tolerates nonsense rather than throwing at 3am', () => {
  assert.deepEqual(parseTimeOfDay('09:30'), { hour: 9, minute: 30 });
  assert.deepEqual(parseTimeOfDay('23:59'), { hour: 23, minute: 59 });
  assert.deepEqual(parseTimeOfDay(''), { hour: 9, minute: 0 });
  assert.deepEqual(parseTimeOfDay('banana'), { hour: 9, minute: 0 });
  assert.deepEqual(parseTimeOfDay('99:99'), { hour: 23, minute: 59 });
});

// ── fires at the right local time ───────────────────────────────────────────

test('fires once the local time-of-day has passed', () => {
  const node = { scheduleMode: 'daily', timeOfDay: '09:00', timezone: IST };
  // 03:00Z = 08:30 IST — before 09:00.
  assert.equal(shouldFire(node, {}, at('2026-07-16T03:00:00Z')).fire, false);
  // 04:00Z = 09:30 IST — after.
  assert.equal(shouldFire(node, {}, at('2026-07-16T04:00:00Z')).fire, true);
});

test('the same instant fires or not depending on the timezone', () => {
  const now = at('2026-07-16T04:00:00Z'); // 09:30 IST, 04:00 UTC
  const ist = { scheduleMode: 'daily', timeOfDay: '09:00', timezone: IST };
  const utc = { scheduleMode: 'daily', timeOfDay: '09:00', timezone: 'UTC' };
  assert.equal(shouldFire(ist, {}, now).fire, true, '09:30 IST is past 09:00');
  assert.equal(shouldFire(utc, {}, now).fire, false, '04:00 UTC is not');
});

// ── never twice a day ───────────────────────────────────────────────────────

test('never fires twice in the same local day', () => {
  const node = { scheduleMode: 'daily', timeOfDay: '09:00', timezone: IST };
  const first = shouldFire(node, {}, at('2026-07-16T04:00:00Z'));
  assert.equal(first.fire, true);
  const state = { last_fired_date: first.slotDate, last_fired_at: '2026-07-16T04:00:00Z', last_fired_tz: IST };
  // Every subsequent tick that day.
  for (const t of ['2026-07-16T04:01:00Z', '2026-07-16T10:00:00Z', '2026-07-16T17:00:00Z']) {
    const r = shouldFire(node, state, at(t));
    assert.equal(r.fire, false, `fired again at ${t}`);
    assert.equal(r.reason, 'already_fired_today');
  }
});

test('fires again the NEXT day', () => {
  const node = { scheduleMode: 'daily', timeOfDay: '09:00', timezone: IST };
  const state = { last_fired_date: '2026-07-16', last_fired_at: '2026-07-16T04:00:00Z', last_fired_tz: IST };
  assert.equal(shouldFire(node, state, at('2026-07-17T04:00:00Z')).fire, true);
});

// ── activation must not blast, and must not skip ────────────────────────────

test('activating BEFORE the slot still fires today', () => {
  // THE TRAP: seeding today's date unconditionally silently skips the first run
  // — a whole week for a weekly, a month for a monthly.
  const node = { scheduleMode: 'daily', timeOfDay: '18:00', timezone: IST };
  const activatedAt = at('2026-07-16T04:00:00Z'); // 09:30 IST — 18:00 is still ahead
  assert.equal(seedFiredDate(node, activatedAt), null, 'must not suppress a slot that has not happened yet');
  const state = { last_fired_date: seedFiredDate(node, activatedAt) };
  // 13:00Z = 18:30 IST, same day.
  assert.equal(shouldFire(node, state, at('2026-07-16T13:00:00Z')).fire, true);
});

test('activating AFTER the slot does NOT back-fire it', () => {
  const node = { scheduleMode: 'daily', timeOfDay: '09:00', timezone: IST };
  const activatedAt = at('2026-07-16T13:00:00Z'); // 18:30 IST — 09:00 already gone
  assert.equal(seedFiredDate(node, activatedAt), '2026-07-16', 'today’s slot is already past — suppress it');
  const state = { last_fired_date: seedFiredDate(node, activatedAt) };
  assert.equal(shouldFire(node, state, at('2026-07-16T13:01:00Z')).fire, false, 'must not fire for a slot that passed before activation');
  // …but tomorrow is fair game.
  assert.equal(shouldFire(node, state, at('2026-07-17T04:00:00Z')).fire, true);
});

test('a weekly activated on a non-scheduled day does not seed, and waits', () => {
  // Mondays only; activated on a Thursday.
  const node = { scheduleMode: 'weekly', weekdays: [1], timeOfDay: '09:00', timezone: IST };
  assert.equal(seedFiredDate(node, at('2026-07-16T13:00:00Z')), null, 'nothing to suppress on a day it never runs');
  assert.equal(shouldFire(node, {}, at('2026-07-16T13:00:00Z')).fire, false);
  // 2026-07-20 is the following Monday.
  assert.equal(shouldFire(node, {}, at('2026-07-20T04:00:00Z')).fire, true);
});

// ── weekly / monthly / month-end ────────────────────────────────────────────

test('weekly fires only on its chosen weekdays', () => {
  const node = { scheduleMode: 'weekly', weekdays: [1, 4], timeOfDay: '09:00', timezone: IST }; // Mon + Thu
  assert.equal(shouldFire(node, {}, at('2026-07-16T04:00:00Z')).fire, true, 'Thursday');
  assert.equal(shouldFire(node, {}, at('2026-07-17T04:00:00Z')).fire, false, 'Friday');
  assert.equal(shouldFire(node, {}, at('2026-07-20T04:00:00Z')).fire, true, 'Monday');
});

test('weekly with no weekdays chosen fires never, rather than every day', () => {
  const node = { scheduleMode: 'weekly', weekdays: [], timeOfDay: '09:00', timezone: IST };
  assert.equal(shouldFire(node, {}, at('2026-07-16T04:00:00Z')).fire, false);
});

test('monthly clamps to month end: the 31st fires on Feb 28', () => {
  const node = { scheduleMode: 'monthly', dayOfMonth: 31, timeOfDay: '09:00', timezone: IST };
  // Without the clamp, February/April/June/September/November are silently skipped.
  assert.equal(shouldFire(node, {}, at('2026-02-28T04:00:00Z')).fire, true, 'Feb 28 is Feb’s 31st');
  assert.equal(shouldFire(node, {}, at('2026-02-27T04:00:00Z')).fire, false);
  // A 31-day month uses the real 31st.
  assert.equal(shouldFire(node, {}, at('2026-07-31T04:00:00Z')).fire, true);
  assert.equal(shouldFire(node, {}, at('2026-07-30T04:00:00Z')).fire, false);
});

test('monthly clamps on a leap year too', () => {
  const node = { scheduleMode: 'monthly', dayOfMonth: 30, timeOfDay: '09:00', timezone: IST };
  assert.equal(daysInMonth(2028, 2), 29, '2028 is a leap year');
  assert.equal(shouldFire(node, {}, at('2028-02-29T04:00:00Z')).fire, true, 'Feb 29 is Feb’s 30th in a leap year');
  assert.equal(shouldFire(node, {}, at('2028-02-28T04:00:00Z')).fire, false);
});

test('monthly on the 1st fires on the 1st', () => {
  const node = { scheduleMode: 'monthly', dayOfMonth: 1, timeOfDay: '09:00', timezone: IST };
  assert.equal(shouldFire(node, {}, at('2026-08-01T04:00:00Z')).fire, true);
  assert.equal(shouldFire(node, {}, at('2026-08-02T04:00:00Z')).fire, false);
});

// ── the timezone-change guard ───────────────────────────────────────────────

test('changing the timezone does NOT re-fire the same day', () => {
  // THE TRAP: last_fired_date was computed in the OLD zone, so it may not equal
  // today's date in the NEW one — and the date check alone would fire again.
  const before = { scheduleMode: 'daily', timeOfDay: '09:00', timezone: 'UTC' };
  const fired = shouldFire(before, {}, at('2026-07-16T09:30:00Z'));
  assert.equal(fired.fire, true);
  const state = { last_fired_date: fired.slotDate, last_fired_at: '2026-07-16T09:30:00Z', last_fired_tz: 'UTC' };

  // Operator switches to Kiritimati (UTC+14). At 20:00Z it is already 10:00 on
  // the 17th there — a different local DATE, and past the 09:00 slot. The date
  // check alone would happily fire again, ~10 hours after the last run.
  const after = { ...before, timezone: 'Pacific/Kiritimati' };
  const now = at('2026-07-16T20:00:00Z');
  assert.equal(partsInTz(now, 'Pacific/Kiritimati').date, '2026-07-17', 'sanity: it really is a different local date');
  assert.notEqual(partsInTz(now, 'Pacific/Kiritimati').date, state.last_fired_date, 'sanity: the stored date looks stale');

  const r = shouldFire(after, state, now);
  assert.equal(r.fire, false, 'a timezone change must not buy a second run');
  assert.equal(r.reason, 'min_gap', 'only the elapsed-time guard can catch this — the date check cannot');
});

test('the min-gap guard still lets a genuine next-day run through', () => {
  const node = { scheduleMode: 'daily', timeOfDay: '09:00', timezone: IST };
  const state = { last_fired_date: '2026-07-16', last_fired_at: '2026-07-16T04:00:00Z', last_fired_tz: IST };
  // 24h later — past the 20h gap and a different local date.
  assert.equal(shouldFire(node, state, at('2026-07-17T04:00:00Z')).fire, true);
});

test('a bad timezone degrades to UTC instead of wedging the sweeper', () => {
  const node = { scheduleMode: 'daily', timeOfDay: '09:00', timezone: 'Not/AZone' };
  const r = shouldFire(node, {}, at('2026-07-16T10:00:00Z'));
  assert.equal(r.fire, true);
  assert.equal(r.slotDate, '2026-07-16');
});

test('isScheduledDay rejects an unknown mode rather than firing daily', () => {
  const parts = partsInTz(at('2026-07-16T04:00:00Z'), IST);
  assert.equal(isScheduledDay({ scheduleMode: 'hourly-ish' }, parts), false);
});
