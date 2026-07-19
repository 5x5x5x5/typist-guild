// Unit suite for SPEC.md schema 1: structural problems reject the bundle,
// plausibility problems flag the record. Mirrors the plugin harness cases —
// keep src/bundle.ts, storage.vim, and both suites in lockstep with SPEC.md.
import { describe, expect, it } from "vitest";
import {
  MAX_BUNDLE_BYTES,
  SessionRecord,
  canonicalJson,
  deriveRow,
  grossWpm,
  isImplausible,
  parseBundle,
} from "../src/bundle";

let uuidCounter = 0;
const uuid = () =>
  `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`;

const record = (overrides: Record<string, unknown> = {}) => ({
  id: uuid(),
  machine: "sable",
  date: "2026-07-19",
  book: { gutenberg_id: 1342, title: "Pride and Prejudice" },
  range: { start: 0, end: 3000 },
  active_ms: 600_000, // 10 min → gross 60 wpm at 3000 chars
  wall_ms: 700_000,
  chars_typed: 3000,
  errors_uncorrected: 30,
  corrections: 100,
  ...overrides,
});

const bundle = (sessions: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ schema: 1, generator: "test/0.0.0", sessions, ...extra });

const parseErr = (text: string): string => {
  const { bundle: b, error } = parseBundle(text);
  expect(b).toBeNull();
  expect(error).not.toBeNull();
  return error as string;
};

describe("parseBundle structural rejection", () => {
  it("rejects non-JSON", () => {
    expect(parseErr("nope")).toMatch(/JSON/);
  });

  it("rejects a top-level array", () => {
    expect(parseErr("[]")).toMatch(/object/);
  });

  it("refuses schema 2 with upgrade wording", () => {
    expect(parseErr(bundle([record()], { schema: 2 }))).toContain(
      "schema 2 not supported",
    );
  });

  it('rejects schema "1" (string)', () => {
    expect(parseErr(bundle([record()], { schema: "1" }))).toMatch(/schema/);
  });

  it("rejects a missing schema field", () => {
    expect(parseErr(JSON.stringify({ sessions: [] }))).toMatch(/schema/);
  });

  it("rejects a non-array sessions field", () => {
    expect(parseErr(JSON.stringify({ schema: 1, sessions: {} }))).toMatch(
      /sessions must be an array/,
    );
  });

  it("rejects a non-string user field", () => {
    expect(parseErr(bundle([record()], { user: 42 }))).toMatch(/user/);
  });

  it("rejects bundles over 1 MB", () => {
    const big = bundle([record({ pad: "x".repeat(MAX_BUNDLE_BYTES) })]);
    expect(parseErr(big)).toMatch(/1 MB/);
  });

  it("names the record index and field on a missing counter", () => {
    const bad = record() as Record<string, unknown>;
    delete bad.chars_typed;
    const err = parseErr(bundle([record(), bad]));
    expect(err).toContain("sessions[1]");
    expect(err).toContain("chars_typed");
  });

  it("rejects uppercase UUIDs (case variants would double-count)", () => {
    expect(
      parseErr(
        bundle([record({ id: "ABCDEF00-0000-4000-8000-0000000000AB" })]),
      ),
    ).toMatch(/lowercase UUID/);
  });

  it("rejects malformed dates like 2026-13-01", () => {
    expect(parseErr(bundle([record({ date: "2026-13-01" })]))).toMatch(/date/);
  });

  it("rejects machine labels over 100 characters", () => {
    expect(parseErr(bundle([record({ machine: "m".repeat(101) })]))).toMatch(
      /machine/,
    );
  });

  it("rejects titles over 200 characters", () => {
    expect(
      parseErr(
        bundle([record({ book: { gutenberg_id: 1, title: "t".repeat(201) } })]),
      ),
    ).toMatch(/title/);
  });

  it("rejects non-integer active_ms", () => {
    expect(parseErr(bundle([record({ active_ms: 1.5 })]))).toMatch(/active_ms/);
  });

  it("rejects negative errors_uncorrected", () => {
    expect(parseErr(bundle([record({ errors_uncorrected: -1 })]))).toMatch(
      /errors_uncorrected/,
    );
  });

  it("rejects range with end < start", () => {
    expect(
      parseErr(bundle([record({ range: { start: 10, end: 5 } })])),
    ).toMatch(/range/);
  });

  it("requires book unless legacy", () => {
    const noBook = record() as Record<string, unknown>;
    delete noBook.book;
    delete noBook.range;
    expect(parseErr(bundle([noBook]))).toMatch(/book/);
    const { bundle: ok, error } = parseBundle(
      bundle([{ ...noBook, legacy: true }]),
    );
    expect(error).toBeNull();
    expect(ok!.sessions[0].legacy).toBe(true);
  });

  it("errors on same-id records with different content", () => {
    const a = record();
    const b = { ...record(), id: a.id, chars_typed: 9999 };
    const err = parseErr(bundle([a, b]));
    expect(err).toContain(a.id);
  });

  it("silently dedupes byte-identical duplicates", () => {
    const a = record();
    const { bundle: b, error } = parseBundle(bundle([a, { ...a }]));
    expect(error).toBeNull();
    expect(b!.sessions).toHaveLength(1);
  });

  it("preserves unknown fields on parsed records", () => {
    const a = record({ custom: { b: 1, a: [2, 3] } });
    const { bundle: b } = parseBundle(bundle([a]));
    expect(canonicalJson(b!.sessions[0])).toBe(canonicalJson(a));
  });
});

