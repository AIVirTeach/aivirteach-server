#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgresql://aivirteach@127.0.0.1:55439/aivirteach_4b}"
export JWT_SECRET="${JWT_SECRET:-local-admin-editor-test-secret-32-characters}"
node -e 'const u=new URL(process.env.DATABASE_URL); if(u.hostname!=="127.0.0.1" || u.pathname!=="/aivirteach_4b") throw Error("Use dedicated local aivirteach_4b database")'
npm run build -w @aivirteach/lesson-blocks -w @aivirteach/admin-contract
npx prisma generate --schema apps/api/prisma/schema.prisma
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
npm test
npm run test:e2e -w api -- --runInBand
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/admin/tsconfig.json
npm run build -w api
npm run build -w admin
if [[ "${1:-}" == "--browser" ]]; then
  npx playwright test --config apps/admin/playwright.config.ts
else
  echo "Browser verification skipped. Run with --browser only when authorized and local services are ready."
fi
