-- Switch the plan catalog to INR (this is an Indian platform).
--
-- Three parts:
--   1. The column default flips USD -> INR, so every newly-created plan
--      (including a reseller's own catalog) is INR unless told otherwise.
--   2. Existing rows still marked USD are relabelled INR. There is no payment
--      provider and no FX anywhere in the product (prices are display + seed
--      data only), so this is a relabel, not a conversion.
--   3. The seeded price points are restated in rupees. USD 49 / 149 would read
--      as a nonsensical Rs.49 / Rs.149, so real INR price points are used.
--
-- SAFETY: part 3 only touches rows that STILL hold the original seeded USD
-- amounts (49 / 149). If an operator has already edited a price, their number is
-- left exactly as it is — a migration must never silently overwrite pricing that
-- someone deliberately set.
--
-- Note: migration 063 seeds plans with ON CONFLICT (key) DO NOTHING, so editing
-- 063 would NOT affect an already-migrated database. That is why this runs here.

SET search_path TO coexistence, public;

-- ── 1. New plans default to INR ───────────────────────────────────────────────
ALTER TABLE coexistence.plans ALTER COLUMN currency SET DEFAULT 'INR';

-- ── 2. Relabel existing USD rows ──────────────────────────────────────────────
UPDATE coexistence.plans
   SET currency = 'INR', updated_at = NOW()
 WHERE currency IS NULL OR upper(currency) = 'USD';

-- ── 3. Restate the seeded price points in rupees ───────────────────────────────
-- price_yearly is the ANNUAL total (see platform.js MRR: price_yearly / 12).
-- Yearly = monthly x 12 x 0.8, matching the "Save 20%" offer on the landing page.
-- Guarded on the original seeded amount so customised prices are preserved.
UPDATE coexistence.plans
   SET price_monthly = 3999, price_yearly = 38388, updated_at = NOW()
 WHERE key = 'growth' AND price_monthly = 49;

UPDATE coexistence.plans
   SET price_monthly = 11999, price_yearly = 115188, updated_at = NOW()
 WHERE key = 'professional' AND price_monthly = 149;

-- starter (0 = Free) and enterprise (0 = Custom) carry no amount, so they need
-- no restatement — only the currency relabel above.