describe("canonicalJson", () => {
  it("is key-order invariant", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("recurses into nested objects but keeps array order", () => {
    expect(canonicalJson({ z: [{ y: 1, x: 2 }, 3] })).toBe(
      '{"z":[{"x":2,"y":1},3]}',
    );
  });

  it("handles unicode values", () => {
    expect(canonicalJson({ 名: "黛玉" })).toBe('{"名":"黛玉"}');
  });
});

describe("plausibility (§6): flag, never reject", () => {
  const r = (o: Record<string, unknown> = {}) =>
    record(o) as unknown as SessionRecord;

  it("computes gross wpm", () => {
    expect(grossWpm(r())).toBeCloseTo(60);
    expect(grossWpm(r({ active_ms: 0 }))).toBe(0);
  });

  it("accepts a plausible record", () => {
    expect(isImplausible(r())).toBe(false);
  });

  it("flags active_ms > wall_ms", () => {
    expect(isImplausible(r({ wall_ms: 1 }))).toBe(true);
  });

  it("flags errors > chars", () => {
    expect(isImplausible(r({ errors_uncorrected: 3001 }))).toBe(true);
  });

  it("flags range span off by more than 10%", () => {
    expect(isImplausible(r({ range: { start: 0, end: 4000 } }))).toBe(true);
    expect(isImplausible(r({ range: { start: 0, end: 3100 } }))).toBe(false);
  });

  it("flags implied gross wpm over 300", () => {
    expect(
      isImplausible(
        r({
          active_ms: 60_000,
          wall_ms: 60_000,
          chars_typed: 1505,
          errors_uncorrected: 0,
          range: { start: 0, end: 1505 },
        }),
      ),
    ).toBe(true);
  });

  it("flags chars with zero active time", () => {
    expect(isImplausible(r({ active_ms: 0, wall_ms: 0 }))).toBe(true);
  });

  it("still parses (does not reject) an implausible record", () => {
    const { bundle: b, error } = parseBundle(bundle([record({ wall_ms: 1 })]));
    expect(error).toBeNull();
    expect(b!.sessions).toHaveLength(1);
  });
});

describe("deriveRow (§5.3)", () => {
  type Flagged = SessionRecord & { flagged: boolean };
  const flag = (o: Record<string, unknown> = {}, flagged = false): Flagged =>
    ({ ...record(o), flagged }) as unknown as Flagged;

  it("computes the §5.3 formulas over two sessions", () => {
    const row = deriveRow("ishmael", false, [
      flag(),
      flag({
        date: "2026-07-20",
        book: { gutenberg_id: 2701, title: "Moby-Dick" },
        range: { start: 0, end: 4000 },
        chars_typed: 4000, // 10 min → gross 80
        errors_uncorrected: 0,
        corrections: 0,
      }),
    ]);
    expect(row.user).toBe("ishmael");
    expect(row.seed).toBe(false);
    expect(row.total_chars).toBe(7000);
    expect(row.avg_wpm).toBe(70); // 7000/5 over 20 min
    expect(row.accuracy).toBe(98.2); // (7000-30)/(7000+100)
    expect(row.hours).toBe(0.3);
    expect(row.best_wpm).toBe(80);
    expect(row.sessions).toBe(2);
    expect(row.books).toBe(2);
    expect(row.machines_count).toBe(1);
    expect(row.last_date).toBe("2026-07-20");
    expect(row.suspicious).toBe(false);
    expect(row.machines.sable).toEqual({
      chars: 7000,
      hours: 0.3,
      sessions: 2,
      best_wpm: 80,
    });
    expect(row.books_detail[0].book_id).toBe(2701); // newest first
    expect(row.books_detail[1].title).toBe("Pride and Prejudice");
  });

  it("excludes flagged records from best_wpm (badge without the crown)", () => {
    const row = deriveRow("uriah", false, [
      flag(),
      flag(
        {
          active_ms: 480_000,
          wall_ms: 480_000,
          chars_typed: 25_600, // 320 wpm
          errors_uncorrected: 0,
          corrections: 0,
          range: { start: 0, end: 25_600 },
        },
        true,
      ),
    ]);
    expect(row.best_wpm).toBe(60);
    expect(row.suspicious).toBe(true);
  });

  it("excludes sub-10s sessions from best_wpm", () => {
    const row = deriveRow("u", false, [
      flag(),
      flag(
        {
          active_ms: 5000,
          wall_ms: 5000,
          chars_typed: 5000,
          range: { start: 0, end: 5000 },
        },
        true,
      ),
    ]);
    expect(row.best_wpm).toBe(60);
  });

  it("counts legacy records in totals but not bests or books", () => {
    const legacy = {
      id: uuid(),
      machine: "old-laptop",
      date: "2026-07-19",
      legacy: true,
      legacy_counters: { sessions_count: 42, total_chars: 50_000 },
      active_ms: 7_200_000, // 2 h
      wall_ms: 7_200_000,
      chars_typed: 50_000,
      errors_uncorrected: 1000,
      flagged: false,
    } as unknown as Flagged;
    const row = deriveRow("danny", false, [flag(), legacy]);
    expect(row.sessions).toBe(43); // 1 real + 42 legacy
    expect(row.hours).toBe(2.2); // 2 h legacy + 10 min real
    expect(row.best_wpm).toBe(60); // legacy gross (~83) excluded
    expect(row.books).toBe(1);
    expect(row.books_detail).toHaveLength(1);
    expect(row.machines_count).toBe(2);
  });

  it("returns a zero row for no records", () => {
    const row = deriveRow("ghost", false, []);
    expect(row.total_chars).toBe(0);
    expect(row.best_wpm).toBe(0);
    expect(row.accuracy).toBe(0);
    expect(row.last_date).toBe("");
    expect(row.suspicious).toBe(false);
  });

  it("marks suspicious when any record is flagged", () => {
    expect(deriveRow("u", false, [flag({}, true)]).suspicious).toBe(true);
  });

  it("passes the seed flag through", () => {
    expect(deriveRow("林黛玉", true, [flag()]).seed).toBe(true);
  });
});
