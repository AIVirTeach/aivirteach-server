#!/usr/bin/env python3
"""Run the complete local learning release gate against a disposable PostgreSQL database."""

import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid


ROOT = Path(__file__).resolve().parents[1]


def local_port(value):
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("port must be a number from 1 to 65535") from error
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be a number from 1 to 65535")
    return port


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=local_port, default=55440, help="local PostgreSQL port")
    parser.add_argument("--user", default="aivirteach", help="local PostgreSQL role")
    parser.add_argument("--psql", default=shutil.which("psql") or "/opt/homebrew/opt/postgresql@17/bin/psql")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$-]{0,62}", args.user):
        parser.error("user must be a simple local PostgreSQL role name")

    psql = shutil.which(args.psql) or (str(Path(args.psql).resolve()) if Path(args.psql).is_file() else None)
    if not psql:
        parser.error(f"psql executable not found: {args.psql}")
    if not shutil.which("npm"):
        parser.error("npm executable not found")
    if not (ROOT / "node_modules/prisma/build/index.js").is_file():
        parser.error("Prisma CLI is missing; install the existing workspace dependencies first")

    env = {
        key: value for key, value in os.environ.items()
        if not key.startswith(("PG", "DOTENV_")) and key != "DATABASE_URL"
    }
    env.update(PGHOST="127.0.0.1", PGPORT=str(args.port), PGUSER=args.user, PGCONNECT_TIMEOUT="5")
    env["JWT_SECRET"] = "local-learning-release-test-secret-at-least-32-chars"
    env.setdefault("XDG_CACHE_HOME", "/private/tmp/aivirteach-learning-release-cache")

    def sql(database, statement):
        result = subprocess.run(
            [psql, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", database],
            input=statement, text=True, capture_output=True, env=env,
        )
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or "psql command failed")
        return result.stdout.strip()

    database = "learning_release_" + uuid.uuid4().hex[:12]
    created = False
    status = 0
    try:
        sql("postgres", f'CREATE DATABASE "{database}";')
        created = True
        database_url = f"postgresql://{args.user}@127.0.0.1:{args.port}/{database}"
        env["DATABASE_URL"] = database_url

        commands = [
            ("Deploy migrations to the fresh database", ["node", "node_modules/prisma/build/index.js",
             "migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"]),
            ("Run all API unit tests", ["npm", "run", "test", "-w", "api", "--", "--runInBand"]),
            ("Run all authenticated HTTP and PostgreSQL tests", ["npm", "run", "test:e2e", "-w", "api", "--", "--runInBand"]),
            ("Build the API", ["npm", "run", "build", "-w", "api"]),
            ("Verify fresh, upgrade, and guarded migration paths", [sys.executable,
             "scripts/verify-learning-migration.py", "--port", str(args.port), "--user", args.user,
             "--psql", psql]),
        ]
        for label, command in commands:
            print(f"\n== {label} ==", flush=True)
            subprocess.run(command, cwd=ROOT, env=env, check=True)
    except subprocess.CalledProcessError as error:
        status = error.returncode or 1
    except (OSError, RuntimeError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        status = 1
    finally:
        if created:
            try:
                sql("postgres", f'DROP DATABASE "{database}" WITH (FORCE);')
                print(f"Cleaned up disposable database {database}", flush=True)
            except (OSError, RuntimeError) as error:
                print(f"CLEANUP FAILED for disposable database {database}: {error}", file=sys.stderr)
                status = status or 1

    if status == 0:
        print("PASS: local learning release gate completed", flush=True)
    return status


if __name__ == "__main__":
    raise SystemExit(main())
