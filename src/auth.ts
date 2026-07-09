// GitHub OAuth + session cookies + API tokens. WebCrypto only, no deps.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

const SESSION_TTL_SECONDS = 30 * 24 * 3600;

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish comparison; both sides are fixed-length hex we produced.
function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Session cookie: "v1.<userId>.<expiry>.<hmac>" ─────────────────────────

export async function makeSessionCookie(
  env: Env,
  userId: number,
): Promise<string> {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `v1.${userId}.${expiry}`;
  const mac = await hmacHex(env.SESSION_SECRET, payload);
  return (
    `gt_session=${payload}.${mac}; Max-Age=${SESSION_TTL_SECONDS}; ` +
    `Path=/; HttpOnly; Secure; SameSite=Lax`
  );
}

export const CLEAR_SESSION_COOKIE =
  "gt_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax";

export async function sessionUserId(
  env: Env,
  request: Request,
): Promise<number | null> {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)gt_session=([^;]+)/);
  if (!match) return null;
  const parts = match[1].split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, id, expiry, mac] = parts;
  const expected = await hmacHex(env.SESSION_SECRET, `v1.${id}.${expiry}`);
  if (!digestsEqual(mac, expected)) return null;
  if (Number(expiry) < Math.floor(Date.now() / 1000)) return null;
  return Number(id);
}

// ── OAuth dance ────────────────────────────────────────────────────────────

export function loginRedirect(env: Env, requestUrl: string): Response {
  const state = randomHex(16);
  const callback = new URL("/auth/callback", requestUrl).toString();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", callback);
  url.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": `gt_oauth_state=${state}; Max-Age=600; Path=/auth; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

export async function handleCallback(
  env: Env,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = (request.headers.get("Cookie") ?? "").match(
    /(?:^|;\s*)gt_oauth_state=([^;]+)/,
  )?.[1];
  if (!code || !state || !cookieState || state !== cookieState) {
    return new Response("OAuth state mismatch — try signing in again.", {
      status: 400,
    });
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const tokenData = (await tokenRes.json()) as { access_token?: string };
  if (!tokenData.access_token) {
    return new Response("GitHub token exchange failed.", { status: 502 });
  }

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "typist-guild",
    },
  });
  const ghUser = (await userRes.json()) as { id?: number; login?: string };
  if (typeof ghUser.id !== "number" || typeof ghUser.login !== "string") {
    return new Response("GitHub user lookup failed.", { status: 502 });
  }

  // Keyed on the immutable numeric id; login is a display snapshot that
  // refreshes on every sign-in (handles renames without disputes).
  await env.DB.prepare(
    `INSERT INTO users (id, login, created_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET login = ?2`,
  )
    .bind(ghUser.id, ghUser.login, Math.floor(Date.now() / 1000))
    .run();

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/account",
      "Set-Cookie": await makeSessionCookie(env, ghUser.id),
    },
  });
}

// ── API tokens ─────────────────────────────────────────────────────────────

// Returns the plaintext token exactly once; only the hash is stored.
export async function issueToken(env: Env, userId: number): Promise<string> {
  const token = `gt_${randomHex(32)}`;
  await env.DB.prepare("UPDATE users SET token_hash = ?1 WHERE id = ?2")
    .bind(await sha256Hex(token), userId)
    .run();
  return token;
}

export async function tokenUserId(
  env: Env,
  request: Request,
): Promise<number | null> {
  const auth = request.headers.get("Authorization") ?? "";
  const match = auth.match(/^Bearer\s+(gt_[0-9a-f]{64})$/);
  if (!match) return null;
  const row = await env.DB.prepare("SELECT id FROM users WHERE token_hash = ?1")
    .bind(await sha256Hex(match[1]))
    .first<{ id: number }>();
  return row?.id ?? null;
}
