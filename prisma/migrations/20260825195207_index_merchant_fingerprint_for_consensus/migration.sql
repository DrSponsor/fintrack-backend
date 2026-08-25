-- Consensus is counted by fingerprint across ALL users:
--   SELECT category_id, COUNT(*) FROM user_merchant_preferences
--   WHERE merchant_fingerprint = $1 GROUP BY category_id
--
-- The existing unique index leads with user_id, so it cannot serve a query
-- filtered on merchant_fingerprint alone. Without this index every category
-- correction would sequentially scan the whole preferences table.
CREATE INDEX "user_merchant_preferences_merchant_fingerprint_idx" ON "user_merchant_preferences"("merchant_fingerprint");
