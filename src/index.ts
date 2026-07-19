import {
  MAX_BUNDLE_BYTES,
  Row,
  SessionRecord,
  canonicalJson,
  deriveRow,
  isImplausible,
  parseBundle,
} from "./bundle";
import {
  CLEAR_SESSION_COOKIE,
  Env,
  handleCallback,
  issueToken,
  loginRedirect,
  sessionUserId,
  sha256Hex,
  tokenUserId,
} from "./auth";

const UPLOAD_THROTTLE_SECONDS = 30;
// D1 caps bound parameters around 100 per statement; the id-existence
// lookup binds user_id + a chunk of session ids.
const ID_CHUNK = 50;

const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

// ── Board ──────────────────────────────────────────────────────────────────

type FlaggedRecord = SessionRecord & { flagged: boolean };

async function boardRows(env: Env): Promise<Row[]> {
  const users = await env.DB.prepare(
    "SELECT id, login FROM users WHERE banned_at IS NULL",
  ).all<{ id: number; login: string }>();
  const sessions = await env.DB.prepare(
    "SELECT user_id, flagged, canonical_json FROM sessions",
  ).all<{ user_id: number; flagged: number; canonical_json: string }>();

  const byUser = new Map<number, FlaggedRecord[]>();
  for (const s of sessions.results) {
    const record = JSON.parse(s.canonical_json) as SessionRecord;
    const list = byUser.get(s.user_id) ?? [];
    list.push(Object.assign(record, { flagged: s.flagged === 1 }));
    byUser.set(s.user_id, list);
  }

  const rows: Row[] = [];
  for (const u of users.results) {
    const records = byUser.get(u.id);
    if (!records?.length) continue; // account exists, no stats yet
    rows.push(deriveRow(u.login, u.id < 0, records));
  }
  rows.sort((a, b) => b.best_wpm - a.best_wpm || a.user.localeCompare(b.user));
  return rows;
}

async function boardResponse(env: Env): Promise<Response> {
  const rows = await boardRows(env);
  return json(
    { generated_at: Math.floor(Date.now() / 1000), users: rows, skipped: [] },
    200,
    {
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
    },
  );
}

// ── Upload ─────────────────────────────────────────────────────────────────

async function authenticatedUserId(
  env: Env,
  request: Request,
): Promise<number | null> {
  const viaToken = await tokenUserId(env, request);
  if (viaToken !== null) return viaToken;
  // Cookie auth additionally requires a custom header: cross-site forms
  // can't set one, so this is the CSRF gate for browser uploads.
  if (request.headers.get("X-Typist-Guild") !== "1") return null;
  return sessionUserId(env, request);
}

