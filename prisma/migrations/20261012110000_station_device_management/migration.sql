ALTER TABLE "display_devices"
ADD COLUMN "token_expires_at" TIMESTAMPTZ(6);

UPDATE "display_devices"
SET "token_expires_at" = COALESCE("paired_at", NOW()) + INTERVAL '30 days'
WHERE "token_expires_at" IS NULL;

ALTER TABLE "display_devices"
ALTER COLUMN "token_expires_at" SET NOT NULL;

CREATE INDEX "display_devices_token_expires_at_revoked_at_idx"
ON "display_devices"("token_expires_at", "revoked_at");
