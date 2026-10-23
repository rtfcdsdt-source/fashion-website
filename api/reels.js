// api/reels.js — Shared reels + stats/comments API for the Fashion Goals website.
// Storage: Neon Postgres over its raw HTTP /sql endpoint (no npm packages).
// Env: DATABASE_URL (or POSTGRES_URL / NEON_DATABASE_URL) + REELS_ADMIN_CODE.
// Plain GET = public shared list. POST {code,url,size} adds (admin code only).
// DELETE {code,id} removes (admin code only).
// ?action=stats (GET) = global counts per video key.
// ?action=comments&key= (GET) = comments for a video key.
// ?action=event (POST) {key,type} = view/like/unlike/share/save/unsave counter.
// ?action=comment (POST) {key,name,text} = post a comment on a global key.
// ?action=delete-comment (POST) {code,id} = admin deletes a comment.
// Global keys: "dil" or starting with "shared-". Until env is set: 503 not_configured.

function getConnString() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.NEON_DATABASE_URL ||
    ""
  );
}

async function neonQuery(connString, query, params) {
  const host = new URL(connString).host;
  const resp = await fetch("https://" + host + "/sql", {
    method: "POST",
    headers: {
      "Neon-Connection-String": connString,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, params: params || [] }),
  });
  if (!resp.ok) throw new Error("db_query_failed");
  const data = await resp.json();
  return data.rows || [];
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body) {
      if (typeof req.body === "string") {
        try { resolve(JSON.parse(req.body)); } catch (e) { resolve({}); }
      } else {
        resolve(req.body);
      }
      return;
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function send(res, status, obj) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  res.status(status).json(obj);
}

function isGlobalKey(key) {
  return typeof key === "string" && (key === "dil" || key.indexOf("shared-") === 0);
}

function checkAdmin(req, res, body) {
  const adminCode = process.env.REELS_ADMIN_CODE || "";
  if (!adminCode) {
    send(res, 503, { ok: false, error: "not_configured" });
    return false;
  }
  if (!body || body.code !== adminCode) {
    send(res, 401, { ok: false, error: "bad_code" });
    return false;
  }
  return true;
}

