# Backend-owned lesson progress

## Contract and ownership

Learners read `GET /courses/:slug/progress`, then set a lesson's completion with
`PUT /courses/:slug/lessons/:lessonId/progress` and `{completed, generation, revision, courseVersionId}`.
Reading uses a separate `PUT /courses/:slug/reading-position` command. Both commands
return a complete progress snapshot; opening a lesson never completes it.

Enrollment owns the current learning generation and completion revision.
LessonProgress is keyed by enrollment, generation and stable lesson content ID.
CourseCompletionHistory preserves the first achievement in each generation,
including legacy achievements; it is separate from assessment/export completion.
No old percentage or reading position is converted into completed lessons.
Assessment attempts and PASS rules are unchanged.

The shared enrollment projection counts only completed IDs present in the latest
published course. Reordering and text edits preserve completion. Added lessons
start pending; removed lessons stop contributing. Historical achievement remains
visible separately from current completion percentage. Restart advances generation
without deleting completion history or assessment evidence.

## Concurrency

Writes take a shared Course lock, then lock Enrollment and Progress.
Different learners may write concurrently; publication needs an exclusive Course lock. Publishing also locks Course
before remapping Progress. Validate published version and enrollment generation
under those locks. Completion revisions reject stale conflicting writes; replaying
an already satisfied command is a no-op. Activity is recorded at most once per
lesson per generation, including unmark/re-mark. Reading does not change completion
revision. Requests for inactive enrollments or another user fail closed.

## Alternatives

A browser-owned completed-ID set cannot synchronize devices or reliably isolate
accounts. Storing only a percentage cannot represent skipped or unchecked lessons.
A backend per-lesson record makes these cases explicit without duplicating rules
in V1 and V2. We retain the legacy completion route for the deployed client during
server-first rollout, routing it through the same completion command.

## Implementation and acceptance

1. Add schema/migration, pure projection and authenticated course-scoped endpoints.
2. Migrate enrollment/dashboard readers and legacy completion adapter.
3. Use one client progress hook for V1/V2; display self-reported completion, not PASS.
4. Verify real PostgreSQL migration and HTTP behavior: ownership, out-of-order
   completion, retry, unmark, concurrent revision, restart, publish/add/reorder.
5. Run scoped tests, typechecks and production builds; create linked PRs.

No merge, deployment, production data writes or browser acceptance in this task.
Roll out the migrated server before the client. The client reports progress API
failure and disables completion controls instead of guessing from old percentages.

## Implemented behavior

The progress snapshot also returns the numeric published `courseVersion`. The
client compares this with its loaded syllabus and blocks writes until the page
is refreshed when they differ. Progress GET failure shows a retry action; marking
is disabled until an authoritative snapshot is available. Focus refreshes progress.
Both layouts keep navigation and completion as separate actions.

Legacy `POST /lessons/:lessonId/complete` accepts exactly one matching active
course. It no longer advances the reading pointer or infers skipped completion.
All current client callers use the course-scoped API; the adapter remains only
for the already deployed client during rollout.

The course's current `status` can return to `in_progress` after unmarking or a new
lesson is published. `achievements` separately retains earned completion dates.
This is an intentional change from the old rule `completedAt implies 100%`.
Existing exported completion records and assessment attempts remain unchanged.

## Verification

Use `scripts/verify-lesson-progress.sh` with the dedicated localhost database.
It generates Prisma, applies migrations, runs enrollment/dashboard tests and the
progress/restart HTTP tests, then builds the API. It does not deploy or open a browser.

Verified locally on 2026-10-23:

- Entire API unit suite: 68 suites, 643 tests passed.
- Entire API HTTP/database suite: 17 suites, 94 tests passed, including rollback
  when activity persistence fails after the completion row is written.
- Prisma migration diff against the migrated database: no schema difference.
- Migration applied to an empty PostgreSQL database and to a database at the
  previous schema with a completed enrollment (generation 3). Its original
  completion date and reading position survived; no lesson completions were inferred.
- Client: typecheck; 22 unit files, 169 tests; Cloudflare production artifact
  verification; 8 built-page HTTP rendering tests; lint for the new progress modules.

Browser interaction, real Labs/VM operation, merge and deployment are not verified
or performed here. Release requires the migrated server first, then the client.
