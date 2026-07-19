# Schema 1 Adoption Design

**Date:** 2026-07-19
**Status:** Approved (Danny, in-session), pre-implementation
**Spec:** [SPEC.md](SPEC.md) — session-record bundles, set-union merge. This doc covers *adopting* it across gutenberg-typist (emitter) and typist-guild (consumer).

## Decisions already made

- **Schema 1 first, then deploy.** The Workers platform is built but was never deployed, so the counter-format (v0) wire path is rewritten *before* first launch. No live migration ever happens; §9 shrinks to Danny's local Vim stats plus regenerating the fictional seeds.
- **Spec is amended during implementation** (owner's ruling), with every amendment in SPEC.md's changelog. Five landed at adoption start; see SPEC.md commit history for the diffs.
- **SPEC.md lives in this repo** as the normative document; the plugin README links to it.

## Emitter (gutenberg-typist)

**Single source of truth: a local session log.** New file `~/.vim/gutenberg-typist/session_log.json` — a JSON array of closed session records in exactly SPEC §3 shape. Export copies records as-is, so nothing private is ever *in* a record: precise timestamps are simply never written anywhere, satisfying §8 by construction.

- `stats.vim` gains two counters, fed from state the engine already holds:
  - `active_ms`: incremental accumulator over the existing per-text-change sample stream; per event, `delta = now - last_event; active_ms += delta <= 5000 ? delta : 0` (§5.1: long gaps excluded in full).
  - `corrections`: cumulative typed increments minus final length, counted at positions that end correct (§5.2).
- `engine.vim#Stop()` builds the record: UUIDv4 via Vim `rand()`, `date` via `strftime('%Y-%m-%d')`, `chars_typed` = final session-relative typed length, `errors_uncorrected` = final mismatches, `range` = `[resume_offset, final length)`, book title from `metadata.json` — then appends to the log. Sessions with `chars_typed == 0` are not logged.
- `:GT export` wraps the log in the §2 envelope (`schema: 1`, `generator`, no `user` — amendment 1). The in-progress session, if any, is simply not in the log yet (amendment 2).
- `:GT import` = union by `id`; same-id-different-content aborts loudly with both records' ids listed. v0-format files are refused with "update the plugin on that machine and re-export" (amendment 5).
- `:GT stats` derives lifetime numbers from the log (plus legacy records).
- **One-time migration**, triggered on first plugin action that touches storage: each machine entry in `lifetime_stats.json` becomes one §9 legacy record (deterministic UUIDv5, `legacy: true`) appended to the log; `lifetime_stats.json` is renamed `lifetime_stats.v0.json` so migration can't re-run.
- `:GT publish` transport unchanged (curl POST, bearer token).

The log is rewritten whole on each append. <!-- ponytail: whole-file rewrite; years of use is a few thousand ~200-byte records, revisit if it ever hurts -->

## Consumer (typist-guild Worker)

- `src/bundle.ts` rewritten for schema 1: structural validation → reject (§6: missing MUSTs, wrong types, malformed UUID/date, `schema > 1` refused); plausibility checks → per-record flags feeding the "?" badge (threshold Gross WPM > 300, replacing the old 250). Canonicalization = sorted-key, no-whitespace JSON; record identity conflicts detected by canonical-hash compare.
- **D1 migration rewritten in place** (`0001_init.sql` was never applied remotely): `users` unchanged; `sessions(user_id, id, machine, date, book_id, active_ms, wall_ms, chars_typed, errors_uncorrected, corrections, legacy, flagged, canonical_json, PK(user_id, id))` — extracted columns for board queries, full canonical JSON kept so unknown fields survive (§2) and conflict detection is a string compare (§4); `submissions` audit table stays; `machines`/`book_sessions` tables die.
- Upload: authenticate (unchanged) → validate → verify `user` if present (amendment 1) → insert records with unseen ids, no-op on byte-identical ids, **409 with the conflicting ids** on same-id-different-content → respond with rank as today. Throttle (30 s) and 1 MB cap unchanged.
- Board: derives §5.3 Gross/Net WPM and Accuracy per user; ranks by best single-session gross WPM over sessions ≥ 10 s active (consumer-side display rule, not spec); legacy records count toward lifetime totals but never per-session bests (§9). Board JSON shape changes accordingly; `site/app.js` updated with it.
- Delta anti-cheat: superseded — per-session plausibility (§6) replaces the upload-to-upload delta heuristic.

## Fictional seeds (regenerated)

Multi-session histories over ~8 weeks per user (real time-series material), negative user ids, no tokens, still labeled as fictional on the page. Roster changes per Danny:

- The "?" flagged user becomes **someone untrustworthy from literature** (candidates: Uriah Heep, Iago, Wickham, Long John Silver — pick whichever verifies 404 on GitHub), carrying one implausible ~320-wpm session. Queequeg goes honest or retires.
- **One Chinese character, in Chinese script** — e.g. 林黛玉 typing 紅樓夢 (Gutenberg has Chinese texts). Non-ASCII logins can't be GitHub profiles, so **seed users get no github.com link** (board links only positive-id users — this also strengthens the no-real-people guarantee).
- **One Albanian** (e.g. Skanderbeg/Gjergj Kastrioti via Longfellow's "Scanderbeg" or Byron's Childe Harold — both on Gutenberg) and **one Turkish** (Nasreddin Hodja, whose tales are on Gutenberg as "The Turkish Jester", id ~16244). Verify all Gutenberg ids and GitHub-404s at generation time.

Generator: rewrite `scripts/seed_d1.py` to emit per-session records (deterministic pseudo-random session lengths/dates per user profile) → `seed.sql`.

## What dies

`build.py`, `tests/test_build.py`, the counter-parity halves of `test/bundle.spec.ts` + `test/api.spec.ts`, the old `bundles/*.json` seeds (replaced by generator output), and the v0 delta anti-cheat. The git-era board was already scheduled to die at cutover.

## Testing

- **Worker (vitest):** structural rejections per §6; plausibility flags not rejections; union idempotence (re-upload = no-op, same response); 409 on mutated record; `user` mismatch rejection; board derive vs hand-computed §5.3 numbers; legacy records excluded from bests; throttle/auth suites carry over.
- **Plugin (harness):** active-time gap rule (scripted pauses >5 s excluded); corrections counting; export envelope shape + closed-sessions-only; import union + loud conflict + v0 refusal; migration produces the deterministic legacy UUID and renames the counter file; publish section updated to new stub response.
- **Cross-check:** one fixture bundle validated by both sides; board numbers for it hand-verified once.

## Execution order

1. SPEC.md verbatim + amendments (done, commits `024c9d4`, `8cc1dcf`).
2. Worker: bundle.ts + migration + upload/board + tests green.
3. Plugin: stats/engine/storage/export/import/migration + harness green.
4. Seeds regenerated; local `wrangler dev` end-to-end (fixture upload → board parity).
5. Resume the deploy chain exactly where it was: Danny's Cloudflare token → deploy → OAuth app → cutover.
