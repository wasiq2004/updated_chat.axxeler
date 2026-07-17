// Scheduled-trigger timing. Pure functions, no DB, no clock of their own — the
// caller passes `now`, so every rule here is testable.
//
// THE MODEL: compare a wall-clock DATE STRING in the trigger's own timezone.
//
// "Has today's slot already fired?" is `lastFiredDate === todayInTz`. That needs
// no UTC/DST arithmetic — Intl does the zone conversion — and once the date is
// stored, firing twice in a day is structurally impossible rather than merely
// unlikely. Everything else (weekday, day-of-month, month-end) is decided on
// those same local parts.

// 'YYYY-MM-DD' in the given IANA zone. en-CA because it formats exactly that way.
function dateInTz(date, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    // A bad timezone must not wedge the sweeper. UTC is wrong but predictable.
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }
}

// The local wall-clock parts we schedule against.
function partsInTz(date, tz) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short',
    });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short',
    });
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(p.year, 10),
    month: parseInt(p.month, 10),
    day: parseInt(p.day, 10),
    // 'en-US' hour12:false yields '24' at midnight, not '00'.
    hour: parseInt(p.hour, 10) % 24,
    minute: parseInt(p.minute, 10),
    weekday: WD[p.weekday] ?? 0,
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

function daysInMonth(year, month /* 1-12 */) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "09:30" -> { hour: 9, minute: 30 }. Defaults to 09:00 on nonsense. */
function parseTimeOfDay(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hour: 9, minute: 0 };
  const hour = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const minute = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return { hour, minute };
}

/**
 * Is today a day this schedule runs on?
 *
 *   daily    — always
 *   weekly   — node.weekdays: [1,3,5] (0=Sun)
 *   monthly  — node.dayOfMonth: 1..31, CLAMPED to the month's length so the 31st
 *              still fires on Feb 28. Without the clamp, a monthly schedule set
 *              to the 31st would skip February, April, June, September and
 *              November — silently, forever.
 */
function isScheduledDay(node, parts) {
  const mode = node.scheduleMode || 'daily';
  if (mode === 'daily') return true;
  if (mode === 'weekly') {
    const days = Array.isArray(node.weekdays) ? node.weekdays.map(Number) : [];
    return days.includes(parts.weekday);
  }
  if (mode === 'monthly') {
    const want = Math.min(Math.max(parseInt(node.dayOfMonth, 10) || 1, 1), 31);
    const clamped = Math.min(want, daysInMonth(parts.year, parts.month));
    return parts.day === clamped;
  }
  return false;
}

/** Has the time-of-day already passed, in the trigger's zone? */
function timeHasPassed(node, parts) {
  const { hour, minute } = parseTimeOfDay(node.timeOfDay);
  return parts.hour > hour || (parts.hour === hour && parts.minute >= minute);
}

// A timezone change makes the stored date meaningless — it's in the OLD zone, so
// it can look stale and re-fire the same day. These modes fire at most once a
// day anyway, so refusing to fire twice within this window costs nothing real
// and closes the hole.
const MIN_GAP_MS = 20 * 60 * 60 * 1000; // 20h

/**
 * Should this schedule fire right now?
 *
 * Fires when: the time-of-day has passed AND today is a scheduled day AND
 * today's slot hasn't already fired.
 *
 * @param state { last_fired_date, last_fired_at, last_fired_tz }
 * @returns { fire: boolean, reason: string, slotDate: string }
 */
function shouldFire(node, state, now = new Date()) {
  const tz = node.timezone || 'Asia/Kolkata';
  const parts = partsInTz(now, tz);
  const slotDate = parts.date;

  if (!isScheduledDay(node, parts)) return { fire: false, reason: 'not_a_scheduled_day', slotDate };
  if (!timeHasPassed(node, parts)) return { fire: false, reason: 'too_early', slotDate };
  if (state?.last_fired_date === slotDate) return { fire: false, reason: 'already_fired_today', slotDate };

  // The timezone-change guard. If the stored date was computed in a DIFFERENT
  // zone it may not equal today's date here even though we just fired — so fall
  // back to elapsed time.
  if (state?.last_fired_at) {
    const elapsed = now.getTime() - new Date(state.last_fired_at).getTime();
    if (elapsed < MIN_GAP_MS) {
      return { fire: false, reason: 'min_gap', slotDate };
    }
  }
  return { fire: true, reason: 'due', slotDate };
}

/**
 * What to seed `last_fired_date` with when a schedule is ACTIVATED.
 *
 * THE TRAP: marking today's slot done unconditionally silently skips the first
 * run — a whole week for a weekly, a MONTH for a monthly, with no error and no
 * way to tell it's happening. So suppress today's slot only if its time has
 * ALREADY GONE BY; if it's still ahead, seed null and let it fire today.
 *
 * @returns the date string to store, or null to fire today.
 */
function seedFiredDate(node, now = new Date()) {
  const tz = node.timezone || 'Asia/Kolkata';
  const parts = partsInTz(now, tz);
  if (!isScheduledDay(node, parts)) return null;   // nothing to suppress today
  return timeHasPassed(node, parts) ? parts.date : null;
}

module.exports = {
  dateInTz,
  partsInTz,
  parseTimeOfDay,
  isScheduledDay,
  timeHasPassed,
  shouldFire,
  seedFiredDate,
  daysInMonth,
  MIN_GAP_MS,
};
