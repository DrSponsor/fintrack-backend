-- CreateEnum
CREATE TYPE "EmailAccessOutcome" AS ENUM ('TRANSACTION_CREATED', 'DUPLICATE_SUPPRESSED', 'DISCARDED_SAFETY_FILTER', 'DISCARDED_NO_KEYWORDS', 'PARSE_FAILED');

-- CreateTable
CREATE TABLE "email_access_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "message_id" TEXT NOT NULL,
  "sender_domain" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "outcome" "EmailAccessOutcome" NOT NULL,
  "accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_access_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "email_access_logs_user_id_accessed_at_idx" ON "email_access_logs"("user_id", "accessed_at");

ALTER TABLE "email_access_logs" ADD CONSTRAINT "email_access_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "email_access_logs" ADD CONSTRAINT "email_access_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
