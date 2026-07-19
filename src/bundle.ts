// SPEC.md schema 1: a bundle is a set of immutable session records; merge is
// set union by id. Validation splits per §6 — structural problems reject the
// whole bundle, plausibility problems flag the record (the "?" badge).
// Keep this file, the plugin's storage.vim, and both test suites in lockstep
// with SPEC.md.

export const SCHEMA_VERSION = 1;
export const MAX_BUNDLE_BYTES = 1_000_000;
export const PLAUSIBLE_WPM_CEILING = 300; // §6
export const MIN_BEST_SESSION_ACTIVE_MS = 10_000; // consumer rule: sub-10s flukes never set bests

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const MAX_MACHINE_CHARS = 100;
const MAX_TITLE_CHARS = 200;

export interface SessionRecord {
  id: string;
  machine: string;
  date: string;
  book?: { gutenberg_id: number; title?: string }; // absent only on legacy records (§9)
  range?: { start: number; end: number };
  active_ms: number;
  wall_ms: number;
  chars_typed: number;
  errors_uncorrected: number;
  corrections?: number;
  legacy?: boolean;
  [key: string]: unknown; // unknown fields are preserved (§2)
}

export interface ParsedBundle {
  user?: string;
  sessions: SessionRecord[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonNegInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

// Sorted-keys, no-whitespace JSON (§4). Record identity conflicts are a
// string compare of this; the seed generator's json.dumps(sort_keys=True,
// separators=(",",":"), ensure_ascii=False) is the same algorithm.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (isObj(value)) {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

// Structural check of one record (§3, §6). Returns a reason or null.
function recordError(raw: unknown): string | null {
  if (!isObj(raw)) return "record is not an object";
  if (typeof raw.id !== "string" || !UUID_RE.test(raw.id))
    return "id must be a lowercase UUID";
  if (
    typeof raw.machine !== "string" ||
    raw.machine.length === 0 ||
    [...raw.machine].length > MAX_MACHINE_CHARS
  )
    return "machine must be a 1-100 character string";
  if (typeof raw.date !== "string" || !DATE_RE.test(raw.date))
    return "date must be a valid YYYY-MM-DD";
  if (raw.legacy !== undefined && typeof raw.legacy !== "boolean")
    return "legacy must be a boolean";
  if (raw.book === undefined) {
    if (raw.legacy !== true) return "book is required on non-legacy records";
  } else {
    if (!isObj(raw.book)) return "book must be an object";
    if (!isNonNegInt(raw.book.gutenberg_id))
      return "book.gutenberg_id must be a non-negative integer";
    if (
      raw.book.title !== undefined &&
      (typeof raw.book.title !== "string" ||
        [...raw.book.title].length > MAX_TITLE_CHARS)
    )
      return "book.title must be a string of at most 200 characters";
  }
  if (raw.range !== undefined) {
    if (
      !isObj(raw.range) ||
      !isNonNegInt(raw.range.start) ||
      !isNonNegInt(raw.range.end)
    )
      return "range must be {start, end} with non-negative integers";
    if (raw.range.end < raw.range.start)
      return "range.end must not be less than range.start";
  }
  for (const key of [
    "active_ms",
    "wall_ms",
    "chars_typed",
    "errors_uncorrected",
  ] as const) {
    if (!isNonNegInt(raw[key])) return `${key} must be a non-negative integer`;
  }
  if (raw.corrections !== undefined && !isNonNegInt(raw.corrections))
    return "corrections must be a non-negative integer";
  return null;
}

export function parseBundle(text: string): {
  bundle: ParsedBundle | null;
  error: string | null;
} {
  const fail = (error: string) => ({ bundle: null, error });
  if (new TextEncoder().encode(text).length > MAX_BUNDLE_BYTES) {
    return fail("bundle larger than 1 MB");
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail("unreadable (not valid JSON)");
  }
  if (!isObj(data)) return fail("not a JSON object");
  if (data.schema !== SCHEMA_VERSION) {
    if (typeof data.schema === "number" && data.schema > SCHEMA_VERSION) {
      return fail(
        `schema ${data.schema} not supported — this guild understands schema ${SCHEMA_VERSION}`,
      );
    }
    return fail("not a schema-1 bundle");
  }
  if (data.user !== undefined && typeof data.user !== "string") {
    return fail("user must be a string");
  }
  if (!Array.isArray(data.sessions)) return fail("sessions must be an array");

  const byId = new Map<string, { record: SessionRecord; canonical: string }>();
  for (const [i, raw] of data.sessions.entries()) {
    const err = recordError(raw);
    if (err !== null) return fail(`sessions[${i}]: ${err}`);
    const record = raw as SessionRecord;
    const canonical = canonicalJson(record);
    const seen = byId.get(record.id);
    if (seen) {
      if (seen.canonical !== canonical) {
        // §4: same id, different content — a record is immutable once created.
        return fail(
          `sessions[${i}]: duplicate id ${record.id} with different content`,
        );
      }
      continue; // byte-identical duplicate: union makes it a no-op
    }
    byId.set(record.id, { record, canonical });
  }

  return {
    bundle: {
      ...(typeof data.user === "string" && { user: data.user }),
      sessions: [...byId.values()].map((v) => v.record),
    },
    error: null,
  };
}

// §5.3. Zero active time yields 0 rather than dividing by zero; the
// zero-active-with-chars case is flagged by isImplausible instead.
export function grossWpm(r: SessionRecord): number {
  return r.active_ms > 0 ? r.chars_typed / 5 / (r.active_ms / 60_000) : 0;
}

// §6 plausibility. Advisory: feeds the "?" badge, never rejects. The
// chars_typed-vs-book-length check is skipped — the server has no book texts.
export function isImplausible(r: SessionRecord): boolean {
  if (r.active_ms > r.wall_ms) return true;
  if (r.errors_uncorrected > r.chars_typed) return true;
  if (r.range) {
    const span = r.range.end - r.range.start;
    if (Math.abs(span - r.chars_typed) > 0.1 * r.chars_typed) return true;
  }
  if (r.active_ms === 0 && r.chars_typed > 0) return true;
  return grossWpm(r) > PLAUSIBLE_WPM_CEILING;
}

export interface MachineSummary {
  chars: number;
  hours: number;
  sessions: number;
  best_wpm: number;
}

export interface BookSummary {
  book_id: number;
  title: string;
  chars: number;
  sessions: number;
  last_date: string;
}

export interface Row {
  user: string;
  seed: boolean;
  best_wpm: number;
  avg_wpm: number;
  accuracy: number;
  hours: number;
  total_chars: number;
  sessions: number;
  books: number;
  machines_count: number;
  last_date: string;
  suspicious: boolean;
  machines: Record<string, MachineSummary>;
  books_detail: BookSummary[];
}

const round1 = (x: number) => Math.round(x * 10) / 10;

// A legacy record stands in for its machine's whole v0 history; its
// preserved counter map says how many sessions that was (§9).
function sessionsRepresented(r: SessionRecord): number {
  if (r.legacy !== true) return 1;
  const lc = r["legacy_counters"];
  if (isObj(lc)) {
    const n = lc.sessions_count;
    if (typeof n === "number" && Number.isFinite(n) && n > 0)
      return Math.round(n);
  }
  return 1;
}

// Consumer display rule: legacy history, sub-10s flukes, and flagged
// (implausible) records never set bests — a fabricated 320-wpm session
// earns the "?" badge without also topping the board.
const setsBest = (r: SessionRecord & { flagged: boolean }): boolean =>
  r.legacy !== true && !r.flagged && r.active_ms >= MIN_BEST_SESSION_ACTIVE_MS;

export function deriveRow(
  login: string,
  seed: boolean,
  records: Array<SessionRecord & { flagged: boolean }>,
): Row {
  let chars = 0;
  let errors = 0;
  let corrections = 0;
  let activeMs = 0;
  let sessions = 0;
  let best = 0;
  let lastDate = "";
  let suspicious = false;
  const machines: Record<string, MachineSummary> = {};
  const books = new Map<number, BookSummary>();

  for (const r of records) {
    chars += r.chars_typed;
    errors += r.errors_uncorrected;
    corrections += r.corrections ?? 0;
    activeMs += r.active_ms;
    sessions += sessionsRepresented(r);
    if (setsBest(r)) best = Math.max(best, grossWpm(r));
    if (r.date > lastDate) lastDate = r.date;
    suspicious = suspicious || r.flagged;

    const m = (machines[r.machine] ??= {
      chars: 0,
      hours: 0,
      sessions: 0,
      best_wpm: 0,
    });
    m.chars += r.chars_typed;
    m.hours += r.active_ms; // ms until the rounding pass below
    m.sessions += sessionsRepresented(r);
    if (setsBest(r)) m.best_wpm = Math.max(m.best_wpm, Math.round(grossWpm(r)));

    if (r.book && r.legacy !== true) {
      const b = books.get(r.book.gutenberg_id) ?? {
        book_id: r.book.gutenberg_id,
        title: "",
        chars: 0,
        sessions: 0,
        last_date: "",
      };
      if (r.book.title) b.title = r.book.title;
      b.chars += r.chars_typed;
      b.sessions += 1;
      if (r.date > b.last_date) b.last_date = r.date;
      books.set(r.book.gutenberg_id, b);
    }
  }
  for (const m of Object.values(machines))
    m.hours = round1(m.hours / 3_600_000);

  const minutes = activeMs / 60_000;
  const accuracyDenom = chars + corrections;
  return {
    user: login,
    seed,
    best_wpm: Math.round(best),
    avg_wpm: round1(minutes > 0 ? chars / 5 / minutes : 0),
    accuracy: round1(
      accuracyDenom > 0 ? ((chars - errors) * 100) / accuracyDenom : 0,
    ),
    hours: round1(activeMs / 3_600_000),
    total_chars: chars,
    sessions,
    books: books.size,
    machines_count: Object.keys(machines).length,
    last_date: lastDate,
    suspicious,
    machines,
    books_detail: [...books.values()].sort((a, b) =>
      a.last_date === b.last_date
        ? b.chars - a.chars
        : b.last_date.localeCompare(a.last_date),
    ),
  };
}
