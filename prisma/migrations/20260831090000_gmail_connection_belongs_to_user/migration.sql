-- Moves the Gmail connection from Account to User.
--
-- It lived on Account as gmail_connected + gmail_token_enc, which was wrong in
-- three ways. A user with three accounts alerting to one inbox stored the same
-- refresh token three times, so revoking was three writes that could half-fail.
-- The webhook fanned one notification into one job per account, multiplying
-- Gmail quota and parsing. And an account had to EXIST before its inbox could
-- be connected, forcing someone to type a bank name and four digits before the
-- app had any way to check them.
--
-- The old columns are deliberately LEFT IN PLACE. This migration copies rather
-- than moves, so a failure anywhere in the new path leaves the old one intact
-- and reversible. They are dropped in a follow-up migration once capture has
-- been observed working through the connection.

CREATE TABLE "gmail_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email_address" TEXT NOT NULL,
    "token_enc" TEXT NOT NULL,
    "history_id" TEXT,
    "watch_expires_at" TIMESTAMP(3),
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gmail_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gmail_connections_user_id_key" ON "gmail_connections"("user_id");
CREATE INDEX "gmail_connections_email_address_idx" ON "gmail_connections"("email_address");

ALTER TABLE "gmail_connections"
  ADD CONSTRAINT "gmail_connections_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry existing connections across.
--
-- DISTINCT ON collapses a user's several connected accounts into one row,
-- which is the point of the move: they were always the same inbox stored
-- repeatedly. The oldest account wins, arbitrary but deterministic, and any
-- of them holds the same token.
--
-- email_address takes users.email because that is what the system believes
-- today — the webhook resolves a push notification by matching it. That
-- assumption is itself a bug the new connect flow fixes by recording the
-- address Google actually authorised, which need not be the signup address.
INSERT INTO "gmail_connections" ("id", "user_id", "email_address", "token_enc", "connected_at")
SELECT DISTINCT ON (a."user_id")
  gen_random_uuid(),
  a."user_id",
  u."email",
  a."gmail_token_enc",
  NOW()
FROM "accounts" a
JOIN "users" u ON u."id" = a."user_id"
WHERE a."gmail_connected" = true
  AND a."gmail_token_enc" IS NOT NULL
ORDER BY a."user_id", a."id";
