-- Links the two sides of money moved between a user's own accounts.
--
-- Both rows are kept: each is a real alert from a different bank and each is
-- true from that bank's point of view. What is wrong is counting one as income
-- and the other as spending, so aggregates skip any row carrying a group.
ALTER TABLE "transactions" ADD COLUMN "transfer_group_id" UUID;

-- Serves "fetch the other side of this transfer". Non-unique, so it does not
-- need the partition key the way a unique index on a hypertable would.
CREATE INDEX "transactions_transfer_group_id_idx" ON "transactions"("transfer_group_id");
