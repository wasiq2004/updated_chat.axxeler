// Subscription expiry sweeper (SaaS billing).
//
// Monthly plans carry a `current_period_end`. When that date passes, the tenant
// enters a grace window (PLAN_GRACE_DAYS); once the grace window is exhausted the
// subscription is suspended and the tenant's features hard-lock.
//
// Feature locking itself is date-driven in services/entitlements.js (source of
// truth, so there's never a window where an expired plan still works). This
// sweeper only keeps `subscriptions.status` in sync so the Super Admin console
// and analytics show the correct billing state:
//
//   active/trialing  --(period end passes)-->  past_due  --(grace ends)-->  suspended
//
// Idempotent and safe to run on every boot and on an interval. A NULL
// current_period_end means "no expiry" (e.g. the bootstrap Enterprise tenant)
// and is never touched.

const GRACE_DAYS = (() => {
  const n = parseInt(process.env.PLAN_GRACE_DAYS ?? '3', 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
})();

async function sweepExpiredSubscriptions(pool) {
  // 1) Past the period end but still inside grace → mark past_due.
  const pastDue = await pool.query(
    `UPDATE coexistence.subscriptions
        SET status = 'past_due', updated_at = NOW()
      WHERE status IN ('active', 'trialing')
        AND current_period_end IS NOT NULL
        AND current_period_end < NOW()`
  );

  // 2) Grace window exhausted → suspend (features are already locked by date).
  const suspended = await pool.query(
    `UPDATE coexistence.subscriptions
        SET status = 'suspended', updated_at = NOW()
      WHERE status IN ('active', 'trialing', 'past_due')
        AND current_period_end IS NOT NULL
        AND current_period_end + make_interval(days => $1) < NOW()`,
    [GRACE_DAYS]
  );

  return { pastDue: pastDue.rowCount, suspended: suspended.rowCount };
}

module.exports = { sweepExpiredSubscriptions, GRACE_DAYS };
