#!/usr/bin/env python3
"""Generate seed.sql: schema-1 session histories for the fictional demo users.

Thirteen openly fictional Gutenberg characters typing their own books over
~8 weeks. Seed users get negative ids (GitHub ids are positive) — no OAuth
account, no token, so they can never upload, and the board renders them
without github.com links (several logins aren't valid GitHub names at all).
ASCII logins were verified unclaimed (404) on GitHub on 2026-07-19 so the
old year-suffix guarantee still holds if anyone pastes a URL by hand.

Every record is deterministic (seeded RNG per login) and canonicalized with
the same algorithm as src/bundle.ts canonicalJson: json.dumps(sort_keys=True,
separators=(",", ":"), ensure_ascii=False).

Usage: python3 scripts/seed_d1.py > seed.sql
       npx wrangler d1 execute typist-guild --local --file seed.sql   # dev
       npx wrangler d1 execute typist-guild --remote --file seed.sql  # live
"""

from __future__ import annotations

import datetime as dt
import json
import random
import uuid

START = dt.date(2026, 5, 23)
END = dt.date(2026, 7, 18)
WEEKS = 8
CREATED_AT = 1_747_958_400  # 2026-05-23
PLAUSIBLE_WPM_CEILING = 300  # keep in lockstep with src/bundle.ts

# login, avg_wpm, best_wpm, accuracy%, sessions/week, minutes/session,
# machines, books [(gutenberg_id, title, approx_length_chars)]
PERSONAS = [
    (
        "ishmael-of-nantucket",
        112,
        118,
        97.8,
        6,
        25,
        ["pequod", "spouter-inn"],
        [(2701, "Moby-Dick; or, The Whale", 1_200_000)],
    ),
    ("mina-harker-1897", 88, 95, 99.2, 14, 45, ["typewriter"], [(345, "Dracula", 840_000)]),
    (
        "elizabeth-bennet-1813",
        98,
        104,
        98.6,
        5,
        30,
        ["longbourn"],
        [(1342, "Pride and Prejudice", 680_000)],
    ),
    (
        "sydney-carton-1859",
        86,
        92,
        97.2,
        4,
        30,
        ["tellsons-bank"],
        [(98, "A Tale of Two Cities", 760_000)],
    ),
    (
        "captain-nemo-1870",
        72,
        78,
        96.8,
        4,
        35,
        ["nautilus"],
        [(164, "Twenty Thousand Leagues under the Sea", 570_000)],
    ),
    (
        "dorian-gray-1890",
        66,
        71,
        95.9,
        3,
        25,
        ["attic"],
        [(174, "The Picture of Dorian Gray", 430_000)],
    ),
    (
        "huck-finn-1884",
        50,
        55,
        94.5,
        3,
        20,
        ["raft"],
        [(76, "Adventures of Huckleberry Finn", 560_000)],
    ),
    (
        "hester-prynne-1850",
        43,
        47,
        96.1,
        3,
        30,
        ["cottage"],
        [(25344, "The Scarlet Letter", 470_000)],
    ),
    (
        "queequeg-1851",
        90,
        96,
        97.0,
        4,
        20,
        ["harpooneer-deck"],
        [(2701, "Moby-Dick; or, The Whale", 1_200_000)],
    ),
    # The untrustworthy one: honest-looking history plus one fabricated
    # 320-wpm session ("ever so 'umble") that trips the §6 plausibility
    # flag and earns the "?" badge.
    (
        "uriah-heep-1850",
        74,
        82,
        96.5,
        4,
        25,
        ["wickfield-office"],
        [(766, "David Copperfield", 1_900_000)],
    ),
    ("林黛玉", 62, 67, 97.5, 5, 30, ["瀟湘館"], [(24264, "紅樓夢", 860_000)]),
    (
        "skenderbeu-1468",
        81,
        88,
        96.4,
        4,
        25,
        ["kruja"],
        [(25153, "Tales of a Wayside Inn", 250_000), (5131, "Childe Harold's Pilgrimage", 450_000)],
    ),
    (
        "nasreddin-hoca-1208",
        68,
        73,
        95.8,
        3,
        15,
        ["donkey-saddle"],
        [(16244, "The Turkish Jester", 90_000)],
    ),
]


