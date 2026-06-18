-- 1. Drop foreign key constraints on referencing tables
ALTER TABLE "transaction_events" DROP CONSTRAINT IF EXISTS "transaction_events_transaction_id_fkey";
ALTER TABLE "budget_alerts" DROP CONSTRAINT IF EXISTS "budget_alerts_transaction_id_fkey";

-- 2. Drop existing primary key and unique constraints on transactions
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_pkey";
DROP INDEX IF EXISTS "transactions_idempotency_key_key";

-- 3. Add transaction_date columns to referencing tables as nullable first
ALTER TABLE "transaction_events" ADD COLUMN IF NOT EXISTS "transaction_date" TIMESTAMP(3);
ALTER TABLE "budget_alerts" ADD COLUMN IF NOT EXISTS "transaction_date" TIMESTAMP(3);

-- 4. Backfill transaction_date from transactions table
UPDATE "transaction_events" te
SET "transaction_date" = t."transaction_date"
FROM "transactions" t
WHERE te."transaction_id" = t."id" AND te."transaction_date" IS NULL;

UPDATE "budget_alerts" ba
SET "transaction_date" = t."transaction_date"
FROM "transactions" t
WHERE ba."transaction_id" = t."id" AND ba."transaction_date" IS NULL;

-- 5. Enforce NOT NULL on the columns
ALTER TABLE "transaction_events" ALTER COLUMN "transaction_date" SET NOT NULL;
ALTER TABLE "budget_alerts" ALTER COLUMN "transaction_date" SET NOT NULL;

-- 6. Re-create composite primary key on transactions
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_pkey" PRIMARY KEY ("id", "transaction_date");

-- 7. Re-create composite unique index on transactions
CREATE UNIQUE INDEX "transactions_idempotency_key_transaction_date_key" ON "transactions"("idempotency_key", "transaction_date");

-- 8. Re-create foreign keys pointing to composite primary key
ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_transaction_id_transaction_date_fkey" 
    FOREIGN KEY ("transaction_id", "transaction_date") REFERENCES "transactions"("id", "transaction_date") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_transaction_id_transaction_date_fkey" 
    FOREIGN KEY ("transaction_id", "transaction_date") REFERENCES "transactions"("id", "transaction_date") ON DELETE CASCADE ON UPDATE CASCADE;

-- 9. Convert transactions into TimescaleDB hypertable
SELECT create_hypertable('transactions', 'transaction_date', migrate_data => true, if_not_exists => true);
