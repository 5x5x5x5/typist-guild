#!/usr/bin/env python3
"""Generate seed.sql for D1 from the git-era bundles/ directory.

Reuses build.py's load_bundle so exactly the rows the old board showed are
what the platform starts with. Seed users get negative ids (GitHub ids are
positive) — they have no OAuth account and no token, so they can never
upload; they exist to be knocked off the board.

Usage: python3 scripts/seed_d1.py > seed.sql
       npx wrangler d1 execute typist-guild --remote --file seed.sql
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build


def sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def main() -> int:
    statements: list[str] = []
    paths = sorted(build.BUNDLES.glob("*.json"))
    for seed_id, path in enumerate(paths, start=1):
        bundle, error = build.load_bundle(path)
        if bundle is None:
            print(f"-- skipped {path.name}: {error}", file=sys.stderr)
            continue
        user_id = -seed_id
        exported_at = bundle["exported_at"]
        statements.append(
            f"INSERT INTO users (id, login, created_at) VALUES "
            f"({user_id}, {sql_str(path.stem)}, {exported_at});"
        )
        for machine_id, counters in bundle["machines"].items():
            statements.append(
                f"INSERT INTO machines (user_id, machine_id, counters_json, updated_at) VALUES "
                f"({user_id}, {sql_str(machine_id)}, {sql_str(json.dumps(counters))}, {exported_at});"
            )
        for session in bundle["sessions"].values():
            statements.append(
                "INSERT INTO book_sessions (user_id, book_id, offset, total_chars_typed, "
                "correct_chars, last_active) VALUES "
                f"({user_id}, {session['book_id']}, {session['offset']}, "
                f"{session.get('total_chars_typed', 'NULL')}, "
                f"{session.get('correct_chars', 'NULL')}, "
                f"{session.get('last_active', 'NULL')});"
            )
    print("\n".join(statements))
    print(f"-- {len(paths)} bundle(s) processed", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
