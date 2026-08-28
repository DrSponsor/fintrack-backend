-- Adds the label a person actually reads on a ledger row.
--
-- Written by hand rather than taken from `migrate diff`, which emits a single
-- ADD COLUMN ... NOT NULL. That statement fails outright on a populated table:
-- there is no default, so every existing row would violate the constraint the
-- moment it is added. The three-step form below is the standard way to add a
-- required column to a table that already has data — widen, fill, then
-- constrain — and it is safe to run on a live table.

-- 1. Nullable, so existing rows are legal while we fill them.
ALTER TABLE "categories" ADD COLUMN "display_name" TEXT;

-- 2. Backfill. Keyed on the slug, which is unique and is what the seed uses.
UPDATE "categories" SET "display_name" = CASE "name"
  WHEN 'uncategorised'  THEN 'Uncategorised'
  WHEN 'food-groceries' THEN 'Food & groceries'
  WHEN 'transport'      THEN 'Transport'
  WHEN 'airtime-data'   THEN 'Airtime & data'
  WHEN 'utilities'      THEN 'Utilities'
  WHEN 'entertainment'  THEN 'Entertainment'
  WHEN 'health'         THEN 'Health'
  WHEN 'education'      THEN 'Education'
  WHEN 'shopping'       THEN 'Shopping'
  WHEN 'transfers'      THEN 'Transfers'
  WHEN 'subscriptions'  THEN 'Subscriptions'
  WHEN 'rent'           THEN 'Rent'
  WHEN 'salary'         THEN 'Salary'
  WHEN 'fees-charges'   THEN 'Fees & charges'
  WHEN 'investments'    THEN 'Investments'
  WHEN 'business'       THEN 'Business'
  -- Anything added to the table but not to this list still gets a usable
  -- label rather than blocking the migration: the slug with separators
  -- turned back into spaces. It will read a little flat, which is the point
  -- — it is visible, so it gets fixed.
  ELSE initcap(replace("name", '-', ' '))
END;

-- 3. Now that every row has one, require it.
ALTER TABLE "categories" ALTER COLUMN "display_name" SET NOT NULL;
