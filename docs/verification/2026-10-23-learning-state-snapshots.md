# Learning state and snapshots verification

This change replaces learning persistence with mutable `Enrollment.learningState` and immutable `LearningSnapshot`. The backend owns reading, completion, snapshot creation, and restart. Chat still requires explicit lesson context and does not derive it from the reading position.

## Migration baseline

On 2026-10-23, a read-only query of the Neon database configured in the primary checkout reported applied migrations through `20261010000000_enrollment_generation_and_workspace_retry`. None of the three `20261023` migrations had run. `EnrollmentCompletion` contained zero rows. This checks the configured database; it does not independently establish which database a provider deployment uses. The user confirmed that the merged changes had not been deployed or migrated.

The unapplied `20261023090000_lesson_progress` migration is rewritten to create the final schema directly. Previously applied migrations and the pending explicit-chat migrations remain unchanged. An installation that already applied the superseded progress migration must not run this rewritten migration as though it were new. Disposable development databases can be rebuilt.

The migration preserves stable reading IDs, resolves older lesson-row pointers, and retains known completion timestamps. It does not infer completed lessons from a bookmark or a course completion timestamp. Imported achievement records explicitly lack a complete historical state and a known course version. Unexpected data in the obsolete export table aborts the transaction before changes.

## Reproducible database verification

Run `python3 scripts/verify-learning-migration.py --port 55440 --user aivirteach` against a local test PostgreSQL instance. The script connects only to `127.0.0.1`, creates uniquely named disposable databases, and removes them after the run.

Verified paths:

- All migrations from an empty database, followed by a Prisma schema diff with no differences.
- Upgrade from the applied baseline with stable and legacy bookmarks, a known completion timestamp, and an enrollment without progress. UTC timestamps and generation survive; no lesson completion is invented.
- A nonempty obsolete export table blocks migration and leaves its data and the old schema unchanged.

## Application verification

The parent ran the complete API suites against the final runtime implementation with the dedicated local `aivirteach_learning_state` database:

- API build: `npm run build -w api` passed.
- Unit tests: `node --experimental-vm-modules ../../node_modules/jest/bin/jest.js --runInBand` from `apps/api` passed 68 suites and 640 tests.
- PostgreSQL and authenticated HTTP tests: the same Jest command with `--config ./test/jest-e2e.json` passed 17 suites and 107 tests. Labs and Agent interactions are mocked; this is not live provider acceptance.
- The migration script passed all three paths, including the empty-schema Prisma diff.

The first complete run exposed three stale test inputs or expectations: removed backfill metadata and two restart requests without the new command body. They were adapted, passed a focused rerun, and then passed the complete suites above. Tests were retained. Migration verification also caught and corrected an eight-hour timestamp conversion error on a non-UTC database session.

An independent source reviewer checked the final domain boundaries, concurrent writes, snapshot ownership, version pinning, pagination, restart replay, and quota/workspace behavior. Review found and verified fixes for snapshot percentages counting removed lessons and replay behavior after publication. No confirmed runtime defect remained in that reviewed scope. The reviewer did not run a separate database or browser test pass.

Local run logs are `/private/tmp/learning-state-build.log`, `/private/tmp/learning-state-unit-final.log`, `/private/tmp/learning-state-e2e-final.log`, and `/private/tmp/learning-state-migration-final.log`.

After the full runs, final cleanup removed unused type assertions, obsolete test mocks, and redundant comments. The reset error branch now assigns its existing pending outcome explicitly. The affected 5 unit suites with 65 tests and 2 HTTP suites with 25 tests passed again, as did TypeScript checking. Scoped ESLint over every changed TypeScript file reports zero errors and 86 test-typing warnings; it is not a warning-free lint result. The full suites were not repeated after this bounded cleanup. The lint log is `/private/tmp/learning-state-eslint-final.log`.

## Release boundary

The client follow-up is PR #24. Restart now requires a request ID, generation, revision, and course version. Reading changes advance the progress revision. The client must expose manual snapshot saving and paginated history before the feature is released.

There is no snapshot restore endpoint. Snapshots do not restore chats, VM files, assessment attempts, or consumed quota. Browser interaction, real Labs/VM behavior, and production rollout are separate acceptance steps. No browser, merge, deployment, or remote database write was performed for this change.
