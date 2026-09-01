-- An email is read through the user's INBOX, not through one of their accounts.
--
-- Which account an alert concerns is decided from the alert itself, after it
-- has been read and parsed — and for mail the safety gate discards, or mail
-- with no transaction in it, it is never knowable at all. Requiring an account
-- meant inventing one to satisfy the constraint, in the one table whose
-- purpose is to tell the user truthfully which of their emails were read.
ALTER TABLE "email_access_logs" ALTER COLUMN "account_id" DROP NOT NULL;