async function handleUpload(env: Env, request: Request): Promise<Response> {
  const userId = await authenticatedUserId(env, request);
  if (userId === null) {
    return json({ error: "unauthorized — get a token at /account" }, 401);
  }
  const user = await env.DB.prepare(
    "SELECT login, banned_at FROM users WHERE id = ?1",
  )
    .bind(userId)
    .first<{ login: string; banned_at: number | null }>();
  if (!user || user.banned_at !== null)
    return json({ error: "account disabled" }, 403);

  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > MAX_BUNDLE_BYTES)
    return json({ error: "bundle larger than 1 MB" }, 413);

  const now = Math.floor(Date.now() / 1000);
  const lastSub = await env.DB.prepare(
    "SELECT received_at FROM submissions WHERE user_id = ?1 ORDER BY received_at DESC LIMIT 1",
  )
    .bind(userId)
    .first<{ received_at: number }>();
  if (lastSub && now - lastSub.received_at < UPLOAD_THROTTLE_SECONDS) {
    return json({ error: "too fast — wait 30 seconds between uploads" }, 429);
  }

  const body = await request.text();
  const { bundle, error } = parseBundle(body);
  if (!bundle) return json({ error }, 400);
  // SPEC §2: a user field, when present, must match the authenticated
  // submitter — it exists to catch uploading someone else's export.
  if (bundle.user !== undefined && bundle.user !== user.login) {
    return json(
      {
        error: `bundle user ${JSON.stringify(bundle.user)} does not match authenticated user ${JSON.stringify(user.login)}`,
      },
      403,
    );
  }

  const canonical = new Map(
    bundle.sessions.map((r) => [r.id, canonicalJson(r)]),
  );
  const existing = new Map<string, string>();
  const ids = [...canonical.keys()];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const placeholders = chunk.map((_, j) => `?${j + 2}`).join(",");
    const res = await env.DB.prepare(
      `SELECT id, canonical_json FROM sessions WHERE user_id = ?1 AND id IN (${placeholders})`,
    )
      .bind(userId, ...chunk)
      .all<{ id: string; canonical_json: string }>();
    for (const r of res.results) existing.set(r.id, r.canonical_json);
  }

  const conflicts: string[] = [];
  const fresh: SessionRecord[] = [];
  for (const r of bundle.sessions) {
    const prior = existing.get(r.id);
    if (prior === undefined) fresh.push(r);
    else if (prior !== canonical.get(r.id)) conflicts.push(r.id);
    // byte-identical → set union makes the record a no-op
  }
  if (conflicts.length) {
    return json(
      {
        error:
          "records conflict with already-uploaded sessions — a session is immutable once created",
        conflicting_ids: conflicts,
      },
      409,
    );
  }

  let anyFlagged = 0;
  const statements = fresh.map((r) => {
    const flagged = isImplausible(r) ? 1 : 0;
    anyFlagged = anyFlagged || flagged;
    return env.DB.prepare(
      `INSERT INTO sessions (user_id, id, machine, date, book_id, title,
         active_ms, wall_ms, chars_typed, errors_uncorrected, corrections,
         legacy, flagged, canonical_json, received_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    ).bind(
      userId,
      r.id,
      r.machine,
      r.date,
      r.book?.gutenberg_id ?? null,
      r.book?.title ?? null,
      r.active_ms,
      r.wall_ms,
      r.chars_typed,
      r.errors_uncorrected,
      r.corrections ?? null,
      r.legacy === true ? 1 : 0,
      flagged,
      canonical.get(r.id)!,
      now,
    );
  });
  statements.push(
    env.DB.prepare(
      `INSERT INTO submissions (user_id, received_at, bundle_sha256, new_sessions, flagged)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(userId, now, await sha256Hex(body), fresh.length, anyFlagged),
  );
  await env.DB.batch(statements); // D1 batch is transactional

  const rows = await boardRows(env);
  const rank = rows.findIndex((r) => r.user === user.login) + 1;
  const row = rows[rank - 1];
  return json({
    ok: true,
    user: user.login,
    rank,
    total_users: rows.length,
    best_wpm: row?.best_wpm ?? 0,
    new_sessions: fresh.length,
    total_sessions: row?.sessions ?? 0,
    suspicious: row?.suspicious ?? anyFlagged === 1,
  });
}

// ── Account page ───────────────────────────────────────────────────────────

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function accountPage(
  login: string,
  rank: number,
  total: number,
  hasToken: boolean,
): string {
  const user = escapeHtml(login);
  const rankLine =
    rank > 0
      ? `rank <span class="accent">#${rank}</span> of ${total} on the board`
      : `not on the board yet — upload your first export below`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>typist guild · account</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="topbar">
  <h1><span class="accent">typist guild</span><span class="cursor">&#9646;</span></h1>
  <p class="tagline">signed in as <a href="https://github.com/${user}">${user}</a> &middot; ${rankLine}</p>
  <nav>
    <a href="/">board</a>
    <span class="sep">&middot;</span>
    <a href="https://github.com/5x5x5x5/gutenberg-typist">plugin</a>
    <span class="sep">&middot;</span>
    <a href="/auth/logout">sign out</a>
  </nav>
</header>

<main>
  <section class="buffer intro">
    <div class="buffer-title"><span>~/.gt-hub/upload</span></div>
    <div class="account-section">
      <p>Drop your <code>:GT export</code> file here (default
        <code>~/gutenberg-typist-export.json</code>):</p>
      <div id="dropzone" tabindex="0">drag the export here, or click to pick a file</div>
      <input id="file" type="file" accept="application/json,.json" hidden>
      <p id="upload-result" class="muted"></p>
    </div>
  </section>

  <section class="buffer intro">
    <div class="buffer-title"><span>~/.gt-hub/token</span></div>
    <div class="account-section">
      <p>A token lets you publish without a browser — shown <em>once</em>, so
        copy it. Regenerating revokes the old one.</p>
      <p><button id="gen-token">${hasToken ? "regenerate token" : "generate token"}</button></p>
      <div id="token-out" hidden>
        <p>your token: <code id="token-value"></code></p>
        <p class="muted">command line:</p>
        <pre class="install" id="curl-line"></pre>
        <p class="muted">or in vim (~/.vimrc):</p>
        <pre class="install" id="vim-line"></pre>
      </div>
    </div>
  </section>
</main>

<footer class="modeline">
  <span id="mode">-- ACCOUNT --</span>
</footer>

<script>
"use strict";
const post = (path, body) =>
  fetch(path, { method: "POST", headers: { "X-Typist-Guild": "1" }, body });

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file");
const result = document.getElementById("upload-result");

async function upload(file) {
  result.textContent = "uploading " + file.name + "…";
  const res = await post("/api/v1/upload", await file.text());
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    result.textContent = "rejected: " + (data.error || res.status);
    return;
  }
  result.textContent =
    "merged " + data.new_sessions + " new session(s) — you are #" + data.rank +
    " of " + data.total_users + " (best " + data.best_wpm + " wpm)" +
    (data.suspicious ? " — flagged as implausible, honor system!" : "");
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => e.preventDefault());
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) upload(fileInput.files[0]);
});

