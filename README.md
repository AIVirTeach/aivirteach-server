# AIVirTeach Backend V1

Local NestJS control plane for the AIVirTeach frontend.

## What V1 includes

- Versioned REST API at `/api/v1`
- Three seeded learner profiles
- Profiles, course catalog, enrollments, progress, practice sessions, lesson completion, dashboard aggregation, and notifications
- A mock AI Teacher endpoint with persistent-in-process chat messages
- Request validation and CORS for the local frontend
- A repository boundary with an in-memory adapter for tests/local fallback and a Prisma/PostgreSQL adapter when DATABASE_URL is set
- A reviewed PostgreSQL target schema in `database/001_initial_schema.sql`

Without DATABASE_URL, Backend V1 uses memory so it runs without Docker. With DATABASE_URL, Nest uses Prisma/PostgreSQL instead.

## PostgreSQL + Prisma

Set DATABASE_URL, then run prisma:generate, prisma migrate deploy, prisma:seed, and start:dev. PostgreSQL is not bundled with this repository; use a local or hosted PostgreSQL instance and do not commit credentials.

## Start locally

Node.js 20 or newer is required. Docker is not required for Backend V1.
This project uses npm. Do not run pnpm or yarn in the backend directory.

```powershell
cd "D:\maic challenge AI digital teacher\backend"
npm install
npm run start:dev
```

The API runs at `http://localhost:4000/api/v1` and the health check is `http://localhost:4000/api/v1/health`.

## Selecting a demo learner

Until real authentication is connected, requests accept an `X-Demo-User-Id` header. If the header is omitted, Alex Chen is used.

Available IDs:

- `learner_beginner`
- `learner_advanced`
- `learner_all_clear`

Example:

```powershell
Invoke-RestMethod -Uri "http://localhost:4000/api/v1/dashboard" -Headers @{ "X-Demo-User-Id" = "learner_beginner" }
```

## Main endpoints

```text
GET    /api/v1/health
GET    /api/v1/demo/users
POST   /api/v1/demo/users
GET    /api/v1/me
PATCH  /api/v1/me
POST   /api/v1/me/reset
GET    /api/v1/courses
GET    /api/v1/courses/:courseId
GET    /api/v1/me/enrollments
POST   /api/v1/courses/:courseId/enroll
GET    /api/v1/dashboard
GET    /api/v1/progress
POST   /api/v1/practice-sessions
POST   /api/v1/lessons/:lessonId/complete
GET    /api/v1/notifications
PATCH  /api/v1/notifications/:notificationId/read
POST   /api/v1/notifications/read-all
GET    /api/v1/chat/threads/:threadId/messages
POST   /api/v1/chat/threads/:threadId/messages
```

## Next milestone

Add hosted PostgreSQL operations, backups, and connection health checks. The current Prisma adapter preserves the controller response contracts; the remaining operational work is provisioning a database and running the migration and seed commands above.
