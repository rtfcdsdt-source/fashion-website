// api/freeai-chat.js — Free AI Chat ki permanent chat (server par save).
// Storage: Neon Postgres over its raw HTTP /sql endpoint (no npm packages).
// Env: DATABASE_URL (or POSTGRES_URL / NEON_DATABASE_URL) + REELS_ADMIN_CODE.
// GET  /api/freeai-chat?code=... = chat load karo (admin only).
// POST /api/freeai-chat {code, messages} = chat save karo (admin only).
// POST /api/freeai-chat?action=clear {code} = chat delete karo (admin only).
// Limit: max 100 messages, har message max 4000 chars, total max ~200,000 chars.
// NOTE: Mera AI (meraai-chat.js) jaisa hi hai — farq sirf itna hai ki Free AI Chat
// mein koi email/login nahi hai, isliye ek fixed key ("main") use hoti hai.
// Bina admin code ke koi chat padh/save nahi sakta.

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

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return null;
  const out = [];
  for (const m of messages) {
    if (!m || typeof m.text !== "string") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const text = m.text.slice(0, 4000);
    if (!text.trim()) continue;
    out.push({ role: role, text: text });
  }
  return out.slice(-100);
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
      "CREATE TABLE IF NOT EXISTS freeai_chats (key TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      []
    );

    // ---- Chat load karo (admin only) ----
    if (req.method === "GET" && action === "") {
      if (!checkAdminCode(codeParam)) {
        send(res, 401, { ok: false, error: "bad_code" });
        return;
      }
      const rows = await neonQuery(
        connString,
        "SELECT messages FROM freeai_chats WHERE key = $1",
        [KEY]
      );
      let messages = [];
      if (rows[0] && typeof rows[0].messages === "string") {
        try {
          const parsed = JSON.parse(rows[0].messages);
          if (Array.isArray(parsed)) messages = parsed;
        } catch (e) { messages = []; }
      }
      send(res, 200, { ok: true, messages: messages });
      return;
    }

    // ---- Chat save karo (admin only) ----
    if (req.method === "POST" && action === "") {
      const body = await readBody(req);
      if (!checkAdminCode(body && body.code)) {
        send(res, 401, { ok: false, error: "bad_code" });
        return;
      }
      const cleaned = cleanMessages(body.messages);
      if (cleaned === null) {
        send(res, 400, { ok: false, error: "bad_messages" });
        return;
      }
      const json = JSON.stringify(cleaned);
      if (json.length > 200000) {
        send(res, 400, { ok: false, error: "too_big" });
        return;
      }
      await neonQuery(
        connString,
        "INSERT INTO freeai_chats (key, messages, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET messages = EXCLUDED.messages, updated_at = now()",
        [KEY, json]
      );
      send(res, 200, { ok: true, count: cleaned.length });
      return;
    }

    // ---- Chat delete karo (admin only) ----
    if (req.method === "POST" && action === "clear") {
      const body = await readBody(req);
      if (!checkAdminCode(body && body.code)) {
        send(res, 401, { ok: false, error: "bad_code" });
        return;
      }
      await neonQuery(
        connString,
        "DELETE FROM freeai_chats WHERE key = $1",
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
