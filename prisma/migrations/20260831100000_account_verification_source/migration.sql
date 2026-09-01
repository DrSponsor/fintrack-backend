-- What the app actually knows about an account belonging to this user.
--
-- Nothing here is proof of ownership, and the column is a SOURCE rather than a
-- verified boolean so that no part of the system can claim more certainty than
-- it has. EMAIL_DISCOVERY means a bank sent an alert naming this account to
-- this person's connected inbox and the person confirmed it — which a
-- forwarded alert or a shared family inbox still defeats.
CREATE TYPE "AccountVerification" AS ENUM ('SELF_DECLARED', 'EMAIL_DISCOVERY');

ALTER TABLE "accounts"
  ADD COLUMN "account_mask" TEXT,
  ADD COLUMN "holder_name" TEXT,
  ADD COLUMN "verified_at" TIMESTAMP(3),
  ADD COLUMN "verification_source" "AccountVerification" NOT NULL DEFAULT 'SELF_DECLARED';

-- account_last4 becomes optional.
--
-- A discovered account has only what the bank revealed, and Access reveals
-- three digits, not four. Padding to four would invent a digit the bank never
-- gave us — in the exact field used to decide which account an alert belongs
-- to, where a wrong value is invisible once written.
ALTER TABLE "accounts" ALTER COLUMN "account_last4" DROP NOT NULL;
