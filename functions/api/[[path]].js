const SESSION_COOKIE = "rhythm_session";
const OAUTH_STATE_COOKIE = "rhythm_oauth_state";
const SESSION_DAYS = 30;
const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_PASSWORD = "admin-rhythm-2026";
let schemaReady = false;

export async function onRequest(context) {
  try {
    const { request, env, params = {} } = context || {};
    if (!request) throw httpError(500, "Request context is unavailable");

    const pathParam = params.path || [];
    const path = `/${Array.isArray(pathParam) ? pathParam.join("/") : pathParam}`;
    await ensureAppSchema(env);

    if (path === "/auth/github/start" && request.method === "GET") {
      return await startGithubLogin(request, env);
    }

    if (path === "/auth/github/callback" && request.method === "GET") {
      return await finishGithubLogin(request, env);
    }

    if (path === "/me" && request.method === "GET") {
      const user = await requireOptionalUser(request, env);
      return json({ user });
    }

    if (path === "/auth/register" && request.method === "POST") {
      return await registerAccount(request, env);
    }

    if (path === "/auth/login" && request.method === "POST") {
      return await loginAccount(request, env);
    }

    if (path === "/auth/logout" && request.method === "POST") {
      return await logoutAccount(request, env);
    }

    if (path === "/charts" && request.method === "GET") {
      return await listCharts(request, env);
    }

    if (path === "/charts" && request.method === "POST") {
      const user = await requireUser(request, env);
      return await createChart(request, env, user);
    }

    const chartMatch = path.match(/^\/charts\/([^/]+)$/);
    if (chartMatch && request.method === "GET") {
      return await getChart(env, chartMatch[1], request);
    }

    if (chartMatch && request.method === "PUT") {
      const user = await requireUser(request, env);
      return await updateChart(request, env, user, chartMatch[1]);
    }

    if (chartMatch && request.method === "DELETE") {
      const user = await requireUser(request, env);
      return await deleteChart(env, user, chartMatch[1]);
    }

    const playMatch = path.match(/^\/charts\/([^/]+)\/play$/);
    if (playMatch && request.method === "POST") {
      return await incrementStat(env, playMatch[1], "play_count");
    }

    const likeMatch = path.match(/^\/charts\/([^/]+)\/like$/);
    if (likeMatch && request.method === "POST") {
      const user = await requireUser(request, env);
      return await toggleLike(env, user, likeMatch[1]);
    }

    const scoreMatch = path.match(/^\/charts\/([^/]+)\/score$/);
    if (scoreMatch && request.method === "POST") {
      const user = await requireUser(request, env);
      return await submitScore(request, env, user, scoreMatch[1]);
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}

async function listCharts(request, env) {
  const db = requireDb(env);
  const user = await requireOptionalUser(request, env);
  const url = new URL(request.url);
  const sort = url.searchParams.get("sort") === "popular" ? "popular" : "newest";
  const mineOnly = url.searchParams.get("mine") === "1";
  const order = sort === "popular"
    ? "s.like_count DESC, high_score DESC, s.play_count DESC, c.created_at DESC"
    : "c.created_at DESC";

  const result = await db.prepare(`
    SELECT c.id, c.creator_id, c.title, c.description, c.youtube_video_id, c.created_at,
           s.play_count, s.like_count, s.copied_count,
           u.username AS creator_name,
           COALESCE(MAX(sc.score), 0) AS high_score,
           EXISTS(SELECT 1 FROM chart_likes l WHERE l.chart_id = c.id AND l.user_id = ?) AS liked_by_me
    FROM charts c
    JOIN chart_stats s ON s.chart_id = c.id
    LEFT JOIN users u ON u.id = c.creator_id
    LEFT JOIN chart_scores sc ON sc.chart_id = c.id
    WHERE c.visibility = 'public'
      AND c.media_kind = 'youtube'
      AND c.youtube_video_id IS NOT NULL
      AND (? = '' OR c.creator_id = ?)
    GROUP BY c.id
    ORDER BY ${order}
    LIMIT 100
  `).bind(user?.id || "", mineOnly ? user?.id || "__none__" : "", user?.id || "").all();

  return json({
    charts: (result.results || []).map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      media: { kind: "youtube", youtubeVideoId: row.youtube_video_id },
      creatorId: row.creator_id,
      creatorName: row.creator_name || "Guest",
      playCount: row.play_count,
      likeCount: row.like_count,
      copiedCount: row.copied_count,
      highScore: row.high_score || 0,
      likedByMe: Boolean(row.liked_by_me),
      canDelete: Boolean(user && (user.isAdmin || user.id === row.creator_id)),
      createdAt: row.created_at
    }))
  });
}

