CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "timescaledb";

CREATE TYPE "Tier" AS ENUM ('FREE', 'PRO');
CREATE TYPE "AccountType" AS ENUM ('CURRENT', 'SAVINGS', 'WALLET');
CREATE TYPE "CaptureMethod" AS ENUM ('EMAIL', 'MANUAL', 'SMS', 'MONO');
CREATE TYPE "TransactionType" AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE "CaptureSource" AS ENUM ('EMAIL', 'MANUAL', 'SMS', 'MONO');
CREATE TYPE "PeriodType" AS ENUM ('WEEKLY', 'MONTHLY');
CREATE TYPE "PatternStatus" AS ENUM ('LEARNING', 'STABLE');
CREATE TYPE "BillingProvider" AS ENUM ('PAYSTACK', 'MONNIFY');
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'GRACE_PERIOD', 'CANCELLED', 'EXPIRED');
CREATE TYPE "MerchantMappingSource" AS ENUM ('SEEDED', 'USER_CORRECTION', 'AI_CONFIRMED');

CREATE TABLE "users" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "password_hash" TEXT NOT NULL,
  "tier" "Tier" NOT NULL DEFAULT 'FREE',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "accounts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "bank_name" TEXT NOT NULL,
  "account_last4" TEXT NOT NULL,
  "account_type" "AccountType" NOT NULL,
  "capture_method" "CaptureMethod" NOT NULL,
  "gmail_connected" BOOLEAN NOT NULL DEFAULT false,
  "gmail_token_enc" TEXT,
  "balance_kobo" BIGINT NOT NULL DEFAULT 0,
  "last_transaction_date" TIMESTAMP(3),
  CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "categories" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "icon" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transactions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "account_id" UUID NOT NULL,
  "amount_kobo" BIGINT NOT NULL,
  "type" "TransactionType" NOT NULL,
  "merchant_name" TEXT NOT NULL,
  "category_id" UUID NOT NULL,
  "transaction_date" TIMESTAMP(3) NOT NULL,
  "source" "CaptureSource" NOT NULL,
  "parser_id" UUID,
  "raw_snippet_enc" TEXT,
  "is_verified" BOOLEAN NOT NULL DEFAULT false,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "transaction_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "transaction_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "previous_hash" TEXT NOT NULL,
  "hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "transaction_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "budget_alerts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "transaction_id" UUID NOT NULL,
  "budget_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "budget_alerts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "category_keywords" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "category_id" UUID NOT NULL,
  "keyword" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "category_keywords_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "merchant_category_maps" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "merchant_fingerprint" TEXT NOT NULL,
  "category_id" UUID NOT NULL,
  "source" "MerchantMappingSource" NOT NULL DEFAULT 'SEEDED',
  "confidence" INTEGER NOT NULL DEFAULT 100,
  "confirmed_by_users" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "merchant_category_maps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_merchant_preferences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "merchant_fingerprint" TEXT NOT NULL,
  "category_id" UUID NOT NULL,
  "correction_count" INTEGER NOT NULL DEFAULT 1,
  "last_corrected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_merchant_preferences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "budgets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "category_id" UUID NOT NULL,
  "limit_kobo" BIGINT NOT NULL,
  "period_type" "PeriodType" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "parser_patterns" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "sender_domain" TEXT NOT NULL,
  "bank_name" TEXT NOT NULL,
  "status" "PatternStatus" NOT NULL,
  "patterns" JSONB NOT NULL,
  "ai_generated" BOOLEAN NOT NULL,
  "confirmed_by_users" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1,
  "last_validated" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "parser_patterns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reports" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "period_type" "PeriodType" NOT NULL,
  "period_start" TIMESTAMP(3) NOT NULL,
  "period_end" TIMESTAMP(3) NOT NULL,
  "is_stale" BOOLEAN NOT NULL DEFAULT false,
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "data" JSONB NOT NULL,
  "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "request_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "resource_type" TEXT NOT NULL,
  "resource_id" TEXT NOT NULL,
  "ip_address" TEXT NOT NULL,
  "user_agent" TEXT NOT NULL,
  "metadata" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscriptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "provider" "BillingProvider" NOT NULL,
  "provider_customer_id" TEXT NOT NULL,
  "provider_subscription_id" TEXT NOT NULL,
  "provider_plan_id" TEXT NOT NULL,
  "status" "SubscriptionStatus" NOT NULL,
  "current_period_start" TIMESTAMP(3) NOT NULL,
  "current_period_end" TIMESTAMP(3) NOT NULL,
  "cancelled_at" TIMESTAMP(3),
  "grace_period_ends_at" TIMESTAMP(3),
  "trial_ends_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "billing_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "provider" "BillingProvider" NOT NULL,
  "provider_event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "normalized_type" TEXT NOT NULL,
  "user_id" TEXT,
  "payload" JSONB NOT NULL,
  "processed" BOOLEAN NOT NULL DEFAULT false,
  "processed_at" TIMESTAMP(3),
  "processing_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbox_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");
