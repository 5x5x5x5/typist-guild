import {
  CleanBundle,
  Machines,
  Row,
  Sessions,
  SUSPICIOUS_WPM,
  MAX_BUNDLE_BYTES,
  derive,
  loadBundle,
  mergeMachines,
  mergeSessions,
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
// Rate slack on delta anti-cheat: sustained typing above 1.5x the suspicious
// WPM ceiling between two uploads flags the submission.
const DELTA_WPM_CEILING = SUSPICIOUS_WPM * 1.5;

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

interface UserState {
  id: number;
  login: string;
  bundle: CleanBundle;
  flagged: boolean;
}

async function loadUserState(
  env: Env,
  userId: number,
): Promise<UserState | null> {
  const user = await env.DB.prepare(
    "SELECT id, login, banned_at FROM users WHERE id = ?1",
  )
    .bind(userId)
    .first<{ id: number; login: string; banned_at: number | null }>();
  if (!user) return null;
  const machines = await env.DB.prepare(
    "SELECT machine_id, counters_json, updated_at FROM machines WHERE user_id = ?1",
  )
    .bind(userId)
    .all<{ machine_id: string; counters_json: string; updated_at: number }>();
  const sessions = await env.DB.prepare(
    "SELECT * FROM book_sessions WHERE user_id = ?1",
  )
    .bind(userId)
    .all<{
      book_id: number;
      offset: number;
      total_chars_typed: number | null;
      correct_chars: number | null;
      last_active: number | null;
    }>();
  const machineMap: Machines = {};
  let exportedAt = 0;
  for (const m of machines.results) {
    machineMap[m.machine_id] = JSON.parse(m.counters_json);
    exportedAt = Math.max(exportedAt, m.updated_at);
  }
  const sessionMap: Sessions = {};
  for (const s of sessions.results) {
    sessionMap[String(s.book_id)] = {
      book_id: s.book_id,
      offset: s.offset,
      ...(s.total_chars_typed !== null && {
        total_chars_typed: s.total_chars_typed,
      }),
      ...(s.correct_chars !== null && { correct_chars: s.correct_chars }),
      ...(s.last_active !== null && { last_active: s.last_active }),
    };
  }
  return {
    id: user.id,
    login: user.login,
    bundle: {
      machines: machineMap,
      sessions: sessionMap,
      exported_at: exportedAt,
    },
    flagged: false,
  };
}

async function boardRows(env: Env): Promise<Row[]> {
  const users = await env.DB.prepare(
    "SELECT id, login FROM users WHERE banned_at IS NULL",
  ).all<{ id: number; login: string }>();
  const machines = await env.DB.prepare(
    "SELECT user_id, machine_id, counters_json, updated_at FROM machines",
  ).all<{
    user_id: number;
    machine_id: string;
    counters_json: string;
    updated_at: number;
  }>();
  const sessions = await env.DB.prepare("SELECT * FROM book_sessions").all<{
    user_id: number;
    book_id: number;
    offset: number;
    total_chars_typed: number | null;
    correct_chars: number | null;
    last_active: number | null;
  }>();
  const flagged = await env.DB.prepare(
    "SELECT DISTINCT user_id FROM submissions WHERE flagged = 1",
  ).all<{ user_id: number }>();
  const flaggedIds = new Set(flagged.results.map((r) => r.user_id));

  const byUser = new Map<number, UserState>();
  for (const u of users.results) {
    byUser.set(u.id, {
      id: u.id,
      login: u.login,
      bundle: { machines: {}, sessions: {}, exported_at: 0 },
      flagged: flaggedIds.has(u.id),
    });
  }
  for (const m of machines.results) {
    const state = byUser.get(m.user_id);
    if (!state) continue;
    state.bundle.machines[m.machine_id] = JSON.parse(m.counters_json);
    state.bundle.exported_at = Math.max(state.bundle.exported_at, m.updated_at);
  }
  for (const s of sessions.results) {
    const state = byUser.get(s.user_id);
    if (!state) continue;
    state.bundle.sessions[String(s.book_id)] = {
      book_id: s.book_id,
      offset: s.offset,
      ...(s.total_chars_typed !== null && {
        total_chars_typed: s.total_chars_typed,
      }),
      ...(s.correct_chars !== null && { correct_chars: s.correct_chars }),
      ...(s.last_active !== null && { last_active: s.last_active }),
    };
  }

  const rows: Row[] = [];
  for (const state of byUser.values()) {
    if (!Object.keys(state.bundle.machines).length) continue; // account, no stats yet
    const row = derive(state.login, state.bundle);
    row.suspicious = row.suspicious || state.flagged;
    rows.push(row);
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
    "SELECT received_at, total_chars FROM submissions WHERE user_id = ?1 ORDER BY received_at DESC LIMIT 1",
  )
    .bind(userId)
    .first<{ received_at: number; total_chars: number }>();
  if (lastSub && now - lastSub.received_at < UPLOAD_THROTTLE_SECONDS) {
    return json({ error: "too fast — wait 30 seconds between uploads" }, 429);
  }

  const body = await request.text();
  const { bundle, error } = loadBundle(body);
  if (!bundle) return json({ error }, 400);

  const state = await loadUserState(env, userId);
  const local = state?.bundle ?? { machines: {}, sessions: {}, exported_at: 0 };
  const mergedMachines = mergeMachines(local.machines, bundle.machines);
  const mergedSessions = mergeSessions(local.sessions, bundle.sessions);

  // Delta anti-cheat: chars gained since the previous upload, against the
  // wall-clock time between uploads. First upload is exempt (it may carry
  // months of legitimate history).
  const sumChars = (m: Machines) =>
    Object.values(m).reduce((acc, r) => acc + (r.total_chars ?? 0), 0);
  const deltaChars = sumChars(mergedMachines) - sumChars(local.machines);
  let flagged = 0;
  if (lastSub && deltaChars > 0) {
    const elapsedMinutes = (now - lastSub.received_at) / 60;
    if (deltaChars / 5 / elapsedMinutes > DELTA_WPM_CEILING) flagged = 1;
  }

  // ponytail: read-merge-write without a transaction across requests; the
  // 30 s throttle prevents same-user races and union-max means a replayed
  // upload repairs any lost write.
  const statements = [
    ...Object.entries(mergedMachines).map(([machineId, counters]) =>
      env.DB.prepare(
        `INSERT INTO machines (user_id, machine_id, counters_json, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, machine_id) DO UPDATE SET counters_json = ?3, updated_at = ?4`,
      ).bind(userId, machineId, JSON.stringify(counters), now),
    ),
    ...Object.values(mergedSessions).map((s) =>
      env.DB.prepare(
        `INSERT INTO book_sessions (user_id, book_id, offset, total_chars_typed, correct_chars, last_active)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(user_id, book_id) DO UPDATE SET offset = ?3,
           total_chars_typed = ?4, correct_chars = ?5, last_active = ?6`,
      ).bind(
        userId,
        s.book_id,
        s.offset,
        s.total_chars_typed ?? null,
        s.correct_chars ?? null,
        s.last_active ?? null,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO submissions (user_id, received_at, bundle_sha256, total_chars, flagged)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(
      userId,
      now,
      await sha256Hex(body),
      sumChars(mergedMachines),
      flagged,
    ),
  ];
  await env.DB.batch(statements);

  const rows = await boardRows(env);
  const rank = rows.findIndex((r) => r.user === user.login) + 1;
  const row = rows[rank - 1];
  return json({
    ok: true,
    user: user.login,
    rank,
    total_users: rows.length,
    best_wpm: row?.best_wpm ?? 0,
    suspicious: row?.suspicious ?? flagged === 1,
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
    "merged — you are #" + data.rank + " of " + data.total_users +
    " (best " + data.best_wpm + " wpm)" +
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