async function getChart(env, chartId, request = null) {
  const db = requireDb(env);
  const user = request ? await requireOptionalUser(request, env) : null;
  const chart = await db.prepare(`
    SELECT c.*, s.play_count, s.like_count, s.copied_count, v.chart_payload,
           u.username AS creator_name,
           COALESCE((SELECT MAX(score) FROM chart_scores WHERE chart_id = c.id), 0) AS high_score,
           EXISTS(SELECT 1 FROM chart_likes l WHERE l.chart_id = c.id AND l.user_id = ?) AS liked_by_me
    FROM charts c
    JOIN chart_stats s ON s.chart_id = c.id
    JOIN chart_versions v ON v.chart_id = c.id AND v.version = c.latest_version
    LEFT JOIN users u ON u.id = c.creator_id
    WHERE c.id = ?
  `).bind(user?.id || "", chartId).first();

  if (!chart) throw httpError(404, "Chart not found");

  const scores = await db.prepare(`
    SELECT username, score, max_combo, perfect, good, miss, created_at
    FROM chart_scores
    WHERE chart_id = ?
    ORDER BY score DESC, created_at ASC
    LIMIT 10
  `).bind(chartId).all();

  const formatted = formatChart(chart, true);
  formatted.likedByMe = Boolean(chart.liked_by_me);
  formatted.canDelete = Boolean(user && (user.isAdmin || user.id === chart.creator_id));
  formatted.scores = scores.results || [];
  return json(formatted);
}

