// Integration tests against the real Worker (SELF) with a real (local) D1,
// schema-1 wire format throughout.
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { makeSessionCookie, sha256Hex } from "../src/auth";

const TOKEN = `gt_${"a".repeat(64)}`;
const BASE = "http://guild.test";

let uuidCounter = 0;
const uuid = () =>
  `11111111-1111-4111-8111-${String(++uuidCounter).padStart(12, "0")}`;

const record = (overrides: Record<string, unknown> = {}) => ({
  id: uuid(),
  machine: "test-box",
  date: "2026-07-19",
  book: { gutenberg_id: 1342, title: "Pride and Prejudice" },
  range: { start: 0, end: 3000 },
  active_ms: 600_000, // 10 min → gross 60 wpm
  wall_ms: 700_000,
  chars_typed: 3000,
  errors_uncorrected: 30,
  corrections: 100,
  ...overrides,
});

const bundleBody = (sessions: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: 1,
    generator: "test/0.0.0",
    sessions,
    ...extra,
  });

async function createUser(id: number, login: string, withToken = true) {
  await env.DB.prepare(
    "INSERT INTO users (id, login, created_at, token_hash) VALUES (?1, ?2, 0, ?3)",
  )
    .bind(id, login, withToken ? await sha256Hex(TOKEN) : null)
    .run();
}

const upload = (
  body: string,
  headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` },
) => SELF.fetch(`${BASE}/api/v1/upload`, { method: "POST", headers, body });

const board = async () =>
  (await (await SELF.fetch(`${BASE}/api/v1/board`)).json()) as {
    users: Array<Record<string, any>>;
    skipped: unknown[];
  };

// Backdate the last submission so the 30 s throttle doesn't bite mid-test.
const backdateSubmissions = (seconds: number) =>
  env.DB.prepare("UPDATE submissions SET received_at = received_at - ?1")
    .bind(seconds)
    .run();

beforeEach(async () => {
  for (const table of ["submissions", "sessions", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("GET /api/v1/board", () => {
  it("returns an empty board", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/board`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const data = await board();
    expect(data.users).toEqual([]);
    expect(data.skipped).toEqual([]);
  });

  it("derives rows, sorts by best_wpm, and marks negative-id users as seeds", async () => {
    await createUser(1, "slow");
    await createUser(-2, "林黛玉", false);
    await upload(bundleBody([record()])); // slow: 60 wpm
    // Seeds are inserted directly (they have no tokens and can never upload);
    // the board derives everything from canonical_json.
    const seedRec = record({
      machine: "m",
      date: "2026-07-01",
      book: { gutenberg_id: 24264, title: "Dream" },
      range: { start: 0, end: 4500 },
      chars_typed: 4500, // 90 wpm
      errors_uncorrected: 0,
      corrections: 0,
    });
    await env.DB.prepare(
      `INSERT INTO sessions (user_id, id, machine, date, book_id, title,
         active_ms, wall_ms, chars_typed, errors_uncorrected, corrections,
         legacy, flagged, canonical_json, received_at)
       VALUES (-2, ?1, 'm', '2026-07-01', 24264, 'Dream', 600000, 700000,
         4500, 0, 0, 0, 0, ?2, 0)`,
    )
      .bind(seedRec.id, JSON.stringify(seedRec))
      .run();
    const data = await board();
    expect(data.users.map((u) => u.user)).toEqual(["林黛玉", "slow"]);
    expect(data.users[0].seed).toBe(true);
    expect(data.users[1].seed).toBe(false);
    expect(data.users[0].best_wpm).toBe(90);
  });

  it("exposes fold detail: machine summaries and book titles", async () => {
    await createUser(1, "danny");
    await upload(
      bundleBody([
        record(),
        record({
          machine: "laptop",
          date: "2026-07-20",
          book: { gutenberg_id: 2701, title: "Moby-Dick" },
          range: { start: 0, end: 4000 },
          chars_typed: 4000,
          errors_uncorrected: 0,
          corrections: 0,
        }),
      ]),
    );
    const row = (await board()).users[0];
    expect(row.machines["test-box"].chars).toBe(3000);
    expect(row.machines["laptop"].best_wpm).toBe(80);
    expect(row.machines_count).toBe(2);
    expect(row.last_date).toBe("2026-07-20");
    expect(row.books_detail[0].title).toBe("Moby-Dick");
    expect(row.books).toBe(2);
  });

  it("hides banned users", async () => {
    await createUser(1, "cheater");
    await upload(bundleBody([record()]));
    await env.DB.prepare("UPDATE users SET banned_at = 1 WHERE id = 1").run();
    expect((await board()).users).toEqual([]);
  });
});

