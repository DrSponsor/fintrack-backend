-- The bank's own identifier for a transaction, when its alert states one.
--
-- Nullable because most rows will never have one: manual entries have no bank
-- record behind them, and not every bank prints a reference.
--
-- Deliberately NOT unique. TimescaleDB requires every unique index to include
-- the partitioning column, so the closest available constraint would be
-- (account_id, provider_ref, transaction_date) — which permits the same
-- reference on two different dates and therefore does not express the rule we
-- want. Uniqueness is enforced in the application instead, the same way the
-- Gmail message id already is. See PrismaTransactionRepository.

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "provider_ref" TEXT;

-- CreateIndex
-- Serves the exact-identity lookup on the ingest path. Leads with account_id
-- because a bank reference is only unique within the bank that issued it.
CREATE INDEX "transactions_account_id_provider_ref_idx" ON "transactions"("account_id", "provider_ref");
