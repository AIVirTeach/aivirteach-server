# Explicit lesson context verification

The root fix lives in server PR #37 and client PR #24. Server #36 and client #23 remain their foundation PRs. This replaces the separate future chat PR slices in the merged learning-domain plan. Original server #34 and client #22 are source records, not merge targets.

## Implemented server contract

Both chat POST routes require `requestId`, `text`, and `context` containing `courseVersionId`, stable `lessonId`, and enrollment `generation`. The server checks ownership, the active generation, and the latest published version before accepting a question. It resolves trusted course and lesson content under the publication/enrollment locks and persists the accepted context snapshot with the question. Agent calls run outside database transactions.

A duplicate request ID within the same enrollment and generation returns 409, whether the original request is pending or completed. There is no automatic replay. A deliberate new question needs a new request ID. Replies share the accepted reference. Restart fences late writes, while already incurred token usage is accounted for with an enrollment/generation/request-scoped key.

History GET requires a decimal, nonnegative `generation` query. A missing or malformed generation returns 400. An inactive or stale generation returns 409. The read and generation check use one transaction.

The streaming route validates before committing HTTP success headers. After disconnect, it stops writing to the client but drains the accepted Agent iterator so final persistence and usage accounting can run. This is local application behavior, not proof that a hosting provider will keep a disconnected invocation alive indefinitely.

The legacy lesson completion endpoint is removed. Completing a lesson does not advance reading. Reading position is used for resume and is not used to infer chat context. Actual lesson responses include their version ID and number, including the admin preview response builder.

## Evidence on 2026-10-23

Server implementation commit: `7a8897d`.

- API build passed.
- Full API unit suite: 68 suites, 645 tests passed.
- Full HTTP/database suite: 17 suites, 103 tests passed.
- Independent review ran chat service, chat controller and lesson response tests: 3 suites, 46 tests passed. No confirmed blocking defect was found within that scope.
- Real PostgreSQL migration from the progress-model schema preserved a legacy conversation without inventing a context. New question/reply/generation scopes coexist; the duplicate user claim is constrained. Schema diff reported no difference.
- Foundation PR #36 was separately tested on an empty database and an old schema with a completed enrollment. Historical date and generation survive, no per-lesson completion is inferred, and cascade/generation separation checks pass. Both resulting schemas match its Prisma schema.

HTTP tests cover invalid context before SSE headers, duplicate requests across transports, two explicitly selected lessons, publication during an accepted question, generation-scoped history and restart rejection. Controlled streaming tests cover disconnect draining and stale-response accounting. The Agent is mocked in these tests.

## Remaining acceptance and delivery

Client lifecycle changes and their final independent review are recorded in the client verification document. Foundation PRs are presented one at a time after the combined implementation is checked. No PR has been merged or deployed by this verification task.

Browser interaction, real Labs/VM behavior, hosted SSE lifetime and production deployment are not verified. No production database was changed. Vercel project inspection confirmed the API project root and build settings, but the Git-link API could not be authenticated. Therefore automatic deployment state is not verified. Migrations must precede runtime code that selects the new columns; coordinate the breaking frontend/backend contracts before release.