module.exports = async (req, res) => {
  const connString = getConnString();
  if (!connString) {
    send(res, 503, { ok: false, error: "not_configured" });
    return;
  }
  let action = "";
  let keyParam = "";
  try {
    const u = new URL(req.url, "http://localhost");
    action = u.searchParams.get("action") || "";
    keyParam = u.searchParams.get("key") || "";
  } catch (e) { /* keep defaults */ }

  try {
    await neonQuery(
      connString,
      "CREATE TABLE IF NOT EXISTS shared_reels (id SERIAL PRIMARY KEY, url TEXT NOT NULL, size TEXT NOT NULL DEFAULT 'auto', created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      []
    );
    await neonQuery(
      connString,
      "CREATE TABLE IF NOT EXISTS reel_stats (video_key TEXT PRIMARY KEY, views BIGINT NOT NULL DEFAULT 0, likes BIGINT NOT NULL DEFAULT 0, shares BIGINT NOT NULL DEFAULT 0, saves BIGINT NOT NULL DEFAULT 0)",
      []
    );
    await neonQuery(
      connString,
      "CREATE TABLE IF NOT EXISTS reel_comments (id SERIAL PRIMARY KEY, video_key TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      []
    );

    // ---- GET routes ----
    if (req.method === "GET" && action === "") {
      const rows = await neonQuery(
        connString,
        "SELECT id, url, size, created_at FROM shared_reels ORDER BY id ASC",
        []
      );
      send(res, 200, { ok: true, reels: rows });
      return;
    }

    if (req.method === "GET" && action === "stats") {
      const statRows = await neonQuery(
        connString,
        "SELECT video_key, views, likes, shares, saves FROM reel_stats",
        []
      );
      const countRows = await neonQuery(
        connString,
        "SELECT video_key, COUNT(*)::int AS c FROM reel_comments GROUP BY video_key",
        []
      );
      const stats = {};
      statRows.forEach((r) => {
        stats[r.video_key] = {
          views: Number(r.views) || 0,
          likes: Number(r.likes) || 0,
          shares: Number(r.shares) || 0,
          saves: Number(r.saves) || 0,
          comments: 0,
        };
      });
      countRows.forEach((r) => {
        if (!stats[r.video_key]) {
          stats[r.video_key] = { views: 0, likes: 0, shares: 0, saves: 0, comments: 0 };
        }
        stats[r.video_key].comments = Number(r.c) || 0;
      });
      send(res, 200, { ok: true, stats });
      return;
    }

    if (req.method === "GET" && action === "comments") {
      if (!keyParam) {
        send(res, 400, { ok: false, error: "bad_key" });
        return;
      }
      const rows = await neonQuery(
        connString,
        "SELECT id, name, text, created_at FROM reel_comments WHERE video_key = $1 ORDER BY id ASC LIMIT 100",
        [keyParam]
      );
      send(res, 200, { ok: true, comments: rows });
      return;
    }

    // ---- POST routes ----
    if (req.method === "POST" && action === "event") {
      const body = await readBody(req);
      const typeMap = {
        view: ["views", 1],
        like: ["likes", 1],
        unlike: ["likes", -1],
        share: ["shares", 1],
        save: ["saves", 1],
        unsave: ["saves", -1],
      };
      const spec = body && typeMap[body.type];
      if (!isGlobalKey(body && body.key) || !spec) {
        send(res, 400, { ok: false, error: "bad_event" });
        return;
      }
      const col = spec[0];
      const delta = spec[1];
      const insertVal = delta > 0 ? 1 : 0;
      const q =
        "INSERT INTO reel_stats (video_key, " + col + ") VALUES ($1, $2) " +
        "ON CONFLICT (video_key) DO UPDATE SET " + col +
        " = GREATEST(0, reel_stats." + col + " + $3)";
      await neonQuery(connString, q, [body.key, insertVal, delta]);
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && action === "comment") {
      const body = await readBody(req);
      const name = body && typeof body.name === "string" ? body.name.trim() : "";
      const text = body && typeof body.text === "string" ? body.text.trim() : "";
      if (!isGlobalKey(body && body.key) || name.length < 1 || name.length > 40 || text.length < 1 || text.length > 300) {
        send(res, 400, { ok: false, error: "bad_comment" });
        return;
      }
      const rows = await neonQuery(
        connString,
        "INSERT INTO reel_comments (video_key, name, text) VALUES ($1, $2, $3) RETURNING id, name, text, created_at",
        [body.key, name, text]
      );
      send(res, 200, { ok: true, comment: rows[0] || null });
      return;
    }

    if (req.method === "POST" && action === "delete-comment") {
      const body = await readBody(req);
      if (!checkAdmin(req, res, body)) return;
      const id = parseInt(body.id, 10);
      if (!id) {
        send(res, 400, { ok: false, error: "bad_id" });
        return;
      }
      await neonQuery(connString, "DELETE FROM reel_comments WHERE id = $1", [id]);
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && action === "") {
      const body = await readBody(req);
      if (!checkAdmin(req, res, body)) return;
      const url = typeof body.url === "string" ? body.url.trim() : "";
      const allowed = ["auto", "wide", "tall", "portrait", "square"];
      const size = allowed.indexOf(body.size) >= 0 ? body.size : "auto";
      if (
        !url ||
        (url.indexOf("youtube.com") < 0 &&
          url.indexOf("youtu.be") < 0 &&
          url.indexOf("instagram.com") < 0)
      ) {
        send(res, 400, { ok: false, error: "bad_url" });
        return;
      }
      const rows = await neonQuery(
        connString,
        "INSERT INTO shared_reels (url, size) VALUES ($1, $2) RETURNING id, url, size, created_at",
        [url, size]
      );
      send(res, 200, { ok: true, reel: rows[0] || null });
      return;
    }

    // ---- DELETE route (existing: remove a shared reel) ----
    if (req.method === "DELETE") {
      const body = await readBody(req);
      if (!checkAdmin(req, res, body)) return;
      const id = parseInt(body.id, 10);
      if (!id) {
        send(res, 400, { ok: false, error: "bad_id" });
        return;
      }
      await neonQuery(connString, "DELETE FROM shared_reels WHERE id = $1", [id]);
      send(res, 200, { ok: true });
      return;
    }

    send(res, 405, { ok: false, error: "method_not_allowed" });
  } catch (err) {
    send(res, 500, { ok: false, error: "server_error" });
  }
};
