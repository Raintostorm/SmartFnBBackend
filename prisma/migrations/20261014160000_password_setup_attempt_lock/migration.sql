CREATE TABLE "password_setup_attempts" (
    "subject_hash" VARCHAR(64) NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "password_setup_attempts_pkey" PRIMARY KEY ("subject_hash")
);

CREATE INDEX "password_setup_attempts_locked_until_idx"
ON "password_setup_attempts"("locked_until");