async function createChart(request, env, user) {
  const db = requireDb(env);
  const body = await parseChartRequest(request);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`
      INSERT INTO charts (
        id, creator_id, title, description, media_kind, youtube_video_id,
        local_name, local_size, local_duration, visibility, latest_version,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).bind(
      id,
      user.id,
      body.title,
      body.description,
      body.media.kind,
      body.media.youtubeVideoId,
      body.media.localName,
      body.media.localSize,
      body.media.localDuration,
      body.visibility,
      now,
      now
    ),
    db.prepare(`
      INSERT INTO chart_versions (chart_id, version, chart_payload, created_at)
      VALUES (?, 1, ?, ?)
    `).bind(id, JSON.stringify(body.chartPayload), now),
    db.prepare(`
      INSERT INTO chart_stats (chart_id, updated_at)
      VALUES (?, ?)
    `).bind(id, now)
  ]);

  return withUserSession(json({
    id,
    shareUrl: `${new URL(request.url).origin}/play/${id}`
  }, 201), user);
}

async function updateChart(request, env, user, chartId) {
  const db = requireDb(env);
  const existing = await db.prepare("SELECT * FROM charts WHERE id = ?").bind(chartId).first();
  if (!existing) throw httpError(404, "Chart not found");
  if (existing.creator_id !== user.id) throw httpError(403, "Only the creator can edit this chart");

  const body = await parseChartRequest(request);
  const nextVersion = Number(existing.latest_version || 1) + 1;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`
      UPDATE charts
      SET title = ?, description = ?, media_kind = ?, youtube_video_id = ?,
          local_name = ?, local_size = ?, local_duration = ?, visibility = ?,
          latest_version = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      body.title,
      body.description,
      body.media.kind,
      body.media.youtubeVideoId,
      body.media.localName,
      body.media.localSize,
      body.media.localDuration,
      body.visibility,
      nextVersion,
      now,
      chartId
    ),
    db.prepare(`
      INSERT INTO chart_versions (chart_id, version, chart_payload, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(chartId, nextVersion, JSON.stringify(body.chartPayload), now)
  ]);

  return withUserSession(json({
    id: chartId,
    version: nextVersion,
    shareUrl: `${new URL(request.url).origin}/play/${chartId}`
  }), user);
}

async function incrementStat(env, chartId, column) {
  const db = requireDb(env);
  const allowed = new Set(["play_count", "like_count", "copied_count"]);
  if (!allowed.has(column)) throw httpError(400, "Invalid stat");

  const result = await db.prepare(`
    UPDATE chart_stats
    SET ${column} = ${column} + 1, updated_at = ?
    WHERE chart_id = ?
  `).bind(new Date().toISOString(), chartId).run();

  if (!result.meta?.changes) throw httpError(404, "Chart not found");
  return json({ ok: true });
}

async function toggleLike(env, user, chartId) {
  const db = requireDb(env);
  const chart = await db.prepare("SELECT id FROM charts WHERE id = ?").bind(chartId).first();
  if (!chart) throw httpError(404, "Chart not found");

  const existing = await db.prepare("SELECT chart_id FROM chart_likes WHERE chart_id = ? AND user_id = ?").bind(chartId, user.id).first();
  let liked = true;
  if (existing) {
    await db.prepare("DELETE FROM chart_likes WHERE chart_id = ? AND user_id = ?").bind(chartId, user.id).run();
    liked = false;
  } else {
    await db.prepare("INSERT INTO chart_likes (chart_id, user_id, created_at) VALUES (?, ?, ?)").bind(chartId, user.id, new Date().toISOString()).run();
  }

  const count = await db.prepare("SELECT COUNT(*) AS count FROM chart_likes WHERE chart_id = ?").bind(chartId).first();
  await db.prepare("UPDATE chart_stats SET like_count = ?, updated_at = ? WHERE chart_id = ?").bind(Number(count?.count || 0), new Date().toISOString(), chartId).run();
  return json({ liked, likeCount: Number(count?.count || 0) });
}

async function submitScore(request, env, user, chartId) {
  const db = requireDb(env);
  const chart = await db.prepare("SELECT id FROM charts WHERE id = ?").bind(chartId).first();
  if (!chart) throw httpError(404, "Chart not found");

  const body = await request.json().catch(() => null);
  const score = Math.max(0, Math.floor(Number(body?.score) || 0));
  const maxCombo = Math.max(0, Math.floor(Number(body?.maxCombo) || 0));
  const perfect = Math.max(0, Math.floor(Number(body?.perfect) || 0));
  const good = Math.max(0, Math.floor(Number(body?.good) || 0));
  const miss = Math.max(0, Math.floor(Number(body?.miss) || 0));
  if (!score) throw httpError(400, "Score is required");

  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO chart_scores (id, chart_id, user_id, username, score, max_combo, perfect, good, miss, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), chartId, user.id, user.username || "Guest", score, maxCombo, perfect, good, miss, now).run();

  const high = await db.prepare("SELECT MAX(score) AS high_score FROM chart_scores WHERE chart_id = ?").bind(chartId).first();
  return json({ highScore: Number(high?.high_score || score) });
}

async function deleteChart(env, user, chartId) {
  const db = requireDb(env);
  const chart = await db.prepare("SELECT creator_id FROM charts WHERE id = ?").bind(chartId).first();
  if (!chart) throw httpError(404, "Chart not found");
  if (!user.isAdmin && chart.creator_id !== user.id) throw httpError(403, "Only owner or admin can delete this chart");

  await db.batch([
    db.prepare("DELETE FROM chart_likes WHERE chart_id = ?").bind(chartId),
    db.prepare("DELETE FROM chart_scores WHERE chart_id = ?").bind(chartId),
    db.prepare("DELETE FROM chart_reports WHERE chart_id = ?").bind(chartId),
    db.prepare("DELETE FROM chart_stats WHERE chart_id = ?").bind(chartId),
    db.prepare("DELETE FROM chart_versions WHERE chart_id = ?").bind(chartId),
    db.prepare("DELETE FROM charts WHERE id = ?").bind(chartId)
  ]);
  return json({ ok: true });
}

async function parseChartRequest(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") throw httpError(400, "Invalid JSON");

  const title = String(body.title || "").trim().slice(0, 120);
  const description = String(body.description || "").trim().slice(0, 1000);
  if (!title) throw httpError(400, "Title is required");

  const media = body.media || {};
  const kind = String(media.kind || body.chartPayload?.mediaSource || "").trim();
  const normalizedKind = kind === "youtube" ? "youtube" : kind === "local-audio" ? "local-audio" : kind === "local-video" ? "local-video" : "";
  if (!normalizedKind) throw httpError(400, "Unsupported media kind");

  let visibility = body.visibility === "public" ? "public" : "unlisted";
  const youtubeVideoId = String(media.youtubeVideoId || body.chartPayload?.videoId || "").trim();

  if (visibility === "public" && normalizedKind !== "youtube") {
    visibility = "unlisted";
  }

  if (visibility === "public" && !youtubeVideoId) {
    throw httpError(400, "Public charts require a YouTube video ID");
  }

  const chartPayload = body.chartPayload;
  if (!chartPayload || typeof chartPayload !== "object" || !Array.isArray(chartPayload.notes)) {
    throw httpError(400, "chartPayload.notes is required");
  }
  chartPayload.nodeTypeSettings = normalizeNodeTypeSettings(chartPayload.nodeTypeSettings || body.nodeTypeSettings);

  return {
    title,
    description,
    visibility,
    media: {
      kind: normalizedKind,
      youtubeVideoId: normalizedKind === "youtube" ? youtubeVideoId : null,
      localName: normalizedKind === "youtube" ? "" : String(media.localName || body.chartPayload.localMediaName || "").slice(0, 240),
      localSize: normalizedKind === "youtube" ? 0 : finiteNumber(media.localSize || body.chartPayload.localMediaSize, 0),
      localDuration: normalizedKind === "youtube" ? 0 : finiteNumber(media.localDuration || body.chartPayload.localMediaDuration, 0)
    },
    chartPayload
  };
}

function formatChart(row, includePayload = false) {
  const chart = {
    id: row.id,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    media: {
      kind: row.media_kind,
      youtubeVideoId: row.youtube_video_id,
      localName: row.local_name,
      localSize: row.local_size,
      localDuration: row.local_duration
    },
    creatorId: row.creator_id,
    creatorName: row.creator_name || "Guest",
    version: row.latest_version,
    playCount: row.play_count,
    likeCount: row.like_count,
    copiedCount: row.copied_count,
    highScore: row.high_score || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

  if (includePayload) {
    chart.chartPayload = JSON.parse(row.chart_payload);
    chart.nodeTypeSettings = normalizeNodeTypeSettings(chart.chartPayload.nodeTypeSettings);
  }

  return chart;
}

function normalizeNodeTypeSettings(settings) {
  const defaults = [
    { soundType: "global", offsetMs: 0, inputMode: "space", inputKey: "", label: "W" },
    { soundType: "global", offsetMs: 0, inputMode: "space", inputKey: "", label: "M" },
    { soundType: "global", offsetMs: 0, inputMode: "space", inputKey: "", label: "S" },
    { soundType: "global", offsetMs: 0, inputMode: "space", inputKey: "", label: "V" }
  ];
  const allowedInputs = new Set(["left", "right", "space", "both", "key"]);
  const allowedBuiltInSounds = new Set(["global", "punchy", "arcade", "taiko", "clap", "metal"]);
  return defaults.map((fallback, index) => {
    const profile = Array.isArray(settings) ? settings[index] : null;
    const soundType = typeof profile?.soundType === "string" ? profile.soundType : fallback.soundType;
    const isSeSound = soundType.startsWith("se:") && soundType.endsWith(".mp3");
    const offsetMs = Number(profile?.offsetMs);
    return {
      soundType: allowedBuiltInSounds.has(soundType) || isSeSound ? soundType : fallback.soundType,
      offsetMs: Number.isFinite(offsetMs) ? Math.max(-500, Math.min(500, offsetMs)) : fallback.offsetMs,
      inputMode: allowedInputs.has(profile?.inputMode) ? profile.inputMode : fallback.inputMode,
      inputKey: String(profile?.inputKey || fallback.inputKey).trim().slice(0, 24),
      label: String(profile?.label || fallback.label).trim().slice(0, 6) || fallback.label
    };
  });
}

async function registerAccount(request, env) {
  const db = requireDb(env);
  const body = await request.json().catch(() => null);
  const username = normalizeUsername(body?.username);
  const password = String(body?.password || "");
  if (!username) throw httpError(400, "Username must be 3-24 letters, numbers, _ or -");
  if (password.length < 6) throw httpError(400, "Password must be at least 6 characters");

  const existing = await db.prepare("SELECT id FROM users WHERE lower(username) = lower(?)").bind(username).first();
  if (existing) throw httpError(409, "Username already exists");

  const now = new Date().toISOString();
  const userId = `local:${crypto.randomUUID()}`;
  const passwordHash = await hashPassword(password);
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();

  await db.batch([
    db.prepare(`
      INSERT INTO users (id, github_id, username, password_hash, is_admin, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, '', ?, ?)
    `).bind(userId, userId, username, passwordHash, now, now),
    db.prepare(`
      INSERT INTO sessions (id, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(sessionId, userId, expiresAt, now)
  ]);

  const user = { id: userId, username, avatarUrl: "", isAdmin: false };
  return withUserSession(json({ user }), { sessionCookie: cookie(SESSION_COOKIE, sessionId, { maxAge: SESSION_DAYS * 86400 }) });
}

