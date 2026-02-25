-- Add isAvailable and title fields to Staff table
ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS "isAvailable" BOOLEAN DEFAULT true;
ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS "title" VARCHAR(50);