document.getElementById("gen-token").addEventListener("click", async () => {
  const res = await post("/api/v1/token");
  const data = await res.json();
  document.getElementById("token-value").textContent = data.token;
  document.getElementById("curl-line").textContent =
    "curl -X POST " + location.origin + "/api/v1/upload \\\\\\n" +
    "  -H 'Authorization: Bearer " + data.token + "' \\\\\\n" +
    "  --data-binary @$HOME/gutenberg-typist-export.json";
  document.getElementById("vim-line").textContent =
    "let g:gt_hub_url = '" + location.origin + "'\\n" +
    "let g:gt_hub_token = '" + data.token + "'\\n" +
    '" then just :GT publish';
  document.getElementById("token-out").hidden = false;
});
</script>
</body>
</html>`;
}

async function handleAccount(env: Env, request: Request): Promise<Response> {
  const userId = await sessionUserId(env, request);
  if (userId === null) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/auth/login" },
    });
  }
  const user = await env.DB.prepare(
    "SELECT login, token_hash FROM users WHERE id = ?1",
  )
    .bind(userId)
    .first<{ login: string; token_hash: string | null }>();
  if (!user) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/auth/login", "Set-Cookie": CLEAR_SESSION_COOKIE },
    });
  }
  const rows = await boardRows(env);
  const rank = rows.findIndex((r) => r.user === user.login) + 1;
  return new Response(
    accountPage(user.login, rank, rows.length, user.token_hash !== null),
    {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

async function handleToken(env: Env, request: Request): Promise<Response> {
  if (request.headers.get("X-Typist-Guild") !== "1")
    return json({ error: "missing header" }, 403);
  const userId = await sessionUserId(env, request);
  if (userId === null) return json({ error: "sign in first" }, 401);
  return json({ token: await issueToken(env, userId) });
}

// ── Router ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/v1/board":
        return boardResponse(env);
      case "POST /api/v1/upload":
        return handleUpload(env, request);
      case "POST /api/v1/token":
        return handleToken(env, request);
      case "GET /auth/login":
        return loginRedirect(env, request.url);
      case "GET /auth/callback":
        return handleCallback(env, request);
      case "GET /auth/logout":
        return new Response(null, {
          status: 302,
          headers: { Location: "/", "Set-Cookie": CLEAR_SESSION_COOKIE },
        });
      case "GET /account":
        return handleAccount(env, request);
      default:
        return env.ASSETS.fetch(request);
    }
  },
} satisfies ExportedHandler<Env>;