async function loginAccount(request, env) {
  const db = requireDb(env);
  const body = await request.json().catch(() => null);
  const username = normalizeUsername(body?.username);
  const password = String(body?.password || "");
  if (!username || !password) throw httpError(400, "Username and password are required");

  await ensureAdminAccount(env, username);
  const row = await db.prepare("SELECT id, username, avatar_url, password_hash, is_admin FROM users WHERE lower(username) = lower(?)").bind(username).first();
  if (!row?.password_hash || !(await verifyPassword(password, row.password_hash))) {
    throw httpError(401, "Invalid username or password");
  }

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  await db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(sessionId, row.id, expiresAt, now).run();

  const user = { id: row.id, username: row.username, avatarUrl: row.avatar_url || "", isAdmin: Boolean(row.is_admin) };
  return withUserSession(json({ user }), { sessionCookie: cookie(SESSION_COOKIE, sessionId, { maxAge: SESSION_DAYS * 86400 }) });
}

async function logoutAccount(request, env) {
  const db = requireDb(env);
  const sessionId = getCookie(request, SESSION_COOKIE);
  if (sessionId) {
    await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  }
  const response = json({ user: null });
  response.headers.append("Set-Cookie", cookie(SESSION_COOKIE, "", { maxAge: 0 }));
  return response;
}

