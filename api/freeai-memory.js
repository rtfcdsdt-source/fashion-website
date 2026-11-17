// api/freeai-memory.js — Free AI Chat ki "yaad" (server par save).
// Storage: Neon Postgres over its raw HTTP /sql endpoint (no npm packages).
// Env: DATABASE_URL (or POSTGRES_URL / NEON_DATABASE_URL) + REELS_ADMIN_CODE.
// GET  /api/freeai-memory?code=... = yaadein load karo (admin only).
// POST /api/freeai-memory {code, memories} = yaadein save karo (admin only).
// POST /api/freeai-memory?action=clear {code} = yaadein delete karo (admin only).
// Limit: max 30 yaadein, har yaad max 500 chars, total max ~50,000 chars.
// NOTE: Mera AI (meraai-memory.js) jaisa hi hai — farq sirf itna hai ki Free AI Chat
// mein koi email/login nahi hai, isliye ek fixed key ("main") use hoti hai.
// Bina admin code ke koi yaad padh/save nahi sakta.

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

function cleanMemories(memories) {
  if (!Array.isArray(memories)) return null;
  const out = [];
  for (const m of memories) {
    if (typeof m !== "string") continue;
    const text = m.trim().slice(0, 500);
    if (!text) continue;
    out.push(text);
  }
  return out.slice(0, 30);
}

const KEY = "main";

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
      "CREATE TABLE IF NOT EXISTS freeai_memory (key TEXT PRIMARY KEY, memories TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      []
    );

    // ---- Yaadein load karo (admin only) ----
    if (req.method === "GET" && action === "") {
      if (!checkAdminCode(codeParam)) {
        send(res, 401, { ok: false, error: "bad_code" });
        return;
      }
      const rows = await neonQuery(
        connString,
        "SELECT memories FROM freeai_memory WHERE key = $1",
        [KEY]
      );
      let memories = [];
      if (rows[0] && typeof rows[0].memories === "string") {
        try {
          const parsed = JSON.parse(rows[0].memories);
          if (Array.isArray(parsed)) memories = parsed;
        } catch (e) { memories = []; }
      }
      send(res, 200, { ok: true, memories: memories });
      return;
    }

    // ---- Yaadein save karo (admin only) ----
    if (req.method === "POST" && action === "") {
      const body = await readBody(req);
      if (!checkAdminCode(body && body.code)) {
        send(res, 401, { ok: false, error: "bad_code" });
        return;
      }
      const cleaned = cleanMemories(body.memories);
      if (cleaned === null) {
        send(res, 400, { ok: false, error: "bad_memories" });
        return;
      }
      const json = JSON.stringify(cleaned);
      if (json.length > 50000) {
        send(res, 400, { ok: false, error: "too_big" });
        return;
      }
      await neonQuery(
        connString,
        "INSERT INTO freeai_memory (key, memories, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET memories = EXCLUDED.memories, updated_at = now()",
        [KEY, json]
      );
      send(res, 200, { ok: true, count: cleaned.length });
      return;
    }

    // ---- Yaadein delete karo (admin only) ----
    if (req.method === "POST" && action === "clear") {
      const body = await readBody(req);
      if (!checkAdminCode(body && body.code)) {
        send(res, 401, { ok: false, error: "bad_code" });
        return;
      }
      await neonQuery(
        connString,
        "DELETE FROM freeai_memory WHERE key = $1",
        [KEY]
      );
      send(res, 200, { ok: true });
      return;
    }

    send(res, 405, { ok: false, error: "method_not_allowed" });
  } catch (err) {
    send(res, 500, { ok: false, error: "server_error" });
  }
};
