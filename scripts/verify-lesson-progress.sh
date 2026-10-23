#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgresql://aivirteach@127.0.0.1:55440/aivirteach_progress}"
export JWT_SECRET="${JWT_SECRET:-local-progress-test-secret-at-least-32-chars}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/private/tmp/aivirteach-progress-cache}"
node -e 'const u=new URL(process.env.DATABASE_URL); if(u.hostname!=="127.0.0.1" || u.pathname!=="/aivirteach_progress") throw Error("Use dedicated local aivirteach_progress database")'
npx prisma generate --schema apps/api/prisma/schema.prisma
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
npm run test -w api -- --runInBand enrollments dashboard
npm run test:e2e -w api -- --runInBand lesson-progress enrollments-restart
npm run build -w api
