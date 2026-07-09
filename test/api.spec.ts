// Integration tests against the real Worker (SELF) with a real (local) D1.
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { makeSessionCookie, sha256Hex } from "../src/auth";

const TOKEN = `gt_${"a".repeat(64)}`;
const BASE = "http://guild.test";

const bundleBody = (chars = 6000, bestWpm = 72, machine = "test-box") =>
  JSON.stringify({
    format_version: 1,
    exported_at: 1718200000,
    machines: {
      [machine]: {
        total_chars: chars,
        correct_chars: Math.floor(chars * 0.95),
        total_time_seconds: 600,
        sessions_count: 4,
        best_wpm: bestWpm,
      },
    },
    sessions: {
      "4300": { book_id: 4300, offset: 1234, last_active: 1718100000 },
    },
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

// Backdate the last submission so the 30 s throttle doesn't bite mid-test.
const backdateSubmissions = (seconds: number) =>
  env.DB.prepare("UPDATE submissions SET received_at = received_at - ?1")
    .bind(seconds)
    .run();

beforeEach(async () => {
  for (const table of ["submissions", "book_sessions", "machines", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("GET /api/v1/board", () => {
  it("returns an empty board", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/board`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const data = (await res.json()) as { users: unknown[]; skipped: unknown[] };
    expect(data.users).toEqual([]);
    expect(data.skipped).toEqual([]);
  });

  it("derives rows and sorts by best_wpm then name", async () => {
    await createUser(1, "slow");
    await createUser(2, "fast", false);
    await upload(bundleBody(6000, 60));
    await env.DB.prepare(
      `INSERT INTO machines (user_id, machine_id, counters_json, updated_at)
       VALUES (2, 'box', '{"total_chars": 1000, "best_wpm": 90, "total_time_seconds": 100}', 5)`,
    ).run();
    const data = (await (await SELF.fetch(`${BASE}/api/v1/board`)).json()) as {
      users: { user: string; best_wpm: number }[];
    };
    expect(data.users.map((u) => u.user)).toEqual(["fast", "slow"]);
  });

  it("hides banned users", async () => {
    await createUser(1, "cheater");
    await upload(bundleBody());
    await env.DB.prepare("UPDATE users SET banned_at = 1 WHERE id = 1").run();
    const data = (await (await SELF.fetch(`${BASE}/api/v1/board`)).json()) as {
      users: unknown[];
    };
    expect(data.users).toEqual([]);
  });
});

describe("POST /api/v1/upload", () => {
  it("rejects missing/unknown auth", async () => {
    expect((await upload(bundleBody(), {})).status).toBe(401);
    expect(
      (
        await upload(bundleBody(), {
          Authorization: `Bearer gt_${"f".repeat(64)}`,
        })
      ).status,
    ).toBe(401);
  });

  it("accepts a token upload and reports rank", async () => {
    await createUser(1, "danny");
    const res = await upload(bundleBody());
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.rank).toBe(1);
    expect(data.total_users).toBe(1);
    expect(data.best_wpm).toBe(72);
    expect(data.suspicious).toBe(false);
  });

  it("rejects invalid bundles with the validation error", async () => {
    await createUser(1, "danny");
    const res = await upload('{"format_version": 9}');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /format_version/,
    );
  });

  it("throttles rapid re-uploads, then merges idempotently", async () => {
    await createUser(1, "danny");
    await upload(bundleBody());
    expect((await upload(bundleBody())).status).toBe(429);

    await backdateSubmissions(60);
    const replay = await upload(bundleBody());
    expect(replay.status).toBe(200);
    const data = (await (await SELF.fetch(`${BASE}/api/v1/board`)).json()) as {
      users: { total_chars: number; machines_count: number }[];
    };
    expect(data.users[0].total_chars).toBe(6000); // union-max: replay adds nothing
    expect(data.users[0].machines_count).toBe(1);
  });

  it("merges a second machine across uploads", async () => {
    await createUser(1, "danny");
    await upload(bundleBody(6000, 72, "desktop"));
    await backdateSubmissions(60);
    await upload(bundleBody(4000, 80, "laptop"));
    const data = (await (await SELF.fetch(`${BASE}/api/v1/board`)).json()) as {
      users: {
        total_chars: number;
        machines_count: number;
        best_wpm: number;
      }[];
    };
    expect(data.users[0].total_chars).toBe(10000);
    expect(data.users[0].machines_count).toBe(2);
    expect(data.users[0].best_wpm).toBe(80);
  });

  it("marks implausible best_wpm as suspicious", async () => {
    await createUser(1, "queequeg");
    const res = await upload(bundleBody(6000, 300));
    expect(((await res.json()) as { suspicious: boolean }).suspicious).toBe(
      true,
    );
  });

  it("flags implausible char deltas between uploads", async () => {
    await createUser(1, "danny");
    await upload(bundleBody(1000));
    await backdateSubmissions(60);
    // +5M chars in one minute = 1M WPM — humanly impossible
    const res = await upload(bundleBody(5_000_000));
    expect(((await res.json()) as { suspicious: boolean }).suspicious).toBe(
      true,
    );
    const board = (await (await SELF.fetch(`${BASE}/api/v1/board`)).json()) as {
      users: { suspicious: boolean }[];
    };
    expect(board.users[0].suspicious).toBe(true);
  });

  it("refuses banned accounts", async () => {
    await createUser(1, "banned");
    await env.DB.prepare("UPDATE users SET banned_at = 1 WHERE id = 1").run();
    expect((await upload(bundleBody())).status).toBe(403);
  });

  it("accepts session-cookie auth only with the CSRF header", async () => {
    await createUser(7, "webuser", false);
    const cookie = (await makeSessionCookie(env, 7)).split(";")[0];
    const noHeader = await upload(bundleBody(), { Cookie: cookie });
    expect(noHeader.status).toBe(401);
    const withHeader = await upload(bundleBody(), {
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
    const uploaded = await upload(bundleBody(), {
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