describe("POST /api/v1/upload", () => {
  it("rejects missing/unknown auth", async () => {
    expect((await upload(bundleBody([record()]), {})).status).toBe(401);
    expect(
      (
        await upload(bundleBody([record()]), {
          Authorization: `Bearer gt_${"f".repeat(64)}`,
        })
      ).status,
    ).toBe(401);
  });

  it("accepts a token upload and reports rank and new_sessions", async () => {
    await createUser(1, "danny");
    const res = await upload(bundleBody([record(), record()]));
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.rank).toBe(1);
    expect(data.total_users).toBe(1);
    expect(data.best_wpm).toBe(60);
    expect(data.new_sessions).toBe(2);
    expect(data.total_sessions).toBe(2);
    expect(data.suspicious).toBe(false);
  });

  it("stores the canonical record byte-for-byte", async () => {
    await createUser(1, "danny");
    const rec = record({ zeta: 1, alpha: { b: 2, a: 1 } });
    await upload(bundleBody([rec]));
    const row = await env.DB.prepare(
      "SELECT canonical_json FROM sessions WHERE user_id = 1",
    ).first<{ canonical_json: string }>();
    const parsed = JSON.parse(row!.canonical_json);
    expect(parsed.zeta).toBe(1);
    expect(parsed.alpha).toEqual({ a: 1, b: 2 });
    expect(row!.canonical_json.indexOf('"active_ms"')).toBeLessThan(
      row!.canonical_json.indexOf('"zeta"'),
    );
  });

  it("rejects structural violations with the reason", async () => {
    await createUser(1, "danny");
    expect((await upload('{"format_version": 1}')).status).toBe(400);
    const res = await upload(bundleBody([record()], { schema: 2 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "schema 2 not supported",
    );
    const bad = record() as Record<string, unknown>;
    delete bad.chars_typed;
    const res2 = await upload(bundleBody([bad]));
    expect(res2.status).toBe(400);
    expect(((await res2.json()) as { error: string }).error).toContain(
      "chars_typed",
    );
  });

  it("rejects a bundle whose user does not match the submitter", async () => {
    await createUser(1, "danny");
    const res = await upload(bundleBody([record()], { user: "mallory" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain(
      "mallory",
    );
    await backdateSubmissions(60);
    expect(
      (await upload(bundleBody([record()], { user: "danny" }))).status,
    ).toBe(200);
  });

  it("rejects oversized bundles", async () => {
    await createUser(1, "danny");
    const res = await upload(
      bundleBody([record({ pad: "x".repeat(1_000_000) })]),
    );
    expect(res.status).toBe(413);
  });

  it("throttles rapid re-uploads, then replays as a no-op", async () => {
    await createUser(1, "danny");
    const body = bundleBody([record(), record()]);
    await upload(body);
    expect((await upload(body)).status).toBe(429);

    await backdateSubmissions(60);
    const replay = await upload(body);
    expect(replay.status).toBe(200);
    const data = (await replay.json()) as Record<string, unknown>;
    expect(data.new_sessions).toBe(0);
    expect(data.total_sessions).toBe(2);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions",
    ).first<{ n: number }>();
    expect(count!.n).toBe(2);
  });

  it("409s when a record with a known id changed content", async () => {
    await createUser(1, "danny");
    const rec = record();
    await upload(bundleBody([rec]));
    await backdateSubmissions(60);
    const res = await upload(bundleBody([{ ...rec, chars_typed: 9999 }]));
    expect(res.status).toBe(409);
    const data = (await res.json()) as { conflicting_ids: string[] };
    expect(data.conflicting_ids).toEqual([rec.id]);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions",
    ).first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("flags implausible records instead of rejecting", async () => {
    await createUser(1, "uriah");
    // 320 wpm: 1600 chars in one active minute
    const res = await upload(
      bundleBody([
        record({
          active_ms: 60_000,
          wall_ms: 65_000,
          chars_typed: 1600,
          errors_uncorrected: 0,
          corrections: 0,
          range: { start: 0, end: 1600 },
        }),
      ]),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { suspicious: boolean }).suspicious).toBe(
      true,
    );
    expect((await board()).users[0].suspicious).toBe(true);
  });

  it("counts legacy records in totals but not bests", async () => {
    await createUser(1, "danny");
    const legacy = {
      id: uuid(),
      machine: "old-box",
      date: "2026-07-19",
      legacy: true,
      legacy_counters: { sessions_count: 12, total_chars: 90_000 },
      active_ms: 7_200_000,
      wall_ms: 7_200_000,
      chars_typed: 90_000, // gross 150 — must not become best_wpm
      errors_uncorrected: 2000,
    };
    const res = await upload(bundleBody([record(), legacy]));
    expect(res.status).toBe(200);
    const row = (await board()).users[0];
    expect(row.best_wpm).toBe(60);
    expect(row.sessions).toBe(13);
    expect(row.hours).toBe(2.2);
    expect(row.books).toBe(1);
  });

  it("refuses banned accounts", async () => {
    await createUser(1, "banned");
    await env.DB.prepare("UPDATE users SET banned_at = 1 WHERE id = 1").run();
    expect((await upload(bundleBody([record()]))).status).toBe(403);
  });

  it("accepts session-cookie auth only with the CSRF header", async () => {
    await createUser(7, "webuser", false);
    const cookie = (await makeSessionCookie(env, 7)).split(";")[0];
    const noHeader = await upload(bundleBody([record()]), { Cookie: cookie });
    expect(noHeader.status).toBe(401);
    const withHeader = await upload(bundleBody([record()]), {
      Cookie: cookie,
      "X-Typist-Guild": "1",
    });
    expect(withHeader.status).toBe(200);
  });
});

describe("account + token", () => {
  it("redirects anonymous /account to sign-in", async () => {
    const res = await SELF.fetch(`${BASE}/account`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/auth/login");
  });

  it("renders /account for a signed-in user", async () => {
    await createUser(7, "webuser", false);
    const cookie = (await makeSessionCookie(env, 7)).split(";")[0];
    const res = await SELF.fetch(`${BASE}/account`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("webuser");
  });

  it("issues a working token (CSRF header required)", async () => {
    await createUser(7, "webuser", false);
    const cookie = (await makeSessionCookie(env, 7)).split(";")[0];
    const denied = await SELF.fetch(`${BASE}/api/v1/token`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(denied.status).toBe(403);
    const res = await SELF.fetch(`${BASE}/api/v1/token`, {
      method: "POST",
      headers: { Cookie: cookie, "X-Typist-Guild": "1" },
    });
    const { token } = (await res.json()) as { token: string };
    expect(token).toMatch(/^gt_[0-9a-f]{64}$/);
    const uploaded = await upload(bundleBody([record()]), {
      Authorization: `Bearer ${token}`,
    });
    expect(uploaded.status).toBe(200);
  });

  it("rejects sessions signed with a wrong secret", async () => {
    await createUser(7, "webuser", false);
    const forged = "gt_session=v1.7.9999999999.deadbeef";
    const res = await SELF.fetch(`${BASE}/account`, {
      headers: { Cookie: forged },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
  });
});

describe("OAuth entry", () => {
  it("redirects /auth/login to GitHub with state cookie", async () => {
    const res = await SELF.fetch(`${BASE}/auth/login`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toContain("github.com/login/oauth/authorize");
    expect(location).toContain("client_id=test-client-id");
    expect(res.headers.get("Set-Cookie")).toContain("gt_oauth_state=");
  });

  it("rejects a callback with mismatched state", async () => {
    const res = await SELF.fetch(`${BASE}/auth/callback?code=x&state=evil`, {
      headers: { Cookie: "gt_oauth_state=good" },
    });
    expect(res.status).toBe(400);
  });
});
