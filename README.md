# AIVirTeach Backend V1

Local NestJS control plane for the AIVirTeach frontend.

## What V1 includes

- Versioned REST API at `/api/v1`
- Three seeded learner profiles
- Profiles, course catalog, enrollments, progress, practice sessions, lesson completion, dashboard aggregation, and notifications
- A course-aware AI Teacher backed by the private Labs Agent, with server-owned chat history
- Learner-scoped browser RDP session launch through the Labs runtime and Apache Guacamole
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

The API binds to `127.0.0.1` by default and runs at `http://localhost:4000/api/v1`; the health check is `http://localhost:4000/api/v1/health`. Set `HOST` explicitly only when another interface must reach the development server.

## Browser learning lab sessions

The backend owns the learner-to-VM mapping and mints browser sessions through the separate Labs runtime. Configure the server-only values below in `.env`:

```dotenv
LEARNER_LAB_MAP='{"learner_advanced":"lab-001"}'
LABS_API_BASE_URL=http://127.0.0.1:8760
LABS_SESSION_TOKEN=replace-with-the-labs-browser-session-token
GUACAMOLE_PUBLIC_PATH=/guacamole/
```

`LEARNER_LAB_MAP` must be a JSON object whose keys are learner IDs and whose values are Labs VM IDs. Never send the Labs token or VM credentials to the frontend. `GUACAMOLE_PUBLIC_PATH` should be the same-origin reverse-proxy path that serves Apache Guacamole.

The frontend calls `POST /api/v1/me/lab/session` without supplying a VM ID. The backend selects the current learner's assignment and returns either a short polling response or an opaque Guacamole URL:

```json
{ "state": "starting", "retryAfterMs": 2500 }
```

```json
{ "state": "ready", "embedUrl": "/guacamole/?data=...", "expiresAt": 1800000000000 }
```

Session responses use `Cache-Control: private, no-store`. The Labs runtime must expose its browser-session endpoint on a private or loopback address, and `/guacamole/` must be reverse-proxied with streaming/WebSocket support.

## AI Teacher and Labs Agent

Chat stays behind the backend: the browser sends the question plus optional current `courseId` and `lessonId` identifiers to the existing chat endpoint. It never sends course content or a `lab_id`, and never receives the Agent token, diagnostic token, or VM credentials. Configure these server-only values in `.env`:

```dotenv
LABS_AGENT_BASE_URL=http://127.0.0.1:8770
LABS_AGENT_TOKEN=replace-with-the-labs-agent-token
LABS_AGENT_TIMEOUT_MS=45000
LABS_AGENT_WORKSPACE_ROOT=/home/learner/course
```

`LABS_AGENT_TOKEN` must contain the same secret configured as `AIVIRTEACH_AGENT_TOKEN` on the Labs Agent service. The default 45-second server timeout is slightly longer than the Agent's default 40-second overall diagnosis limit; accepted values are 1000–120000 milliseconds. `LABS_AGENT_WORKSPACE_ROOT` must be an absolute guest path allowed by the Diagnostic Gateway.

For every POST, the backend performs this ordered flow:

1. It verifies the learner, active enrollment, assigned VM, and server-owned chat-thread namespace.
2. It verifies the selected course and lesson against the active enrollment and server course catalog. Older `{ "text": "..." }` requests fall back to a progress-derived lesson.
3. It persists the learner message by itself.
4. It calls `POST /v1/agent/diagnose` on port 8770 with up to eight previously stored messages.
5. Only after a valid Agent response, it persists and returns the tutor answer.

If the Agent times out or is unavailable, the endpoint returns HTTP 503. If the Agent rejects the backend payload or returns an invalid response, it returns HTTP 502. In both cases the learner message remains in server history and no fabricated tutor response is stored. `GET /api/v1/chat/threads/:threadId/messages` always reads the backend repository and never calls the Agent.

The Labs Agent and its Diagnostic Gateway must be running separately. When all processes run directly on the same Ubuntu host, the default loopback URLs are appropriate. If this backend runs in a container, replace `127.0.0.1` with a private address or service name reachable from that container; do not publish the Agent endpoint to browsers.

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
POST   /api/v1/me/lab/session
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
