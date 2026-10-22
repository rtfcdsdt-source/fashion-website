// api/reels.js — Shared reels list for the Fashion Goals website.
// Storage: Neon Postgres over its raw HTTP /sql endpoint (no npm packages).
// Env: DATABASE_URL (or POSTGRES_URL / NEON_DATABASE_URL) + REELS_ADMIN_CODE.
// GET is public. POST/DELETE require the owner's secret code.
// Until the env vars are set, every method answers 503 {"ok":false,"error":"not_configured"}
// and the website keeps working exactly as before (local reels only).

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

module.exports = async (req, res) => {
  const connString = getConnString();
  if (!connString) {
    send(res, 503, { ok: false, error: "not_configured" });
    return;
  }
  try {
    await neonQuery(
      connString,
      "CREATE TABLE IF NOT EXISTS shared_reels (id SERIAL PRIMARY KEY, url TEXT NOT NULL, size TEXT NOT NULL DEFAULT 'auto', created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      []
    );

    if (req.method === "GET") {
      const rows = await neonQuery(
        connString,
        "SELECT id, url, size, created_at FROM shared_reels ORDER BY id ASC",
        []
      );
      send(res, 200, { ok: true, reels: rows });
      return;
    }

    if (req.method === "POST" || req.method === "DELETE") {
      const adminCode = process.env.REELS_ADMIN_CODE || "";
      if (!adminCode) {
        send(res, 503, { ok: false, error: "not_configured" });
        return;
      }
      const body = await readBody(req);
      if (!body || body.code !== adminCode) {
        send(res, 401, { ok: false, error: "bad_code" });
        return;
      }
      if (req.method === "POST") {
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
      // DELETE
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
