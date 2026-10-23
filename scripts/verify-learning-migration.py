#!/usr/bin/env python3
"""Verify learning migrations in disposable local PostgreSQL databases."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "apps/api/prisma/migrations"
BASELINE = "20261010000000"
FIXTURE = """
INSERT INTO "User" (id,email,"updatedAt") VALUES ('u','migration@example.invalid',now());
INSERT INTO "Course" (id,slug,title,"updatedAt") VALUES ('c','migration','Migration',now());
INSERT INTO "CourseVersion" (id,"courseId",version,"publishedAt") VALUES ('v','c',1,now());
INSERT INTO "CourseModule" (id,"courseVersionId",position,title,description,"estimatedMinutes")
VALUES ('m','v',1,'Module','',1);
INSERT INTO "CourseLesson" (id,"contentId","moduleId",position,title,"estimatedMinutes","activityType","activityPrompt","activityCompletionType")
VALUES ('l','stable-lesson','m',1,'Lesson',1,'manual','Read','manual');
INSERT INTO "Enrollment" (id,"userId","courseId","courseVersionId",generation,"completedAt")
VALUES ('e','u','c','v',3,'2026-01-20 10:30:00.123');
INSERT INTO "Progress" (id,"enrollmentId","currentLessonId","updatedAt") VALUES ('p','e','l',now());
INSERT INTO "User" (id,email,"updatedAt") VALUES ('u2','migration2@example.invalid',now()), ('u3','migration3@example.invalid',now());
INSERT INTO "Enrollment" (id,"userId","courseId") VALUES ('e2','u2','c'),('e3','u3','c');
INSERT INTO "Progress" (id,"enrollmentId","currentLessonId","currentLessonContentId","updatedAt")
VALUES ('p2','e2','l','preferred-stable-id',now());
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="55440")
    parser.add_argument("--user", default="aivirteach")
    parser.add_argument("--psql", default=shutil.which("psql") or "/opt/homebrew/opt/postgresql@17/bin/psql")
    args = parser.parse_args()
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    env.update(PGHOST="127.0.0.1", PGPORT=args.port, PGUSER=args.user, PGCONNECT_TIMEOUT="5")

    def sql(database, statement, *, expect_success=True):
        result = subprocess.run(
            [args.psql, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", database],
            input=statement, text=True, capture_output=True, env=env,
        )
        if expect_success and result.returncode:
            raise RuntimeError(result.stderr)
        return result

    files = sorted(MIGRATIONS.glob("*/migration.sql"))
    baseline = [p for p in files if p.parent.name[:14] <= BASELINE]
    pending = [p for p in files if p not in baseline]
    assert baseline and pending, "Expected deployed and pending migrations"
    databases = []

    def create(label):
        name = "learning_verify_" + label + "_" + uuid.uuid4().hex[:10]
        sql("postgres", 'CREATE DATABASE "' + name + '";')
        databases.append(name)
        return name

    def apply(database, paths):
        for path in paths:
            sql(database, path.read_text())

    def check_tables(database):
        names = sql(database, "SELECT tablename FROM pg_tables WHERE schemaname='public';").stdout.splitlines()
        assert "Enrollment" in names and "LearningSnapshot" in names
        for name in ("Progress", "LessonProgress", "CourseCompletionHistory", "EnrollmentCompletion"):
            assert name not in names, f"Obsolete table remains: {name}"

    try:
        fresh = create("fresh")
        apply(fresh, files)
        check_tables(fresh)
        diff = subprocess.run(
            ["node", str(ROOT / "node_modules/prisma/build/index.js"), "migrate", "diff",
             "--from-url", f"postgresql://{args.user}@127.0.0.1:{args.port}/{fresh}",
             "--to-schema-datamodel", str(ROOT / "apps/api/prisma/schema.prisma"), "--exit-code"],
            text=True, capture_output=True,
            env={**env, "XDG_CACHE_HOME": "/private/tmp/aivirteach-progress-cache"},
        )
        assert diff.returncode == 0, diff.stdout + diff.stderr
        print("PASS: empty database reaches the two-table learning schema")

        upgrade = create("upgrade")
        apply(upgrade, baseline)
        sql(upgrade, FIXTURE)
        apply(upgrade, pending)
        check_tables(upgrade)
        state = json.loads(sql(upgrade, 'SELECT "learningState" FROM "Enrollment" WHERE id=\'e\';').stdout)
        assert state["readingLessonId"] == "stable-lesson", state
        assert state["lessons"] == {}, "Migration inferred lesson completion without evidence"
        assert state["completedAt"] == "2026-01-20T10:30:00.123Z", state
        assert sql(upgrade, 'SELECT generation FROM "Enrollment" WHERE id=\'e\';').stdout.strip() == "3"
        snapshot = json.loads(sql(upgrade, 'SELECT row_to_json(s) FROM "LearningSnapshot" s WHERE "enrollmentId"=\'e\';').stdout)
        assert snapshot["reason"] == "LEGACY_ACHIEVEMENT", snapshot
        assert snapshot["courseVersionId"] is None, "Legacy completion version is unknown"
        assert snapshot["state"]["completedAt"] == "2026-01-20T10:30:00.123Z", snapshot
        second = json.loads(sql(upgrade, 'SELECT "learningState" FROM "Enrollment" WHERE id=\'e2\';').stdout)
        assert second["readingLessonId"] == "preferred-stable-id", second
        third = json.loads(sql(upgrade, 'SELECT "learningState" FROM "Enrollment" WHERE id=\'e3\';').stdout)
        assert third == {"schemaVersion": 1, "readingLessonId": None, "lessons": {}, "completedAt": None}, third
        assert sql(upgrade, 'SELECT count(*) FROM "LearningSnapshot";').stdout.strip() == "1", "Migration invented historical snapshots"
        print("PASS: deployed-schema upgrade preserves bookmark, generation and completion fact without invented detail")

        guarded = create("guard")
        apply(guarded, baseline)
        sql(guarded, FIXTURE)
        sql(guarded, 'INSERT INTO "EnrollmentCompletion" (id,"enrollmentId",summary) VALUES (\'export\',\'e\',\'Preserve this report\');')
        consolidation = next(p for p in pending if p.parent.name.startswith("20261023090000"))
        failure = sql(guarded, consolidation.read_text(), expect_success=False)
        assert failure.returncode, "Unexpected export data must block destructive migration"
        assert "EnrollmentCompletion contains rows" in failure.stderr, failure.stderr
        assert sql(guarded, 'SELECT summary FROM "EnrollmentCompletion" WHERE id=\'export\';').stdout.strip() == "Preserve this report"
        assert sql(guarded, "SELECT count(*) FROM information_schema.columns WHERE table_name='Enrollment' AND column_name='learningState';").stdout.strip() == "0", "Failed migration left partial changes"
        print("PASS: unexpected export data blocks migration without partial changes or data loss")
    finally:
        for database in reversed(databases):
            sql("postgres", 'DROP DATABASE "' + database + '" WITH (FORCE);')


if __name__ == "__main__":
    main()