async function startGithubLogin(request, env) {
  if (!hasGithubEnv(env)) {
    const user = await createGuestSession(env);
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        "Set-Cookie": user.sessionCookie
      }
    });
  }

  assertGithubEnv(env);
  const url = new URL(request.url);
  const state = crypto.randomUUID();
  const redirectUri = `${url.origin}/api/auth/github/callback`;
  const target = new URL("https://github.com/login/oauth/authorize");
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  target.searchParams.set("redirect_uri", redirectUri);
  target.searchParams.set("scope", "read:user");
  target.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      "Set-Cookie": cookie(OAUTH_STATE_COOKIE, state, { maxAge: 600 })
    }
  });
}

async function finishGithubLogin(request, env) {
  assertGithubEnv(env);
  const db = requireDb(env);
  const url = new URL(request.url);
  const expectedState = getCookie(request, OAUTH_STATE_COOKIE);
  if (!expectedState || expectedState !== url.searchParams.get("state")) {
    throw httpError(400, "OAuth state mismatch");
  }

  const code = url.searchParams.get("code");
  if (!code) throw httpError(400, "Missing OAuth code");

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/api/auth/github/callback`
    })
  });
  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) throw httpError(401, "GitHub token exchange failed");

  const githubUser = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": "rhythm-editor"
    }
  }).then(response => response.json());

  const userId = `github:${githubUser.id}`;
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO users (id, github_id, username, avatar_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(github_id) DO UPDATE SET
      username = excluded.username,
      avatar_url = excluded.avatar_url,
      updated_at = excluded.updated_at
  `).bind(userId, String(githubUser.id), githubUser.login, githubUser.avatar_url || "", now, now).run();

  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  await db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(sessionId, userId, expiresAt, now).run();

  const headers = new Headers({ Location: "/" });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, sessionId, { maxAge: SESSION_DAYS * 86400 }));
  headers.append("Set-Cookie", cookie(OAUTH_STATE_COOKIE, "", { maxAge: 0 }));
  return new Response(null, { status: 302, headers });
}

