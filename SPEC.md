# GT Bundle Format Specification

**Version:** 1.0-draft
**Status:** Proposal
**Scope:** The data packet emitted by `:GT export` in gutenberg-typist and consumed by typist-guild (and any other consumer).

The key words MUST, MUST NOT, SHOULD, and MAY are to be interpreted as described in RFC 2119.

---

## 1. Design principles

1. **Facts, not conclusions.** The bundle carries per-session observations. Aggregates (lifetime WPM, totals, ranks) are derived by consumers and MUST NOT appear in the bundle.
2. **Set semantics.** A bundle is a set of session records keyed by session id. Merging two bundles is set union. Merge is therefore idempotent, commutative, and associative with no field-level invariants to police.
3. **Self-describing measurement.** "WPM" and "accuracy" are not standard units. Every quantity in this spec has a pinned definition (§5) tied to the schema version, so a consumer can interpret values without reading the emitter's source.
4. **Privacy by construction.** The exported bundle MUST NOT contain keystroke-level data, precise timestamps, or typed content. What leaves the machine is coarse enough to publish.

## 2. File layout

A bundle is a single UTF-8 JSON file. Top level:

```json
{
  "schema": 1,
  "generator": "gutenberg-typist/0.4.0",
  "user": "5x5x5x5",
  "sessions": [ ... ]
}
```

| Field | Type | Req | Description |
|---|---|---|---|
| `schema` | integer | MUST | Major schema version. This document defines `1`. |
| `generator` | string | SHOULD | Emitting tool and version, `name/semver`. Diagnostic only; consumers MUST NOT branch on it. |
| `user` | string | MUST | GitHub login of the owner. Consumers that accept submissions MUST verify this against the authenticated submitter and MUST NOT trust it bare. |
| `sessions` | array | MUST | Zero or more session records (§3). Order is not significant. |

Unknown top-level fields MUST be preserved by tools that rewrite bundles and MUST be ignored by consumers.

## 3. Session record

One record per typing session. A session begins when the typing buffer opens and ends at `:GT stop`, buffer close, or Vim exit.

```json
{
  "id": "f3d2c8a1-7b4e-4c9a-9e21-0a8f6d5b3c17",
  "machine": "sable",
  "date": "2026-07-19",
  "book": { "gutenberg_id": 1342, "title": "Pride and Prejudice" },
  "range": { "start": 10412, "end": 13876 },
  "active_ms": 1284000,
  "wall_ms": 1631000,
  "chars_typed": 3464,
  "errors_uncorrected": 21,
  "corrections": 118
}
```

| Field | Type | Req | Description |
|---|---|---|---|
| `id` | string (UUIDv4) | MUST | Assigned once at session creation and persisted in the local session file. It MUST NOT change on re-export. This is the identity for merge (§4). |
| `machine` | string | MUST | Emitting machine label. Defaults to hostname; users MAY override via `g:gt_machine_id`. Emitters SHOULD warn when the default hostname is exported. |
| `date` | string | MUST | Local calendar date of session start, `YYYY-MM-DD`. Precise start/end times MUST NOT be exported (they publish daily routine). Emitters MAY keep precise times locally. |
| `book` | object | MUST | `gutenberg_id` (integer, MUST); `title` (string, SHOULD — convenience only, id is authoritative). |
| `range` | object | SHOULD | Zero-based character offsets `[start, end)` into the cleaned book text covered by the session. Enables per-book progress and difficulty analysis. |
| `active_ms` | integer | MUST | Active typing time in milliseconds (§5.1). |
| `wall_ms` | integer | MUST | Wall-clock session duration in milliseconds. `active_ms <= wall_ms`. |
| `chars_typed` | integer | MUST | Count of source characters advanced past, i.e. correct-final characters (§5.2). |
| `errors_uncorrected` | integer | MUST | Characters wrong in the final transcript (§5.2). |
| `corrections` | integer | SHOULD | Characters that were typed wrong and then fixed. Distinguishes clean typists from fast-but-sloppy ones. |

Unknown session fields: same preserve/ignore rule as §2.

