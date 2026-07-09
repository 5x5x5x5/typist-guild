// Port of build.py's pure validate/merge/derive functions. build.py is the
// reference implementation (it still builds the git-era archive); the parity
// suite in test/bundle.spec.ts mirrors tests/test_build.py case-for-case.
// If you change semantics here, change build.py and both suites together.

export const FORMAT_VERSION = 1;
export const MAX_BUNDLE_BYTES = 1_000_000;
export const SUSPICIOUS_WPM = 250;
const MAX_MACHINE_ID_CHARS = 40;

export type Counters = Record<string, number>;
export type Machines = Record<string, Counters>;
export interface Session {
  book_id: number;
  offset: number;
  total_chars_typed?: number;
  correct_chars?: number;
  last_active?: number;
}
export type Sessions = Record<string, Session>;

export interface CleanBundle {
  machines: Machines;
  sessions: Sessions;
  exported_at: number;
}

export interface Row {
  user: string;
  best_wpm: number;
  avg_wpm: number;
  accuracy: number;
  hours: number;
  total_chars: number;
  sessions: number;
  books: number;
  machines_count: number;
  exported_at: number;
  suspicious: boolean;
  machines: Machines;
  books_detail: Session[];
}

// Coerce a JSON value to a non-negative int; reject everything else.
// (JSON.parse cannot produce Infinity/NaN, unlike Python's json.loads —
// those inputs already fail at the parse step here, same net rejection.)
function asInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  return n >= 0 ? n : null;
}

// Machine ids are user-controlled free text shown verbatim on the board:
// cap the length and drop non-printable characters before display.
// \p{C} = control/format/unassigned, \p{Z} = separators (space kept).
export function sanitizeMachineId(machineId: string): string {
  const cleaned = [...machineId]
    .filter((ch) => ch === " " || !/[\p{C}\p{Z}]/u.test(ch))
    .join("")
    .trim();
  return [...cleaned].slice(0, MAX_MACHINE_ID_CHARS).join("");
}

function cleanMachines(raw: unknown): Machines {
  const machines: Machines = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return machines;
  for (const [rawId, record] of Object.entries(raw)) {
    if (typeof record !== "object" || record === null || Array.isArray(record))
      continue;
    const machineId = sanitizeMachineId(rawId);
    if (machineId === "") continue;
    const clean: Counters = {};
    for (const [key, value] of Object.entries(record)) {
      const n = asInt(value);
      if (n !== null) clean[key] = n;
    }
    if (Object.keys(clean).length) machines[machineId] = clean;
  }
  return machines;
}

function cleanSessions(raw: unknown): Sessions {
  const sessions: Sessions = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return sessions;
  for (const [bookId, record] of Object.entries(raw)) {
    // ASCII digits only — JS \d is ASCII-only, mirroring the plugin's '^\d\+$'
    if (!/^\d+$/.test(bookId)) continue;
    if (typeof record !== "object" || record === null || Array.isArray(record))
      continue;
    const rec = record as Record<string, unknown>;
    const offset = asInt(rec.offset);
    if (offset === null) continue;
    const clean: Session = { book_id: Number(bookId), offset };
    for (const key of [
      "total_chars_typed",
      "correct_chars",
      "last_active",
    ] as const) {
      const n = asInt(rec[key]);
      if (n !== null) clean[key] = n;
    }
    sessions[bookId] = clean;
  }
  return sessions;
}

// Field-wise max over the union of keys — mirrors autoload/gt/storage.vim.
export function mergeMachines(local: Machines, incoming: Machines): Machines {
  const merged: Machines = Object.fromEntries(
    Object.entries(local).map(([id, rec]) => [id, { ...rec }]),
  );
  for (const [machineId, record] of Object.entries(incoming)) {
    const current = (merged[machineId] ??= {});
    for (const [key, value] of Object.entries(record)) {
      current[key] = Math.max(current[key] ?? 0, value);
    }
  }
  return merged;
}

// Newer last_active wins; ties keep local — mirrors gt#storage#MergeSession.
export function mergeSessions(local: Sessions, incoming: Sessions): Sessions {
  const merged: Sessions = { ...local };
  for (const [bookId, record] of Object.entries(incoming)) {
    const current = merged[bookId];
    if (
      current === undefined ||
      (record.last_active ?? 0) > (current.last_active ?? 0)
    ) {
      merged[bookId] = record;
    }
  }
  return merged;
}

export function loadBundle(text: string): {
  bundle: CleanBundle | null;
  error: string | null;
} {
  if (new TextEncoder().encode(text).length > MAX_BUNDLE_BYTES) {
    return { bundle: null, error: "bundle larger than 1 MB" };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { bundle: null, error: "unreadable (not valid JSON)" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { bundle: null, error: "not a JSON object" };
  }
  const obj = data as Record<string, unknown>;
  if (obj.format_version !== FORMAT_VERSION) {
    return {
      bundle: null,
      error: `format_version ${JSON.stringify(obj.format_version)} not supported`,
    };
  }
  const machines = cleanMachines(obj.machines);
  if (!Object.keys(machines).length) {
    return { bundle: null, error: "no valid machine records" };
  }
  return {
    bundle: {
      machines,
      sessions: cleanSessions(obj.sessions),
      exported_at: asInt(obj.exported_at) ?? 0,
    },
    error: null,
  };
}

export function derive(user: string, bundle: CleanBundle): Row {
  const machines = bundle.machines;
  const records = Object.values(machines);
  const sum = (key: string) =>
    records.reduce((acc, r) => acc + (r[key] ?? 0), 0);
  const chars = sum("total_chars");
  const correct = sum("correct_chars");
  const seconds = sum("total_time_seconds");
  const minutes = seconds / 60;
  const bestWpm = records.reduce((acc, r) => Math.max(acc, r.best_wpm ?? 0), 0);
  const round1 = (x: number) => Math.round(x * 10) / 10;
  return {
    user,
    best_wpm: bestWpm,
    avg_wpm: round1(minutes > 0 ? chars / 5 / minutes : 0),
    accuracy: round1(chars > 0 ? (correct * 100) / chars : 0),
    hours: round1(seconds / 3600),
    total_chars: chars,
    sessions: sum("sessions_count"),
    books: Object.keys(bundle.sessions).length,
    machines_count: records.length,
    exported_at: bundle.exported_at,
    suspicious: bestWpm > SUSPICIOUS_WPM || correct > chars,
    machines,
    books_detail: Object.values(bundle.sessions).sort(
      (a, b) => (b.last_active ?? 0) - (a.last_active ?? 0),
    ),
  };
}
