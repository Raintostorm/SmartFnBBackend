#!/bin/sh
set -eu

prisma migrate deploy

if [ "${RUN_DEMO_SEED:-false}" = "true" ]; then
  prisma db seed
fi

exec node dist/main.js
