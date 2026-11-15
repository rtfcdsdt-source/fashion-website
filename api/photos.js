// api/photos.js — Photo hosting for the Fashion Goals website (small photo site).
// Storage: Neon Postgres over its raw HTTP /sql endpoint (no npm packages).
// Env: DATABASE_URL (or POSTGRES_URL / NEON_DATABASE_URL) + REELS_ADMIN_CODE.
// POST /api/photos {code, data, mime} = upload a photo (admin only). Returns {ok, id, url}.
// GET /api/photos?code=... = list all photos (admin only).
// POST /api/photos?action=delete {code, id} = delete a photo (admin only).
// Serve a photo: GET /api/photo?id=<id> (public, no code) — see api/photo.js.
// Limit: base64 data max ~1.4M chars (~1MB photo).

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

function checkAdminCode(code) {
  const adminCode = process.env.REELS_ADMIN_CODE || "";
  if (!adminCode) return false;
  return code === adminCode;
}

module.exports = async (req, res) => {
  const connString = getConnString();
  if (!connString) {
    send(res, 503, { ok: false, error: "not_configured" });
    return;
  }
  let action = "";
  let codeParam = "";
  try {
    const u = new URL(req.url, "http://localhost");
    action = u.searchParams.get("action") || "";
    codeParam = u.searchParams.get("code") || "";
  } catch (e) { /* keep defaults */ }

  try {
    await neonQuery(
      connString,
      "CREATE TABLE IF NOT EXISTS photos (id SERIAL PRIMARY KEY, data TEXT NOT NULL, mime TEXT NOT NULL DEFAULT 'image/jpeg', created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      []
    );

    // ---- Upload a photo (admin only) ----
    if (req.method === "POST" && action === "") {
      const body = await readBody(req);
      if (!checkAdminCode(body && body.code)) {
        send(res, 401, { ok: false, error: "bad_code" });
        return;
      }
      const data = typeof body.data === "string" ? body.data.trim() : "";
      const mime = typeof body.mime === "string" ? body.mime.trim() : "";
      const allowedMime = ["image/jpeg", "image/png", "image/webp"];
      if (!data || allowedMime.indexOf(mime) < 0) {
        send(res, 400, { ok: false, error: "bad_photo" });
        return;
      }
      if (data.length > 1400000) {
        send(res, 400, { ok: false, error: "too_big" });
        return;
      }
      let b64 = data;
      const comma = data.indexOf(",");
      if (data.indexOf("data:") === 0 && comma >= 0) b64 = data.slice(comma + 1);
      if (!/^[A-Za-z0-9+/=]+$/.test(b64)) {
        send(res, 400, { ok: false, error: "bad_photo" });
        return;
      }
      const rows = await neonQuery(
        connString,
        "INSERT INTO photos (data, mime) VALUES ($1,$2) RETURNING id, mime, created_at",
        [b64, mime]
      );
      const id = rows[0] && rows[0].id;
      send(res, 200, { ok: true, id: id, url: "/api/photo?id=" + id });
      return;
    }

    // ---- List all photos (admin only) ----
    if (req.method === "GET" && action === "") {
      if (!checkAdminCode(codeParam)) {
        send(res, 401, { ok: false, error: "bad_code" });
        return;
      }
      const rows = await neonQuery(
        connString,
        "SELECT id, mime, created_at FROM photos ORDER BY id DESC",
        []
      );
      send(res, 200, { ok: true, photos: rows });
      return;
    }

    // ---- Delete a photo (admin only) ----
    if (req.method === "POST" && action === "delete") {
      const body = await readBody(req);
      if (!checkAdminCode(body && body.code)) {
        send(res, 401, { ok: false, error: "bad_code" });
        return;
      }
      const id = parseInt(body.id, 10);
      if (!id) {
        send(res, 400, { ok: false, error: "bad_id" });
        return;
      }
      await neonQuery(connString, "DELETE FROM photos WHERE id = $1", [id]);
      send(res, 200, { ok: true });
      return;
    }

    send(res, 405, { ok: false, error: "method_not_allowed" });
  } catch (err) {
    send(res, 500, { ok: false, error: "server_error" });
  }
};
