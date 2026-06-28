-- Meeting-level client chosen at upload (Meetsy never predicts the client).
-- Additive + nullable; meetsy schema only (never public).
ALTER TABLE "meetsy"."Meeting" ADD COLUMN "client_option_id" TEXT, ADD COLUMN "client_name" TEXT;
