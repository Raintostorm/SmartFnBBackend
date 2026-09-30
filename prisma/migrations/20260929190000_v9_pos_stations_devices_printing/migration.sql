CREATE TYPE "PosStationStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "PrinterConnectionType" AS ENUM ('NONE', 'WIFI', 'BLUETOOTH');
CREATE TYPE "DisplayDeviceType" AS ENUM ('CUSTOMER_DISPLAY', 'CALLING_DISPLAY');
CREATE TYPE "PrintJobStatus" AS ENUM ('PENDING', 'PRINTED', 'FAILED');

CREATE TABLE "pos_stations" (
  "id" UUID NOT NULL,
  "branch_id" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "status" "PosStationStatus" NOT NULL DEFAULT 'ACTIVE',
  "printer_connection" "PrinterConnectionType" NOT NULL DEFAULT 'NONE',
  "printer_address" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "pos_stations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pairing_codes" (
  "id" UUID NOT NULL,
  "code_hash" VARCHAR(64) NOT NULL,
  "device_type" "DisplayDeviceType" NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pairing_codes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "display_devices" (
  "id" UUID NOT NULL,
  "type" "DisplayDeviceType" NOT NULL,
  "branch_id" UUID NOT NULL,
  "station_id" UUID,
  "token_hash" VARCHAR(64) NOT NULL,
  "name" VARCHAR(150),
  "paired_by_id" UUID NOT NULL,
  "paired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "display_devices_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "print_jobs"
ADD COLUMN "station_id" UUID,
ADD COLUMN "status" "PrintJobStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "error_message" VARCHAR(500);

ALTER TABLE "print_jobs" ALTER COLUMN "printed_at" DROP DEFAULT;
ALTER TABLE "print_jobs" ALTER COLUMN "printed_at" DROP NOT NULL;

CREATE UNIQUE INDEX "pos_stations_branch_id_name_key" ON "pos_stations"("branch_id", "name");
CREATE INDEX "pos_stations_branch_id_status_idx" ON "pos_stations"("branch_id", "status");
CREATE UNIQUE INDEX "pairing_codes_code_hash_key" ON "pairing_codes"("code_hash");
CREATE INDEX "pairing_codes_expires_at_consumed_at_idx" ON "pairing_codes"("expires_at", "consumed_at");
CREATE UNIQUE INDEX "display_devices_token_hash_key" ON "display_devices"("token_hash");
CREATE INDEX "display_devices_branch_id_type_revoked_at_idx" ON "display_devices"("branch_id", "type", "revoked_at");
CREATE INDEX "display_devices_station_id_revoked_at_idx" ON "display_devices"("station_id", "revoked_at");

ALTER TABLE "pos_stations" ADD CONSTRAINT "pos_stations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "display_devices" ADD CONSTRAINT "display_devices_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "display_devices" ADD CONSTRAINT "display_devices_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "pos_stations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "display_devices" ADD CONSTRAINT "display_devices_paired_by_id_fkey" FOREIGN KEY ("paired_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "pos_stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
