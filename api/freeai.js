// api/freeai.js — Free AI Chat ka EK HI server endpoint.
// Vercel Hobby plan mein max 12 Serverless Functions hote hain — isliye Free AI Chat
// ke teeno kaam (live search + permanent chat + permanent memory) ek hi file mein hain.
// Route ?fn= se:
//   POST /api/freeai?fn=search {q} → {ok, results: [{title, snippet, link}]} (Serper Google Search)
//   GET  /api/freeai?fn=chat&code=... → chat load karo (admin only)
//   POST /api/freeai?fn=chat {code, messages} → chat save karo (admin only)
//   POST /api/freeai?fn=chat&action=clear {code} → chat delete karo (admin only)
//   GET  /api/freeai?fn=memory&code=... → yaadein load karo (admin only)
//   POST /api/freeai?fn=memory {code, memories} → yaadein save karo (admin only)
//   POST /api/freeai?fn=memory&action=clear {code} → yaadein delete karo (admin only).
// Env: SERPER_API_KEY (search) + DATABASE_URL (ya POSTGRES_URL / NEON_DATABASE_URL) + REELS_ADMIN_CODE.
// Storage: Neon Postgres over its raw HTTP /sql endpoint (no npm packages).
// Chat limit: max 100 messages, har message max 4000 chars, total max ~200,000 chars.
// Memory limit: max 30 yaadein, har yaad max 500 chars, total max ~50,000 chars.
// NOTE: Mera AI (meraai-chat.js / meraai-memory.js) jaisa hi hai — farq sirf itna hai ki
// Free AI Chat mein koi email/login nahi hai, isliye fixed key ("main") use hoti hai.
// Search mein koi admin code nahi chahiye (Mera AI ki live search ki tarah public feature);
// chat/memory bina admin code ke padh/save nahi ho sakte.

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

// ---- Live search (Serper.dev; key na ho ya fail ho → khaali results, chat kabhi nahi rukta) ----
async function handleSearch(req, res) {
  if (req.method !== "POST") {
    send(res, 405, { ok: false, error: "method_not_allowed" });
    return;
  }
  const body = await readBody(req);
  const q = typeof (body && body.q) === "string" ? body.q.trim().slice(0, 200) : "";
  if (!q) {
    send(res, 400, { ok: false, error: "bad_query" });
    return;
  }
  const key = process.env.SERPER_API_KEY;
  if (!key || !String(key).trim()) {
    send(res, 200, { ok: true, results: [] });
    return;
  }
  try {
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": String(key).trim(), "Content-Type": "application/json" },
      body: JSON.stringify({ q: q, gl: "in", hl: "en", num: 5 }),
      signal: AbortSignal.timeout(3000)
    });
    if (!r || !r.ok) {
      send(res, 200, { ok: true, results: [] });
      return;
    }
    let d = null;
    try { d = await r.json(); } catch (e) { d = null; }
    if (!d || typeof d !== "object") {
      send(res, 200, { ok: true, results: [] });
      return;
    }
    const out = [];
    if (d.answerBox) {
      const ab = d.answerBox;
      const aText = ab.answer || ab.snippet || ab.title || "";
      if (aText) out.push({ title: "Seedha jawab", snippet: String(aText).slice(0, 220) });
    }
    const org = Array.isArray(d.organic) ? d.organic : [];
    for (let i = 0; i < org.length && out.length < 5; i++) {
      const o = org[i] || {};
      if (!o.title) continue;
      out.push({ title: String(o.title).slice(0, 120), snippet: String(o.snippet || "").slice(0, 220), link: String(o.link || "") });
    }
    send(res, 200, { ok: true, results: out });
  } catch (e) {
    send(res, 200, { ok: true, results: [] });
  }
}

// ---- Permanent chat (table freeai_chats) ----
async function handleChat(req, res, action, codeParam) {
  const connString = getConnString();
  if (!connString) {
    send(res, 503, { ok: false, error: "not_configured" });
    return;
  }
  try {
    await neonQuery(
      connString,
      "CREATE TABLE IF NOT EXISTS freeai_chats (key TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      []
    );

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
}

// ---- Permanent memory (table freeai_memory) ----
async function handleMemory(req, res, action, codeParam) {
  const connString = getConnString();
  if (!connString) {
    send(res, 503, { ok: false, error: "not_configured" });
    return;
  }
  try {
    await neonQuery(
      connString,
      "CREATE TABLE IF NOT EXISTS freeai_memory (key TEXT PRIMARY KEY, memories TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      []
    );

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
}

module.exports = async (req, res) => {
  let fn = "";
  let action = "";
  let codeParam = "";
  try {
    const u = new URL(req.url, "http://localhost");
    fn = u.searchParams.get("fn") || "";
    action = u.searchParams.get("action") || "";
    codeParam = u.searchParams.get("code") || "";
  } catch (e) { /* keep defaults */ }

  if (fn === "search") return handleSearch(req, res);
  if (fn === "chat") return handleChat(req, res, action, codeParam);
  if (fn === "memory") return handleMemory(req, res, action, codeParam);
  send(res, 400, { ok: false, error: "bad_fn" });
};
