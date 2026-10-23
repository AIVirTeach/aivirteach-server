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

## PR #38 publication review fix

Publication previously queried and locked every enrollment even when no lesson was removed. The learning command now returns without database work for an empty mapping. Otherwise it filters by course and affected JSON reading positions in PostgreSQL, orders candidates by ID, then locks and rereads each candidate. A candidate that has moved is left unchanged. Completion state and saved snapshots are not modified by this operation.

The new database regression holds an unrelated enrollment lock in another transaction. The remap transaction uses a 750 ms PostgreSQL lock timeout. Original PR head `07724dd` fails with `55P03`; the fixed implementation passes. The fixture also verifies exactly one revision increment for the affected record and unchanged state/revision for the unrelated record. Logs: `/private/tmp/pr38-remap-red.log` and `/private/tmp/pr38-remap-green.log`.

Post-fix checks passed: 3 unit suites with 22 tests, the real publication suite with 7 tests, and the learning-state PostgreSQL/HTTP suite with 12 tests. TypeScript, Prettier, and diff checks passed. Scoped ESLint over the three changed TypeScript files has zero errors and 46 warnings. No full-suite rerun was needed for this bounded fix; the earlier complete runs are recorded above. No schema or migration changed.

## Merged-main local release gate

Server baseline `d573fab` and client merge `fd38776` contain the completed learning-state implementation. Run `python3 scripts/verify-learning-release.py --port 55440 --user aivirteach` after installing workspace dependencies and starting a local PostgreSQL server with a role permitted to create test databases. The runner requires the generated Prisma client from dependency installation.

The runner fixes the database host to `127.0.0.1`, creates one uniquely named database and applies migrations. It runs every API unit suite and every authenticated HTTP/PostgreSQL suite without a filename filter, builds the API, then invokes the existing fresh/upgrade/guarded migration verifier. Shared packages are built by the API pretest hooks; their separate unit suites are not part of this gate. The old `verify-lesson-progress.sh` is removed because its filename filter could omit the renamed `learning-state` suite.

The completed run passed 68 API unit suites with 642 tests, 17 PostgreSQL/HTTP suites with 108 tests, the API build and all three migration scenarios. Labs and Agent calls remain mocked. This pass changes no application runtime, database schema or migration SQL.

Isolation was exercised with inherited `DATABASE_URL`, `PGHOST`, `DOTENV_CONFIG_PATH` and `DOTENV_CONFIG_OVERRIDE` deliberately pointing to an invalid remote configuration. The gate discards those controls and uses its generated local URL. The learning-state suite still rejects any non-loopback host and allows only the original dedicated database or the exact generated name format.

An initial run failed because that suite allowed only the fixed database name. The runner returned nonzero and removed its database. After the guarded name update, the complete gate passed. Queries of the local database catalog confirmed no `learning_release_*` or `learning_verify_*` databases remained after either verification. Cleanup failure also makes the runner fail; abrupt process termination still requires checking for abandoned test databases.

Independent review found the dotenv override path before the final run and verified its removal. Script syntax, invalid-port rejection, Prettier and diff checks passed. Scoped ESLint on the changed E2E file reports zero errors and 43 test-typing warnings. Logs are `/private/tmp/learning-release-gate-first-failure.log` and `/private/tmp/learning-release-gate-final.log`.

## Release boundary

Client PR #24 is merged at `fd38776`. It supplies the restart command, manual snapshot saving and paginated history. Server main is `d573fab`. The client record reports 229 passing tests, including mounted console lifecycle tests; this is separate from browser or live provider acceptance.

There is no snapshot restore endpoint. Snapshots do not restore chats, VM files, assessment attempts, or consumed quota. Browser interaction, real Labs/VM behavior, and production rollout are separate acceptance steps. No browser, merge, deployment, or remote database write was performed for this change.