Sessions with `chars_typed == 0` MAY be omitted from export.

## 4. Merge semantics

Merging bundles A and B for the same `user`:

1. Result `sessions` = union of A.sessions and B.sessions keyed by `id`.
2. Two records with the same `id` MUST be byte-identical after canonicalization (sorted keys, no insignificant whitespace). If they differ, the merge MUST fail loudly; a session record is immutable once created.
3. Re-submitting an already-merged export is a no-op by construction.

There is no field-wise arithmetic. Multi-machine use requires no coordination: each machine emits sessions with its own ids and they union cleanly.

Deletion: a user removes a session by removing the record from their bundle. Consumers rebuild aggregates from the current set; there are no tombstones in v1.

## 5. Measurement definitions

These definitions are normative for schema 1. A change to any of them is a major version bump.

### 5.1 Active time

Active time is wall time minus idle gaps. A gap between consecutive keystrokes longer than **5 seconds** is excluded in full. The 5s threshold is part of the schema; emitters MUST NOT make it configurable in a way that affects exported values.

### 5.2 Character accounting

- `chars_typed`: number of source-text positions the cursor legitimately advanced past. Whitespace and punctuation count; a character re-typed after correction counts once.
- `errors_uncorrected`: positions where the final typed character differs from the source. (In gutenberg-typist's current UI the cursor cannot advance past a mismatch, so this is normally 0; the field exists so alternative emitters and future modes are representable.)
- `corrections`: number of backspace-and-retype events resolving to a correct character.

### 5.3 Derived metrics (informative)

Consumers SHOULD use these formulas so numbers are comparable across boards:

- **Gross WPM** = `(chars_typed / 5) / (active_ms / 60000)`
- **Net WPM** = `((chars_typed - errors_uncorrected) / 5) / (active_ms / 60000)`
- **Accuracy** = `(chars_typed - errors_uncorrected) / (chars_typed + corrections)`

The 5-characters-per-word convention is fixed. Consumers MAY compute anything else they like from the records; that is the point of shipping records.

## 6. Validation

A consumer accepting third-party bundles MUST reject bundles that fail structural validation (missing MUST fields, wrong types, malformed UUIDs/dates) and SHOULD flag—rather than reject—records failing plausibility checks:

- `active_ms <= wall_ms`
- `errors_uncorrected <= chars_typed`
- `range.end - range.start` within ±10% of `chars_typed` when `range` is present
- `chars_typed <= length` of the referenced book's cleaned text
- Implied gross WPM ≤ 300

Flagged records feed the existing `?` badge mechanism. Plausibility checks are advisory; this remains an honor system, and the spec makes no stronger claim.

## 7. Versioning and compatibility

- `schema` is a single major integer. Additive optional fields do not bump it; consumers ignore unknown fields, tools preserve them.
- Any change to a MUST field, to merge semantics (§4), or to measurement definitions (§5) bumps `schema`.
- Consumers MUST refuse bundles with a `schema` greater than they understand, and SHOULD accept all lower versions they have ever supported.
- Emitters MUST NOT mix schema versions within one bundle. A migrating emitter rewrites old records to the new schema in one pass, preserving `id`s.

## 8. What is deliberately excluded

- **Keystroke logs and inter-key timings.** Timing vectors are effectively biometric (they can fingerprint a typist and leak content). They MUST NOT leave the machine.
- **Precise timestamps.** Date only (§3).
- **Lifetime aggregates.** Derivable; shipping them reintroduces merge invariants this spec exists to eliminate.
- **Typed text.** The `range` into a public-domain book is sufficient for any analysis.

## 9. Migration from bundle v0 (field-wise-max counters)

Legacy lifetime-counter bundles cannot be losslessly converted to sessions. The migration is: emit one **synthetic session per (machine)** carrying the legacy totals, with `id` derived deterministically as UUIDv5 of `(user, machine, "legacy-v0")`, `date` set to the migration date, and a `"legacy": true` marker field. Consumers SHOULD display legacy records in lifetime totals but exclude them from time-series and per-session leaderboards. New exports append real sessions alongside.
