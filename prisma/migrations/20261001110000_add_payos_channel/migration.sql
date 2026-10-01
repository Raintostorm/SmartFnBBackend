CREATE TABLE "payos_channels" (
    "id" UUID NOT NULL,
    "chain_id" UUID NOT NULL,
    "client_id_cipher" TEXT NOT NULL,
    "api_key_cipher" TEXT NOT NULL,
    "checksum_key_cipher" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "payos_channels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payos_channels_chain_id_key" ON "payos_channels"("chain_id");

ALTER TABLE "payos_channels"
ADD CONSTRAINT "payos_channels_chain_id_fkey"
FOREIGN KEY ("chain_id") REFERENCES "restaurant_chains"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
