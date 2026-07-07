const SESSION_COOKIE = "rhythm_session";
const OAUTH_STATE_COOKIE = "rhythm_oauth_state";
const SESSION_DAYS = 30;

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const pathParam = params.path || [];
  const path = `/${Array.isArray(pathParam) ? pathParam.join("/") : pathParam}`;

  try {
    if (path === "/auth/github/start" && request.method === "GET") {
      return startGithubLogin(request, env);
    }

    if (path === "/auth/github/callback" && request.method === "GET") {
      return finishGithubLogin(request, env);
    }

    if (path === "/me" && request.method === "GET") {
      const user = await requireOptionalUser(request, env);
      return json({ user });
    }

    if (path === "/charts" && request.method === "GET") {
      return listCharts(request, env);
    }

    if (path === "/charts" && request.method === "POST") {
      const user = await requireUser(request, env);
      return createChart(request, env, user);
    }

    const chartMatch = path.match(/^\/charts\/([^/]+)$/);
    if (chartMatch && request.method === "GET") {
      return getChart(env, chartMatch[1]);
    }

    if (chartMatch && request.method === "PUT") {
      const user = await requireUser(request, env);
      return updateChart(request, env, user, chartMatch[1]);
    }

    const playMatch = path.match(/^\/charts\/([^/]+)\/play$/);
    if (playMatch && request.method === "POST") {
      return incrementStat(env, playMatch[1], "play_count");
    }

    const likeMatch = path.match(/^\/charts\/([^/]+)\/like$/);
    if (likeMatch && request.method === "POST") {
      return incrementStat(env, likeMatch[1], "like_count");
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    const status = error.status || 500;
    return json({ error: error.message || "Server error" }, status);
  }
}

async function listCharts(request, env) {
  const url = new URL(request.url);
  const sort = url.searchParams.get("sort") === "popular" ? "popular" : "newest";
  const order = sort === "popular"
    ? "s.like_count DESC, s.play_count DESC, c.created_at DESC"
    : "c.created_at DESC";

  const result = await env.DB.prepare(`
    SELECT c.id, c.title, c.description, c.youtube_video_id, c.created_at,
           s.play_count, s.like_count, s.copied_count
    FROM charts c
    JOIN chart_stats s ON s.chart_id = c.id
    WHERE c.visibility = 'public'
      AND c.media_kind = 'youtube'
      AND c.youtube_video_id IS NOT NULL
    ORDER BY ${order}
    LIMIT 100
  `).all();

  return json({
    charts: (result.results || []).map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      media: { kind: "youtube", youtubeVideoId: row.youtube_video_id },
      playCount: row.play_count,
      likeCount: row.like_count,
      copiedCount: row.copied_count,
      createdAt: row.created_at
    }))
  });
}

async function getChart(env, chartId) {
  const chart = await env.DB.prepare(`
    SELECT c.*, s.play_count, s.like_count, s.copied_count, v.chart_payload
    FROM charts c
    JOIN chart_stats s ON s.chart_id = c.id
    JOIN chart_versions v ON v.chart_id = c.id AND v.version = c.latest_version
    WHERE c.id = ?
  `).bind(chartId).first();

  if (!chart) throw httpError(404, "Chart not found");

  return json(formatChart(chart, true));
}

async function createChart(request, env, user) {
  const body = await parseChartRequest(request);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(`
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
    env.DB.prepare(`
      INSERT INTO chart_versions (chart_id, version, chart_payload, created_at)
      VALUES (?, 1, ?, ?)
    `).bind(id, JSON.stringify(body.chartPayload), now),
    env.DB.prepare(`
      INSERT INTO chart_stats (chart_id, updated_at)
      VALUES (?, ?)
    `).bind(id, now)
  ]);

  return json({
    id,
    shareUrl: `${new URL(request.url).origin}/play/${id}`
  }, 201);
}

async function updateChart(request, env, user, chartId) {
  const existing = await env.DB.prepare("SELECT * FROM charts WHERE id = ?").bind(chartId).first();
  if (!existing) throw httpError(404, "Chart not found");
  if (existing.creator_id !== user.id) throw httpError(403, "Only the creator can edit this chart");

  const body = await parseChartRequest(request);
  const nextVersion = Number(existing.latest_version || 1) + 1;
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(`
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
    env.DB.prepare(`
      INSERT INTO chart_versions (chart_id, version, chart_payload, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(chartId, nextVersion, JSON.stringify(body.chartPayload), now)
  ]);

  return json({
    id: chartId,
    version: nextVersion,
    shareUrl: `${new URL(request.url).origin}/play/${chartId}`
  });
}

async function incrementStat(env, chartId, column) {
  const allowed = new Set(["play_count", "like_count", "copied_count"]);
  if (!allowed.has(column)) throw httpError(400, "Invalid stat");

  const result = await env.DB.prepare(`
    UPDATE chart_stats
    SET ${column} = ${column} + 1, updated_at = ?
    WHERE chart_id = ?
  `).bind(new Date().toISOString(), chartId).run();

  if (!result.meta?.changes) throw httpError(404, "Chart not found");
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

  return {
    title,
    description,
    visibility,
    media: {
      kind: normalizedKind,
      youtubeVideoId: normalizedKind === "youtube" ? youtubeVideoId : null,
      localName: normalizedKind === "youtube" ? "" : String(media.localName || body.chartPayload.localMediaName || "").slice(0, 240),
      localSize: normalizedKind === "youtube" ? 0 : Number(media.localSize || body.chartPayload.localMediaSize || 0),
      localDuration: normalizedKind === "youtube" ? 0 : Number(media.localDuration || body.chartPayload.localMediaDuration || 0)
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
    version: row.latest_version,
    playCount: row.play_count,
    likeCount: row.like_count,
    copiedCount: row.copied_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

  if (includePayload) {
    chart.chartPayload = JSON.parse(row.chart_payload);
  }

  return chart;
}

async function startGithubLogin(request, env) {
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
  await env.DB.prepare(`
    INSERT INTO users (id, github_id, username, avatar_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(github_id) DO UPDATE SET
      username = excluded.username,
      avatar_url = excluded.avatar_url,
      updated_at = excluded.updated_at
  `).bind(userId, String(githubUser.id), githubUser.login, githubUser.avatar_url || "", now, now).run();

  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  await env.DB.prepare(`
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

  const row = await env.DB.prepare(`
    SELECT u.id, u.username, u.avatar_url
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ?
  `).bind(sessionId, new Date().toISOString()).first();

  return row ? { id: row.id, username: row.username, avatarUrl: row.avatar_url } : null;
}

async function requireUser(request, env) {
  const user = await requireOptionalUser(request, env);
  if (!user) throw httpError(401, "Login required");
  return user;
}

function assertGithubEnv(env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw httpError(500, "GitHub OAuth env vars are not configured");
  }
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

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