async function requireOptionalUser(request, env) {
  const sessionId = getCookie(request, SESSION_COOKIE);
  if (!sessionId) return null;

  const db = requireDb(env);
  const row = await db.prepare(`
    SELECT u.id, u.username, u.avatar_url, u.is_admin
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ?
  `).bind(sessionId, new Date().toISOString()).first();

  return row ? { id: row.id, username: row.username, avatarUrl: row.avatar_url, isAdmin: Boolean(row.is_admin) } : null;
}

async function requireUser(request, env) {
  const user = await requireOptionalUser(request, env);
  if (user) return user;
  if (!hasGithubEnv(env)) return createGuestSession(env);
  throw httpError(401, "Login required");
}

async function createGuestSession(env) {
  const db = requireDb(env);
  const now = new Date().toISOString();
  const userId = `guest:${crypto.randomUUID()}`;
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();

  await db.batch([
    db.prepare(`
      INSERT INTO users (id, github_id, username, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(userId, userId, "Guest", "", now, now),
    db.prepare(`
      INSERT INTO sessions (id, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(sessionId, userId, expiresAt, now)
  ]);

  return {
    id: userId,
    username: "Guest",
    avatarUrl: "",
    isAdmin: false,
    sessionCookie: cookie(SESSION_COOKIE, sessionId, { maxAge: SESSION_DAYS * 86400 })
  };
}

function withUserSession(response, user) {
  if (user?.sessionCookie) {
    response.headers.append("Set-Cookie", user.sessionCookie);
  }
  return response;
}

function hasGithubEnv(env) {
  return Boolean(env?.GITHUB_CLIENT_ID && env?.GITHUB_CLIENT_SECRET);
}

async function ensureAppSchema(env) {
  if (schemaReady || !env?.DB) return;
  const db = env.DB;
  const migrations = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      github_id TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL,
      avatar_url TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS charts (
      id TEXT PRIMARY KEY,
      creator_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      media_kind TEXT NOT NULL,
      youtube_video_id TEXT,
      local_name TEXT NOT NULL DEFAULT '',
      local_size INTEGER NOT NULL DEFAULT 0,
      local_duration REAL NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL,
      latest_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS chart_versions (
      chart_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      chart_payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chart_id, version),
      FOREIGN KEY (chart_id) REFERENCES charts(id)
    )`,
    `CREATE TABLE IF NOT EXISTS chart_stats (
      chart_id TEXT PRIMARY KEY,
      play_count INTEGER NOT NULL DEFAULT 0,
      like_count INTEGER NOT NULL DEFAULT 0,
      copied_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chart_id) REFERENCES charts(id)
    )`,
    `CREATE TABLE IF NOT EXISTS chart_reports (
      id TEXT PRIMARY KEY,
      chart_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      reporter_fingerprint TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chart_id) REFERENCES charts(id)
    )`,
    "ALTER TABLE users ADD COLUMN password_hash TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0",
    `CREATE TABLE IF NOT EXISTS chart_likes (
      chart_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chart_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS chart_scores (
      id TEXT PRIMARY KEY,
      chart_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      score INTEGER NOT NULL,
      max_combo INTEGER NOT NULL DEFAULT 0,
      perfect INTEGER NOT NULL DEFAULT 0,
      good INTEGER NOT NULL DEFAULT 0,
      miss INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    "CREATE INDEX IF NOT EXISTS idx_users_username ON users (username)",
    "CREATE INDEX IF NOT EXISTS idx_chart_scores_leaderboard ON chart_scores (chart_id, score DESC, created_at ASC)"
  ];

  for (const sql of migrations) {
    try {
      await db.prepare(sql).run();
    } catch (error) {
      if (!String(error?.message || "").toLowerCase().includes("duplicate column")) throw error;
    }
  }

  schemaReady = true;
}

async function ensureAdminAccount(env, requestedUsername = "") {
  const db = requireDb(env);
  const username = normalizeUsername(env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME) || DEFAULT_ADMIN_USERNAME;
  if (requestedUsername && requestedUsername.toLowerCase() !== username.toLowerCase()) return;
  const password = String(env.ADMIN_PASSWORD || env.RHYTHM_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD);
  const existing = await db.prepare("SELECT id, password_hash, is_admin FROM users WHERE lower(username) = lower(?)").bind(username).first();
  const now = new Date().toISOString();

  if (!existing) {
    const userId = `admin:${crypto.randomUUID()}`;
    await db.prepare(`
      INSERT INTO users (id, github_id, username, password_hash, is_admin, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, '', ?, ?)
    `).bind(userId, userId, username, await hashPassword(password), now, now).run();
    return;
  }

  if (!existing.is_admin || !existing.password_hash) {
    await db.prepare("UPDATE users SET password_hash = ?, is_admin = 1, updated_at = ? WHERE id = ?").bind(await hashPassword(password), now, existing.id).run();
  }
}

function assertGithubEnv(env) {
  if (!hasGithubEnv(env)) {
    throw httpError(500, "GitHub OAuth env vars are not configured");
  }
}

function requireDb(env) {
  if (!env || !env.DB) {
    throw httpError(500, "Cloudflare D1 binding DB is not configured");
  }
  return env.DB;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeUsername(value) {
  const username = String(value || "").trim().slice(0, 24);
  return /^[A-Za-z0-9_-]{3,24}$/.test(username) ? username : "";
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await passwordDigest(password, salt);
  return `v2:${base64Url(salt)}:${base64Url(key)}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split(":");
  if (parts[0] === "v2") {
    const salt = fromBase64Url(parts[1] || "");
    const expected = fromBase64Url(parts[2] || "");
    const actual = await passwordDigest(password, salt);
    return timingSafeEqual(actual, expected);
  }

  const [saltText, hashText] = parts;
  if (!saltText || !hashText) return false;
  const salt = fromBase64Url(saltText);
  const actual = new Uint8Array(await passwordKey(password, salt));
  const expected = fromBase64Url(hashText);
  return timingSafeEqual(actual, expected);
}

async function passwordDigest(password, salt) {
  const passwordBytes = new TextEncoder().encode(password);
  const data = new Uint8Array(salt.length + passwordBytes.length);
  data.set(salt, 0);
  data.set(passwordBytes, salt.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function timingSafeEqual(actual, expected) {
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < actual.length; index++) diff |= actual[index] ^ expected[index];
  return diff === 0;
}

async function passwordKey(password, salt) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 120000, hash: "SHA-256" }, material, 256);
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function cookie(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure"
  ];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function errorResponse(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = error?.message || "Server error";
  try {
    return json({ error: message }, status);
  } catch {
    return new Response('{"error":"Server error"}', {
      status: 500,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
