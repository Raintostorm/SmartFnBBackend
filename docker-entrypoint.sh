#!/bin/sh
set -eu

prisma migrate deploy
prisma db seed

exec node dist/main.js
