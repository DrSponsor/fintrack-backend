-- DropForeignKey
ALTER TABLE "budget_alerts" DROP CONSTRAINT "budget_alerts_transaction_id_fkey";

-- DropForeignKey
ALTER TABLE "transaction_events" DROP CONSTRAINT "transaction_events_transaction_id_fkey";

-- DropIndex
DROP INDEX "transactions_idempotency_key_key";

-- AlterTable
ALTER TABLE "accounts" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "audit_logs" ALTER COLUMN "id" DROP DEFAULT,
DROP COLUMN "user_id",
ADD COLUMN     "user_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "billing_events" ADD COLUMN     "anonymized_user_id" UUID,
ALTER COLUMN "id" DROP DEFAULT,
DROP COLUMN "user_id",
ADD COLUMN     "user_id" UUID;

-- AlterTable
ALTER TABLE "budget_alerts" ADD COLUMN     "transaction_date" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "budgets" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "categories" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "category_keywords" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "email_access_logs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "merchant_category_maps" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "outbox_events" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "parser_patterns" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "reports" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "subscriptions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "transaction_events" ADD COLUMN     "transaction_date" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ADD CONSTRAINT "transactions_pkey" PRIMARY KEY ("id", "transaction_date");

-- AlterTable
ALTER TABLE "user_merchant_preferences" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "deletion_scheduled_at" TIMESTAMP(3),
ADD COLUMN     "google_id" TEXT,
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "budget_alerts" BOOLEAN NOT NULL DEFAULT true,
    "payment_failures" BOOLEAN NOT NULL DEFAULT true,
    "subscription_expiring" BOOLEAN NOT NULL DEFAULT true,
    "weekly_reports" BOOLEAN NOT NULL DEFAULT true,
    "monthly_reports" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");

-- CreateIndex
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_user_id_key" ON "notification_preferences"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "billing_events_user_id_idx" ON "billing_events"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_idempotency_key_transaction_date_key" ON "transactions"("idempotency_key", "transaction_date");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- AddForeignKey
ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_transaction_id_transaction_date_fkey" FOREIGN KEY ("transaction_id", "transaction_date") REFERENCES "transactions"("id", "transaction_date") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_transaction_id_transaction_date_fkey" FOREIGN KEY ("transaction_id", "transaction_date") REFERENCES "transactions"("id", "transaction_date") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

