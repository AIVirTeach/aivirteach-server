# Learning domain boundaries and implementation status

Status: implementation is merged in server PRs [#35](https://github.com/AIVirTeach/aivirteach-server/pull/35), [#36](https://github.com/AIVirTeach/aivirteach-server/pull/36), [#37](https://github.com/AIVirTeach/aivirteach-server/pull/37), [#38](https://github.com/AIVirTeach/aivirteach-server/pull/38) and client PRs [#23](https://github.com/AIVirTeach/aivirteach-client/pull/23), [#24](https://github.com/AIVirTeach/aivirteach-client/pull/24). Verified main tips on 2026-10-23: server `d573fab`, client `fd38776`. Older server #34 and client #22 are closed as superseded source records; their branches and review history are retained. Deployment remains manual and has not been performed for this work.

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

The earlier read-only check recorded that the configured Neon migration metadata reported `20261010000000` as the latest applied migration; no 20261023 migration is applied. That check found zero `EnrollmentCompletion` rows. These checks do not independently verify provider migration/deployment state. The user confirmed no rollout at that time. Recheck the actual provider database before release; these observations are historical, not current production proof.

## HTTP behavior and verification

Completion remains `PUT /courses/:slug/lessons/:lessonId/progress`; reading remains `PUT /courses/:slug/reading-position`. Both retain the generation and course-version fences. Completion also requires revision. Identical completion retries do not add revisions or activities. Reading advances revision only when the position changes. Achievement history is projected from immutable completion snapshots plus the current generation state.

The backend test slice covers typed state transitions, shared progress projection, dashboard and enrollment projections, completion/retry/unmark behavior, revision conflicts, stable-ID publication changes, manual snapshot ownership/idempotency/immutability/version pinning, bounded pagination, completion and restart snapshots, quota settlement, and reset retry behavior. Migration validation covers a fresh schema, upgrade from the configured deployed baseline, timestamp preservation, stable bookmark fallback, no fabricated history, and atomic failure for nonempty `EnrollmentCompletion`.

Browser flows, real Labs/VM behavior, coordinated release, and production acceptance remain unverified. Deployment remains manual per the user's confirmation.


## Remaining work and order

- [x] Merge the two-table backend, explicit chat contract and client consumers.
- [x] Add manual snapshot saving/history and retry-safe restart to both client layouts.
- [x] Centralize console session ownership; mounted React tests cover callback-only renders, scope changes, stop/resume, late results and StrictMode.
- [x] Complete the merged-main local release gate and independent review: 642 API unit tests, 108 PostgreSQL/authenticated HTTP tests, API build and three migration scenarios passed. Use `python3 scripts/verify-learning-release.py`; see the verification record for boundaries.
- [ ] When browser use is authorized, verify admin edit, draft preview, save, publish and learner rendering on a dedicated test course. Verify snapshot/history/restart and a real Labs connection separately.
- [ ] Confirm the provider targets, applied migration checksums and backup/restore procedure. The earlier configured-database query is insufficient for this gate.
- [ ] In an explicitly authorized maintenance window, suspend affected traffic and writes, apply the final migrations and deploy the matching API/client before restoring traffic. These contracts and dropped tables do not support a mixed old/new rollout.
- [ ] Verify authenticated production flows and record deployed revisions. A code rollback alone cannot restore dropped tables; recovery must account for any writes after migration.

The admin 4c operations pages and course-content migration B remain separate plans. They are not missing pieces of the completed learning-state implementation. Do not delete this plan while browser/provider acceptance remains open.