def sql_str(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def canonical(record: dict) -> str:
    return json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def is_implausible(r: dict) -> bool:
    if r["active_ms"] > r["wall_ms"]:
        return True
    if r["errors_uncorrected"] > r["chars_typed"]:
        return True
    span = r["range"]["end"] - r["range"]["start"]
    if abs(span - r["chars_typed"]) > 0.1 * r["chars_typed"]:
        return True
    if r["active_ms"] == 0 and r["chars_typed"] > 0:
        return True
    wpm = r["chars_typed"] / 5 / (r["active_ms"] / 60_000) if r["active_ms"] else 0
    return wpm > PLAUSIBLE_WPM_CEILING


def make_sessions(login, avg, best, acc, per_week, minutes, machines, books):
    rng = random.Random(login)
    cursors = {gid: 0 for gid, _, _ in books}
    total = WEEKS * per_week
    span_days = (END - START).days
    best_at = total // 2
    records = []
    for i in range(total):
        date = START + dt.timedelta(days=min(span_days, round(i * span_days / max(total - 1, 1))))
        gid, title, length = books[i % len(books)]
        machine = machines[rng.randrange(len(machines))] if len(machines) > 1 else machines[0]
        if i == best_at:
            wpm = float(best)
            active_min = max(minutes, 12.0)
        else:
            wpm = avg * (0.90 + rng.random() * 0.17)
            wpm = min(wpm, best - 0.6)  # only the crafted session sets the best
            active_min = minutes * (0.7 + rng.random() * 0.6)
        chars = round(active_min * wpm * 5)
        active_ms = round(active_min * 60_000)
        wall_ms = round(active_ms * (1.10 + rng.random() * 0.35))
        errors = min(chars, round(chars * (100 - acc) / 100 * (0.8 + rng.random() * 0.4)))
        corrections = round(errors * (1.2 + rng.random()))
        start = cursors[gid]
        if start + chars > 0.95 * length:
            start = 0  # started the book over
        cursors[gid] = start + chars
        records.append(
            {
                "id": str(uuid.UUID(int=rng.getrandbits(128), version=4)),
                "machine": machine,
                "date": date.isoformat(),
                "book": {"gutenberg_id": gid, "title": title},
                "range": {"start": start, "end": start + chars},
                "active_ms": active_ms,
                "wall_ms": wall_ms,
                "chars_typed": chars,
                "errors_uncorrected": errors,
                "corrections": corrections,
            }
        )
    if login == "uriah-heep-1850":
        # The fabricated session: 320 wpm sustained for 8 minutes, flawless.
        rng2 = random.Random(login + "/fraud")
        gid, title, _ = books[0]
        records.append(
            {
                "id": str(uuid.UUID(int=rng2.getrandbits(128), version=4)),
                "machine": machines[0],
                "date": (END - dt.timedelta(days=3)).isoformat(),
                "book": {"gutenberg_id": gid, "title": title},
                "range": {"start": cursors[gid], "end": cursors[gid] + 12_800},
                "active_ms": 480_000,
                "wall_ms": 480_000,
                "chars_typed": 12_800,
                "errors_uncorrected": 0,
                "corrections": 0,
            }
        )
    return records


def main() -> None:
    print("-- Generated by scripts/seed_d1.py — do not edit by hand.")
    print("DELETE FROM sessions WHERE user_id < 0;")
    print("DELETE FROM users WHERE id < 0;")
    flagged_total = 0
    for n, (login, avg, best, acc, per_week, minutes, machines, books) in enumerate(PERSONAS):
        uid = -(n + 1)
        print(
            f"INSERT INTO users (id, login, created_at, banned_at, token_hash) "
            f"VALUES ({uid}, {sql_str(login)}, {CREATED_AT}, NULL, NULL);"
        )
        for r in make_sessions(login, avg, best, acc, per_week, minutes, machines, books):
            flagged = 1 if is_implausible(r) else 0
            flagged_total += flagged
            received = int(
                dt.datetime.combine(
                    dt.date.fromisoformat(r["date"]), dt.time(12, 0), tzinfo=dt.UTC
                ).timestamp()
            )
            values = ", ".join(
                [
                    str(uid),
                    sql_str(r["id"]),
                    sql_str(r["machine"]),
                    sql_str(r["date"]),
                    str(r["book"]["gutenberg_id"]),
                    sql_str(r["book"]["title"]),
                    str(r["active_ms"]),
                    str(r["wall_ms"]),
                    str(r["chars_typed"]),
                    str(r["errors_uncorrected"]),
                    str(r["corrections"]),
                    "0",
                    str(flagged),
                    sql_str(canonical(r)),
                    str(received),
                ]
            )
            print(
                "INSERT INTO sessions (user_id, id, machine, date, book_id, title, "
                "active_ms, wall_ms, chars_typed, errors_uncorrected, corrections, "
                f"legacy, flagged, canonical_json, received_at) VALUES ({values});"
            )
    assert flagged_total == 1, f"expected exactly uriah's fraud flagged, got {flagged_total}"


if __name__ == "__main__":
    main()