CREATE UNIQUE INDEX "transactions_idempotency_key_key" ON "transactions"("idempotency_key");
CREATE INDEX "transactions_account_id_transaction_date_idx" ON "transactions"("account_id", "transaction_date");
CREATE INDEX "transactions_category_id_transaction_date_idx" ON "transactions"("category_id", "transaction_date");
CREATE INDEX "transaction_events_transaction_id_created_at_idx" ON "transaction_events"("transaction_id", "created_at");
CREATE UNIQUE INDEX "budget_alerts_transaction_id_budget_id_key" ON "budget_alerts"("transaction_id", "budget_id");
CREATE INDEX "budget_alerts_user_id_idx" ON "budget_alerts"("user_id");
CREATE UNIQUE INDEX "category_keywords_category_id_keyword_key" ON "category_keywords"("category_id", "keyword");
CREATE INDEX "category_keywords_keyword_idx" ON "category_keywords"("keyword");
CREATE UNIQUE INDEX "merchant_category_maps_merchant_fingerprint_key" ON "merchant_category_maps"("merchant_fingerprint");
CREATE INDEX "merchant_category_maps_category_id_idx" ON "merchant_category_maps"("category_id");
CREATE UNIQUE INDEX "user_merchant_preferences_user_id_merchant_fingerprint_key" ON "user_merchant_preferences"("user_id", "merchant_fingerprint");
CREATE INDEX "user_merchant_preferences_category_id_idx" ON "user_merchant_preferences"("category_id");
CREATE INDEX "budgets_user_id_period_type_idx" ON "budgets"("user_id", "period_type");
CREATE INDEX "budgets_category_id_idx" ON "budgets"("category_id");
CREATE UNIQUE INDEX "parser_patterns_sender_domain_key" ON "parser_patterns"("sender_domain");
CREATE UNIQUE INDEX "reports_user_id_period_type_period_start_key" ON "reports"("user_id", "period_type", "period_start");
CREATE INDEX "reports_user_id_period_type_idx" ON "reports"("user_id", "period_type");
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");
CREATE UNIQUE INDEX "subscriptions_user_id_key" ON "subscriptions"("user_id");
CREATE UNIQUE INDEX "subscriptions_provider_subscription_id_key" ON "subscriptions"("provider_subscription_id");
CREATE INDEX "subscriptions_status_grace_period_ends_at_idx" ON "subscriptions"("status", "grace_period_ends_at");
CREATE UNIQUE INDEX "billing_events_provider_event_id_key" ON "billing_events"("provider_event_id");
CREATE INDEX "billing_events_user_id_idx" ON "billing_events"("user_id");
CREATE INDEX "billing_events_processed_created_at_idx" ON "billing_events"("processed", "created_at");
CREATE INDEX "outbox_events_published_at_attempts_idx" ON "outbox_events"("published_at", "attempts");

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_budget_id_fkey" FOREIGN KEY ("budget_id") REFERENCES "budgets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "category_keywords" ADD CONSTRAINT "category_keywords_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "merchant_category_maps" ADD CONSTRAINT "merchant_category_maps_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_merchant_preferences" ADD CONSTRAINT "user_merchant_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_merchant_preferences" ADD CONSTRAINT "user_merchant_preferences_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
