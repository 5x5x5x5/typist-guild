# Schema 1 Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the counter-format wire path with SPEC.md schema-1 session records across the Worker (consumer), the Vim plugin (emitter), and the fictional seeds — before first deploy, so no live migration ever exists.

**Architecture:** Bundles become sets of immutable per-session records merged by set union on UUID. The Worker stores each record's canonical JSON plus extracted columns; the plugin keeps a local append-only session log as single source of truth with a one-time counter migration. Transport (OAuth/tokens/curl/`:GT publish`) is untouched.

**Tech Stack:** Cloudflare Workers + D1 (TypeScript, vitest-pool-workers), Vim 8.2 VimScript, Python 3 stdlib (seed generator), bash harness.

## Global Constraints

- SPEC.md is normative; any deviation discovered during implementation becomes a SPEC.md changelog amendment (owner's standing ruling).
- Plausibility problems **flag** (feed the "?" badge); only structural problems **reject** (§6). Gross-WPM ceiling: **300** (replaces 250).
- 1 MB body cap, 30 s per-user upload throttle, auth paths unchanged (`src/auth.ts` is not modified).
- Negative user ids = fictional seeds: no tokens, never upload, **no github.com link on the board**.
- Records are stored byte-for-byte as canonicalized JSON — never mutate a record after parse (no sanitize-in-place; display safety comes from `textContent` rendering).
- Vim: no new external dependencies (pure VimScript + curl); `rand()`/`sha256()` builtins only.
- No `git add -A`; explicit paths. No backticks inside double-quoted `git -m`.
- Repos: `~/projects/typist-guild` (Worker) and `~/projects/gutenberg-typist` (plugin). All commits local; nothing pushes until cutover.

---

### Task 1: Spec amendments 6–8

**Files:** Modify: `SPEC.md` (typist-guild)

Implementation exposed three more draft/reality conflicts. Amend + changelog, one commit.

- [ ] **Amendment 6 — §9 legacy records omit `book` and `range`.** v0 counters carry no per-book data. Rule: a missing `book` is structurally valid only when `legacy: true`. Legacy records also carry the original counter map as `legacy_counters` (an unknown field per §2, preserved end-to-end) so `sessions_count` survives for display.
- [ ] **Amendment 7 — §3 `chars_typed` description fixed.** "i.e. correct-final characters" contradicts §5.3 (Net WPM subtracts errors *from* `chars_typed`) and §6 (`errors_uncorrected <= chars_typed`). Correct description: "the final transcript length — source positions advanced past, whether or not the final character matches."
- [ ] **Amendment 8 — §9 deterministic id via SHA-256, not UUIDv5.** Vim ships `sha256()` but no SHA-1, so UUIDv5 is unimplementable in the emitter. Definition: `d = sha256_hex(utf8(namespace_uuid + "\n" + machine + "\n" + "legacy-v0"))`; id = `d[0:8] "-" d[8:12] "-8" d[13:16] "-" v d[17:20] "-" d[20:32]` where `v = hex((int(d[16],16) & 0x3) | 0x8)`. Namespace stays `8c8f6a1e-2b7d-4f5a-9c3e-747970697374`.
- [ ] **Commit:** `git add SPEC.md && git commit -m "Amend spec: legacy records omit book, chars_typed description, SHA-256 legacy ids"`

### Task 2: Worker `src/bundle.ts` rewrite + unit suite

**Files:** Rewrite: `src/bundle.ts`, `test/bundle.spec.ts`

**Interfaces (produced, relied on by Tasks 3–4):**

```ts
export const SCHEMA_VERSION = 1;
export const MAX_BUNDLE_BYTES = 1_000_000;
export const PLAUSIBLE_WPM_CEILING = 300;      // §6
export const MIN_BEST_SESSION_ACTIVE_MS = 10_000; // consumer display rule

export interface SessionRecord {
  id: string; machine: string; date: string;
  book?: { gutenberg_id: number; title?: string }; // absent ⇒ legacy only
  range?: { start: number; end: number };
  active_ms: number; wall_ms: number;
  chars_typed: number; errors_uncorrected: number;
  corrections?: number; legacy?: boolean;
  [key: string]: unknown;                        // unknown fields preserved
}
export interface ParsedBundle { user?: string; sessions: SessionRecord[] }
export function parseBundle(text: string): { bundle: ParsedBundle | null; error: string | null };
export function canonicalJson(value: unknown): string;   // sorted keys, no whitespace, recursive
export function grossWpm(r: SessionRecord): number;      // chars/5 / (active_ms/60000), 0 if active_ms==0
export function isImplausible(r: SessionRecord): boolean;
export interface MachineSummary { chars: number; hours: number; sessions: number; best_wpm: number }
export interface BookSummary { book_id: number; title: string; chars: number; sessions: number; last_date: string }
export interface Row {
  user: string; seed: boolean; best_wpm: number; avg_wpm: number; accuracy: number;
  hours: number; total_chars: number; sessions: number; books: number;
  machines_count: number; last_date: string; suspicious: boolean;
  machines: Record<string, MachineSummary>; books_detail: BookSummary[];
}
export function deriveRow(login: string, seed: boolean,
  records: Array<SessionRecord & { flagged: boolean }>): Row;
```

- [ ] **Step 1: write `test/bundle.spec.ts` first** (structural rejections: not-JSON, array, `schema` 2/"1"/missing → exact refusal wording, sessions not array, bad UUID/uppercase UUID, malformed date `2026-13-01`, missing `chars_typed`, `machine` >100 chars, `title` >200 chars, non-integer `active_ms`, missing `book` without `legacy`, in-bundle same-id different-content → error naming the id, in-bundle exact duplicate → silently deduped; plausibility: `active_ms > wall_ms`, `errors > chars`, range span off by >10%, 301 gross wpm, `active_ms==0 && chars>0` → each flags not rejects; `canonicalJson` key-order invariance + nested + unicode; `deriveRow`: §5.3 formulas hand-computed, best excludes legacy and <10 s sessions, `sessions` count = non-legacy + `legacy_counters.sessions_count`, `books_detail` sorted by `last_date` desc, machines summary, empty-records row). Run: `npx vitest run test/bundle.spec.ts` → all FAIL (old module).
- [ ] **Step 2: rewrite `src/bundle.ts`.** Validation rules (structural, whole-bundle reject with `sessions[i]` context): id `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (lowercase mandatory — case-variant ids would double-count); date `^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$`; `machine` non-empty string ≤100 chars; `book.gutenberg_id` non-negative integer, `title` string ≤200 when present; the four MUST counters non-negative integers; `corrections`/`range` optional but typed when present; `schema > 1` → "schema N not supported — this guild understands schema 1". Plausibility per §6 (skip the book-length check — the server has no book texts; code comment says so). Legacy mapping is NOT done here (server never mints records).
- [ ] **Step 3:** `npx vitest run test/bundle.spec.ts` → PASS.
- [ ] **Step 4: Commit** `src/bundle.ts test/bundle.spec.ts`.

### Task 3: D1 schema + upload/board rewrite + integration suite

**Files:** Rewrite: `migrations/0001_init.sql` (in place — never applied remotely), `src/index.ts` upload/board sections; Rewrite: `test/api.spec.ts`. `src/auth.ts`, `vitest.config.ts`, `test/apply-migrations.ts` untouched.

**Schema:**

```sql
CREATE TABLE users (            -- unchanged
  id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, banned_at INTEGER, token_hash TEXT
);
-- One row per session record. canonical_json is the record exactly as
-- received (canonicalized): unknown fields survive (SPEC §2) and §4
-- conflict detection is a string compare. Extracted columns exist only
-- for board queries.
CREATE TABLE sessions (
  user_id INTEGER NOT NULL REFERENCES users(id),
  id TEXT NOT NULL, machine TEXT NOT NULL, date TEXT NOT NULL,
  book_id INTEGER, title TEXT,
  active_ms INTEGER NOT NULL, wall_ms INTEGER NOT NULL,
  chars_typed INTEGER NOT NULL, errors_uncorrected INTEGER NOT NULL,
  corrections INTEGER, legacy INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  canonical_json TEXT NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  received_at INTEGER NOT NULL, bundle_sha256 TEXT NOT NULL,
  new_sessions INTEGER NOT NULL, flagged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_submissions_user_time ON submissions (user_id, received_at DESC);
```

**Upload flow** (replaces merge-and-upsert; throttle/auth/cap identical to current code):

1. `parseBundle`; 400 on error. 2. `bundle.user` present and ≠ login → 403 `{error: "bundle user X does not match authenticated user Y"}`. 3. Fetch existing `(id, canonical_json)` for incoming ids — `SELECT ... WHERE user_id = ?1 AND id IN (...)` **chunked at 50 ids** (D1 ~100-param bind limit). 4. Same id + same canonical → skip (no-op); same id + different → collect; any collected → **409** `{error, conflicting_ids}` and insert nothing. 5. New records → `INSERT INTO sessions` batch (+ per-record `flagged = isImplausible(r) ? 1 : 0`) + one `submissions` audit row. 6. Respond `{ok, user, rank, total_users, best_wpm, new_sessions, total_sessions, suspicious}` — plugin reads rank/total_users/best_wpm/suspicious, so the shape is backward-compatible.

**Board:** one `SELECT s.*, u.login, u.id AS uid FROM sessions s JOIN users u ... WHERE u.banned_at IS NULL`; group by user; `deriveRow(login, uid < 0, records)` with `flagged` from the column; envelope `{generated_at, users, skipped: []}` + same cache/CORS headers; sort best_wpm desc, login asc. `suspicious = any flagged record` (delta anti-cheat is deleted — superseded by per-record plausibility).

- [ ] **Step 1: rewrite `test/api.spec.ts` first.** Fixture helper `record(overrides)` returns a valid session record with fresh UUID; `bundle(records, user?)`. Tests: board empty; board sorted with seeds (insert one negative-id user directly) and `seed: true` on that row; banned hidden; 401 no auth / bad token / cookie-without-header; cookie+`X-Typist-Guild` works; 403 banned; 403 user mismatch (and 200 when `user` matches); 413; 429 then, after backdating, exact re-upload → `new_sessions: 0` and identical totals (idempotence); 400 structural (schema 2, bad uuid, missing counter); 409 mutated record with `conflicting_ids: [id]` and row count unchanged; flagged 320-wpm record → 200 + `suspicious: true` + board "?"; legacy record (no book, `legacy_counters: {sessions_count: 42}`) → hours counted, best_wpm unaffected, `sessions` includes 42, absent from `books_detail`; board row fold shapes (machines summary numbers, `books_detail` title); token-issue→upload; forged cookie; OAuth login redirect + state mismatch (carry the last four over nearly verbatim). Run → FAIL.
- [ ] **Step 2:** rewrite migration + `src/index.ts` (imports switch to the Task 2 interface; `loadUserState` disappears — upload no longer needs prior state beyond the id-existence query; `accountPage` JS: success message becomes `"merged N new session(s) — you are #… of … (best … wpm)"`).
- [ ] **Step 3:** `npx vitest run` → **all green** (bundle + api).
- [ ] **Step 4: Commit** `migrations/0001_init.sql src/index.ts src/bundle.ts test/api.spec.ts` (bundle.ts only if touched by integration fixes).

### Task 4: Board UI (`site/app.js`) for the new row shape

**Files:** Modify: `site/app.js` (COLUMNS, foldCell, user cell), `site/index.html` only if column count changes break the header note.

- [ ] COLUMNS: drop `machines_count`+`exported_at` for `{key: "last_date", label: "last day", fmt: (v) => v || "—"}` (keep machines count in the fold header as today). Fold machines list renders `MachineSummary` (`chars · hours h · best N wpm · N sessions`); fold books render `BookSummary` (`title` text + gutenberg.org link on `#id`, `chars`, `last_date`). User cell: **only wrap in `<a href="https://github.com/…">` when `!row.seed`** — seeds render plain text (Chinese-script logins aren't valid GitHub URLs, and seeds must not point at anyone).
- [ ] Manual check deferred to Task 7's `wrangler dev` smoke (no unit harness for app.js — it is 280 lines of DOM).
- [ ] **Commit** `site/app.js` (+ `site/index.html` if touched).

### Task 5: Plugin emitter rewrite

**Files (gutenberg-typist):** Modify: `autoload/gt/util.vim` (+`Uuid4`, `+LegacyUuid`), `autoload/gt/stats.vim`, `autoload/gt/engine.vim`, `autoload/gt/storage.vim`, `autoload/gt/hub.vim` (message only), `autoload/gt.vim` (unchanged dispatch — verify), `doc/gt.txt`, `README.md`.

**Interfaces produced:**

```vim
gt#util#Uuid4()                       " random v4, lowercase, uses rand()
gt#util#LegacyUuid(machine)           " amendment-8 SHA-256 derivation
gt#stats#New()                        " + active_ms, last_event, ever_wrong, session-relative counters
gt#stats#UpdateFromComparison(state, typed_len, correct_count, prev_typed_len, now)  " now injected for testability
gt#storage#AppendSessionRecord(record)   " migrate-if-needed, append, rewrite log
gt#storage#LoadSessionLog()              " migrate-if-needed, -> list
gt#storage#ExportBundle(path)            " schema-1 envelope + gt_progress extension
gt#storage#ImportBundle(path)            " union by id; loud conflict; v0 refusal
gt#storage#LoadLifetimeStats()           " same flat shape as today, derived from the log
```

Key mechanics, exact:

```vim
" stats.vim — active time (§5.1): gaps > 5 s excluded in full
if a:state.last_event isnot v:null
  let l:gap = a:now - a:state.last_event
  if l:gap <= 5.0
    let a:state.active_ms += float2nr(round(l:gap * 1000))
  endif
endif
let a:state.last_event = a:now
```

- `engine.vim` comparison loop marks `s:state.stats.ever_wrong[l:i] = 1` for mismatched positions (prefix positions always match, so session-relativity is automatic). Engine passes `reltimefloat(reltime())` as `now`.
- At `Stop()`: `chars_typed = prev_typed_len` (final session-relative length, per amendment 7); `errors_uncorrected = rel_typed − rel_correct` from the last comparison (store both on stats each update); `corrections = count(keys(ever_wrong) ≤ base + final) − errors_uncorrected` (ever-wrong minus still-wrong = fixed; positions abandoned beyond the final length excluded); `wall_ms = (now − start_time) * 1000`; `date` captured at `Start()` via `strftime('%Y-%m-%d')`; uuid at `Start()`; `range = {start: resume_offset, end: resume_offset + final}`; book title from `gt#storage#LoadBookMetadata`. `chars_typed == 0` → not logged (§3). Recap message switches to gross WPM on active time and §5.3 accuracy. `AddLifetimeDeltas` call deleted.
- `storage.vim`: log at `~/.vim/gutenberg-typist/session_log.json` (JSON array, whole-file rewrite per append — ponytail-comment the ceiling). One-time migration guard `s:EnsureMigrated()` at both log entry points: if `lifetime_stats.json` exists → per machine, legacy record `{id: LegacyUuid(m), machine, date: today, legacy: v:true, active_ms: total_time_seconds*1000, wall_ms: same, chars_typed: total_chars, errors_uncorrected: max(total_chars-correct_chars,0), legacy_counters: <original map>}` (no book/range, amendment 6) → append → `rename(path, path . '.v0')`. Export envelope: `{'schema': 1, 'generator': 'gutenberg-typist/0.5.0', 'sessions': log, 'gt_progress': gt#storage#ListSessions()}` — `gt_progress` is a plugin-private unknown-field extension (§2-legal) that keeps cross-machine *resume* sync working; import merges it with the existing `gt#storage#MergeSession` newest-wins policy. Import: refuse `format_version` bundles (§9 wording: "v0 bundle — update gutenberg-typist on the exporting machine and re-export"); refuse `schema > 1`; union by id building the merged list first (same id + canonically-identical → skip; different → abort listing ids, write nothing); single write at end. `s:CanonicalJson(v)`: recursive sorted-keys compact encoder (dicts: sorted keys; lists: element-wise; scalars: `json_encode`).
- `hub.vim`: success printf gains new_sessions: `'GT: Published %d new session(s) — #%d of %d (best %d wpm)'` with `get(l:data, 'new_sessions', 0)`.
- Docs: `doc/gt.txt` |gt-sync| + |:GT-export|/|:GT-import|/|:GT-publish| rewording (session records, set union, v0 note); README "Syncing stats" + "The leaderboard" sections likewise; both mention SPEC.md in the typist-guild repo.

- [ ] **Step 1:** implement all of the above.
- [ ] **Step 2:** Task 6 harness is the test cycle (VimScript has no unit runner here) — proceed to Task 6 before committing.

### Task 6: Plugin harness rewrite

**Files:** Modify: `test/verify_portable_stats.sh` (counter-merge sections replaced), `test/hub_stub.py` (response gains `"new_sessions": 3`; keep shape otherwise).

- [ ] Replace/renumber checks: **export** (envelope has `"schema":1`, generator, sessions array, `gt_progress`); **uuid** (`Uuid4()` matches v4 regex, two calls differ); **legacy id** (`LegacyUuid('sable')` equals itself across calls, matches UUID shape, differs for 'other'); **active time** (synthetic `now` injections 0→2→4→20 give `active_ms == 4000`); **errors/corrections** (scripted buffer typing: one wrong-left, one wrong-fixed → errors 1, corrections 1, chars = final length); **Stop appends** (log gains a record; `chars_typed==0` session does not append); **migration** (planted `lifetime_stats.json` with two machines → two `legacy:true` records with deterministic ids, `legacy_counters` intact, file renamed `.v0`, second run appends nothing); **import** (new id unions in; identical re-import no-op; mutated same-id aborts with id in message and log unchanged; `format_version` bundle refused with re-export guidance; `gt_progress` newest-wins still updates a book offset); **publish** (AUTH header, body contains `"schema":1`, echo says `Published 3 new session(s) — #1 of 3`; no-token warning). Old counter-merge/max-merge checks deleted.
- [ ] Run `bash test/verify_portable_stats.sh` → **all checks pass** (echo the final count).
- [ ] Regenerate helptags; **commit** the plugin work: `git add autoload/gt/util.vim autoload/gt/stats.vim autoload/gt/engine.vim autoload/gt/storage.vim autoload/gt/hub.vim doc/gt.txt README.md test/verify_portable_stats.sh test/hub_stub.py doc/tags && git commit` (message: schema-1 emitter — session log, set-union import, counter migration).

### Task 7: Seeds + end-to-end smoke

**Files (typist-guild):** Rewrite: `scripts/seed_d1.py` (standalone, stdlib); Delete: `build.py`, `tests/`, `bundles/`; Modify: `site/index.html` seednote if wording references counters.

- [ ] **Roster** (negative ids, deterministic `random.Random(login)` per user; ~8 weeks of sessions ending 2026-07-18; per-session `active_ms` 8–35 min, `wall = active × 1.1–1.5`, chars from target wpm ±8%, errors from accuracy, `corrections ≈ errors × 1.5`, `range` walks a per-book cursor that wraps at 97% of book length; every derived board number recomputed by the same §5.3 formulas as the Worker):
  ishmael-of-nantucket (Moby-Dick 2701, best 118 — leader), mina-harker-1897 (Dracula 345, most hours), elizabeth-bennet-1813 (P&P 1342), sydney-carton-1859 (Two Cities 98), captain-nemo-1870 (20 000 Leagues 164), dorian-gray-1890 (174), huck-finn-1884 (76), hester-prynne-1850 (25344), queequeg-1851 (2701, now honest ~96), **uriah-heep-1850** (David Copperfield 766 — the untrustworthy flag-carrier: one 320-wpm session trips §6), **林黛玉** (紅樓夢 — verify the Chinese-text Gutenberg id via gutendex before generating), **skenderbeu-1468** (Albanian — Longfellow's Tales of a Wayside Inn or Byron's Childe Harold, verify id), **nasreddin-hoca-1208** (Turkish — The Turkish Jester, verify id ~16244).
  Before generating: `curl -s -o /dev/null -w "%{http_code}" https://github.com/<login>` must be **404** for every new ASCII login (uriah-heep-1850, skenderbeu-1468, nasreddin-hoca-1208; fallbacks per DESIGN-SCHEMA1.md). 林黛玉 needs no check — no link is ever rendered.
  `canonical_json` from Python: `json.dumps(rec, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` — same algorithm as `canonicalJson`.
- [ ] Generate `seed.sql` → apply to local D1 (`npx wrangler d1 execute typist-guild --local --file seed.sql`) → `npx wrangler dev`: board renders 13 users, new columns, uriah-heep carries "?", 林黛玉 renders unlinked in CJK; `/account` 302s anonymous. Upload smoke with a planted test token: fixture bundle → 200 + rank; byte-identical replay → `new_sessions: 0`; mutated record → 409. Kill dev server (verify by port-closed curl, not pkill exit).
- [ ] **Commit** `scripts/seed_d1.py site/index.html` + deletions (`git rm build.py tests/test_build.py bundles/*.json` — explicit paths).

### Task 8: Bookkeeping

- [ ] Update `memory/project_gutenberg_typist.md` (schema-1 shipped locally, SPEC.md normative + 8 amendments, what died, deploy chain unchanged and still gated on Cloudflare token).
- [ ] Task list: close plan tasks; re-point #9 (deploy) to note seed.sql is schema-1 now; #11 cutover gains "delete PLAN-SCHEMA1.md or mark executed; update SCALING/DESIGN-10K status headers to mention schema 1".

## Self-review checklist (run after writing, before executing)

Spec coverage: §2 envelope (T2), §3 fields (T2/T5), §4 union/conflict/no-op (T3/T5), §5.1 active time (T5/T6), §5.2 accounting (T5), §5.3 formulas (T2 derive + T5 recap), §6 validation split (T2/T3), §7 refusal (T2/T5), §8 exclusions (T5 never records timestamps), §9 migration (T5/T6, amendments 6/8). Placeholders: none — every rule has exact values. Type consistency: `Row`/`SessionRecord`/`new_sessions` names identical across T2–T5.
