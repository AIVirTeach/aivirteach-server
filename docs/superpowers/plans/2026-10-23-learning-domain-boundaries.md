# Learning domain boundaries and implementation status

Status: the explicit chat-context work in server PRs #35–#37 and client PR #23 is merged. This branch implements the backend two-table learning-state refactor. Client PR #24 must adapt to the finalized snapshot/restart contracts. The older PRs #34 and #22 remain draft source records. The user confirmed deployment is manual; no deployment was requested for this work.

## Ownership and invariants

Course content owns drafts, immutable published versions and stable lesson IDs. Learning owns enrollment, generation, reading position, completion and historical achievements. Assessment owns attempts and PASS evidence. Chat owns questions, replies and explicit context. Labs owns execution and environment lifecycle.

1. Every chat request supplies courseVersionId, lessonId and generation. Never infer context from reading position, completion percentage or previous messages.
2. Client identifiers express intent. The server checks ownership and version membership and loads trusted lesson instructions.
3. Reading, completion and assessment are independent commands. Chat does not mutate learning state.
4. An accepted question retains its version and lesson throughout execution. Publication does not replace its context.
5. Check generation before accepting work and before saving results. Old responses cannot enter a restarted learning session.
6. Agent calls run outside database transactions. Use short transactions around acceptance and finalization.
7. Invalid or stale context produces an explicit error. Never fall back to the first lesson or latest version.
8. Streaming and ordinary chat share validation, context construction and persistence rules.
9. Migrate callers and remove obsolete endpoints when the coordinated client/server contract is ready.
10. Passing builds does not establish browser or production acceptance.

## Backend learning state

The learning domain has two tables: `Enrollment` for mutable current state and `LearningSnapshot` for immutable saved state. `Enrollment.learningState` schema version 1 is:

```json
{
  "schemaVersion": 1,
  "readingLessonId": "stable-content-id-or-null",
  "lessons": {
    "stable-content-id": {
      "completedAt": "ISO timestamp or null",
      "firstCompletedAt": "ISO timestamp or null"
    }
  },
  "completedAt": "first course completion timestamp or null"
}
```

JSON is parsed once at the database boundary and changed only through typed learning transitions. `progressRevision` advances for reading, completion and publication remaps so a snapshot command binds the entire current state. Restart increments generation and resets revision to zero.

A manual snapshot request is `POST /courses/:slug/snapshots` with `{ requestId, generation, revision, courseVersionId }`. The handler locks the published course, reads the actual latest published version inside the transaction, locks the owned enrollment and saves a coherent state. An identical retry returns the original snapshot; reusing a request ID for different command values returns a conflict.

`GET /courses/:slug/snapshots` returns `{ items, nextCursor }` with at most 50 summary rows. Each summary includes the pinned version and lesson titles/counts; `schemaVersion: 0` legacy records are marked incomplete and omit invented progress. `GET /courses/:slug/snapshots/:snapshotId` returns state with the pinned syllabus. There is no restore endpoint.

`POST /courses/:slug/restart` requires `{ requestId, generation, revision, courseVersionId }`, with a UUID request ID. The restart snapshot and state reset share a transaction. Exact retries do not repeat quota settlement, snapshot creation or generation changes. Workspace cleanup remains retryable after commit.

The first course completion writes one `COMPLETED` snapshot per generation. Manual saves use `MANUAL`; restart saves use `RESTART`. Existing deployed `Enrollment.completedAt` values are retained as `LEGACY_ACHIEVEMENT` records with `completeStateAvailable: false`; the migration does not invent lesson completion details. `EnrollmentCompletion` has no runtime consumer. The migration aborts before mutation if the placeholder table is unexpectedly populated.

The configured Neon migration metadata reports `20261010000000` as the latest applied migration; no 20261023 migration is applied. The configured database has zero `EnrollmentCompletion` rows. These checks do not independently verify provider migration/deployment state. The user confirmed there has been no deployment or migration rollout for this change.

## HTTP behavior and verification

Completion remains `PUT /courses/:slug/lessons/:lessonId/progress`; reading remains `PUT /courses/:slug/reading-position`. Both retain the generation and course-version fences. Completion also requires revision. Identical completion retries do not add revisions or activities. Reading advances revision only when the position changes. Achievement history is projected from immutable completion snapshots plus the current generation state.

The backend test slice covers typed state transitions, shared progress projection, dashboard and enrollment projections, completion/retry/unmark behavior, revision conflicts, stable-ID publication changes, manual snapshot ownership/idempotency/immutability/version pinning, bounded pagination, completion and restart snapshots, quota settlement, and reset retry behavior. Migration validation covers a fresh schema, upgrade from the configured deployed baseline, timestamp preservation, stable bookmark fallback, no fabricated history, and atomic failure for nonempty `EnrollmentCompletion`.

Browser flows, real Labs/VM behavior, coordinated release, and production acceptance remain unverified. Deployment remains manual per the user's confirmation.
