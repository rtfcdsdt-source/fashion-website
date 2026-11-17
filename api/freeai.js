// api/freeai.js — Free AI Chat ka EK HI server endpoint.
// Vercel Hobby plan mein max 12 Serverless Functions hote hain — isliye Free AI Chat
// ke chhah kaam (live search + permanent chat + permanent memory + video samajh + photo samajh
// + Instagram token exchange) ek hi file mein hain.
// Route ?fn= se:
//   POST /api/freeai?fn=search {q} → {ok, results: [{title, snippet, link}]} (Serper Google Search)
//   GET  /api/freeai?fn=chat&code=... → chat load karo (admin only)
//   POST /api/freeai?fn=chat {code, messages} → chat save karo (admin only)
//   POST /api/freeai?fn=chat&action=clear {code} → chat delete karo (admin only)
//   GET  /api/freeai?fn=memory&code=... → yaadein load karo (admin only)
//   POST /api/freeai?fn=memory {code, memories} → yaadein save karo (admin only)
//   POST /api/freeai?fn=memory&action=clear {code} → yaadein delete karo (admin only).
//   POST /api/freeai?fn=video {video: {mimeType, data}} → {ok, text} (Gemini video samajh, no admin code)
//   POST /api/freeai?fn=photo {image: {mimeType, data}, question?} → {ok, text} (Gemini photo samajh, no admin code)
//   POST /api/freeai?fn=ig-exchange {code, redirect_uri} → {ok, access_token, user_id, expires_in} (Instagram Login token, no admin code)
// Env: SERPER_API_KEY (search) + DATABASE_URL (ya POSTGRES_URL / NEON_DATABASE_URL) + REELS_ADMIN_CODE + GEMINI_API_KEY (video + photo) + IG_APP_ID + IG_APP_SECRET (Instagram exchange).
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

// POST /api/freeai?fn=video {video: {mimeType, data}} → {ok, text} (Gemini video samajh).
// Key sirf server-side GEMINI_API_KEY se aati hai — page mein kabhi nahi hoti.
// Video file kahin save ya log nahi hoti; sirf is ek call mein Gemini ko jaati hai.
// Limit: MP4/WebM/MOV, base64 max ~3.5MB (~2.6MB binary). Video Gemini ko nahi
// bheja ja sakta to backup chain bhi nahi chalti (backup sirf text samajhte hain).
const VIDEO_MIMES = { "video/mp4": 1, "video/webm": 1, "video/quicktime": 1 };
const VIDEO_MODEL = "gemini-3.5-flash";
const VIDEO_MAX_B64 = 3500000;

async function handleVideo(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { ok: false, error: "Sirf POST chalega." }); }
  const key = process.env.GEMINI_API_KEY || "";
  if (!key.trim()) return send(res, 503, { ok: false, error: "Video samajh abhi set nahi hua hai." });
  const body = await readBody(req);
  const v = body && body.video;
  if (!v || typeof v !== "object" || typeof v.mimeType !== "string" || typeof v.data !== "string") {
    return send(res, 400, { ok: false, error: "Video sahi tareeke se nahi bheji gayi." });
  }
  const mime = v.mimeType.trim().toLowerCase();
  let data = v.data.trim();
  const prefix = data.match(/^data:[a-z0-9]+\/[a-z0-9.+-]+;base64,/i);
  if (prefix) data = data.slice(prefix[0].length);
  if (!VIDEO_MIMES[mime]) return send(res, 400, { ok: false, error: "Ye video format nahi chalta. MP4 / WebM / MOV bhejo." });
  if (!data || !/^[A-Za-z0-9+/=_-]+$/.test(data)) return send(res, 400, { ok: false, error: "Video ka data kharab hai. Dobara bhejkar try karo." });
  if (data.length > VIDEO_MAX_B64) return send(res, 400, { ok: false, error: "Video bahut badi hai. Chhoti video bhejkar try karo." });
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + VIDEO_MODEL + ":generateContent?key=" + encodeURIComponent(key.trim());
  const payload = {
    systemInstruction: { parts: [{ text: "Tum ek video samajhne wale helper ho. Jawab HINGLISH mein, chhota aur seedha do. Jo dikhe aur sunai de, wahi batao — andaza mat lagao." }] },
    contents: [{ role: "user", parts: [
      { text: "Is video ko dekh kar aur sun kar Hinglish mein batao:\n1) Video mein kya ho raha hai — scenes kya-kya hain\n2) Koi bol raha hai to kya bol raha hai\n3) Video kis baare mein lagta hai\nJo dikhe/sunai na de, use ghado mat — imaandaari se bolo ki pata nahi chal raha." },
      { inlineData: { mimeType: mime, data: data } }
    ] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
  };
  let upstream = null;
  try {
    upstream = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(9000) });
  } catch (e) { upstream = null; }
  if (!upstream) return send(res, 504, { ok: false, error: "Gemini se jod nahi paya. Thodi der baad dobara try karo." });
  if (upstream.status === 429) return send(res, 429, { ok: false, error: "Free limit poori ho gayi hai. Thodi der ruk kar dobara try karo." });
  if (!upstream.ok) {
    if (upstream.status === 400 || upstream.status === 403) return send(res, 502, { ok: false, error: "AI key ya setting mein gadbad hai." });
    return send(res, 502, { ok: false, error: "Gemini se jawab nahi mila. Thodi der baad dobara try karo." });
  }
  let parsed = null;
  try { parsed = await upstream.json(); } catch (e) { parsed = null; }
  let text = "";
  try {
    const parts = parsed && parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && parsed.candidates[0].content.parts;
    if (Array.isArray(parts)) text = parts.map(function (p) { return p && typeof p.text === "string" ? p.text : ""; }).join("").trim();
  } catch (e) { text = ""; }
  if (!text) return send(res, 502, { ok: false, error: "Gemini ne khali jawab diya. Dobara try karo." });
  return send(res, 200, { ok: true, text: text });
}

// POST /api/freeai?fn=photo {image: {mimeType, data}, question?} → {ok, text} (Gemini photo samajh).
// Key sirf server-side GEMINI_API_KEY se aati hai — page mein kabhi nahi hoti.
// Photo kahin save ya log nahi hoti; sirf is ek call mein Gemini ko jaati hai.
// Limit: JPEG/PNG/WebP/GIF, base64 max ~3.5MB (~2.6MB binary). Photo Gemini ko nahi
// bheja ja sakta to backup chain bhi nahi chalti (backup sirf text samajhte hain).
const PHOTO_MIMES = { "image/jpeg": 1, "image/png": 1, "image/webp": 1, "image/gif": 1 };
const PHOTO_MODEL = "gemini-3.5-flash";
const PHOTO_MAX_B64 = 3500000;

async function handlePhoto(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { ok: false, error: "Sirf POST chalega." }); }
  const key = process.env.GEMINI_API_KEY || "";
  if (!key.trim()) return send(res, 503, { ok: false, error: "Photo samajh abhi set nahi hua hai." });
  const body = await readBody(req);
  const v = body && body.image;
  if (!v || typeof v !== "object" || typeof v.mimeType !== "string" || typeof v.data !== "string") {
    return send(res, 400, { ok: false, error: "Photo sahi tareeke se nahi bheji gayi." });
  }
  const mime = v.mimeType.trim().toLowerCase();
  let data = v.data.trim();
  const prefix = data.match(/^data:[a-z0-9]+\/[a-z0-9.+-]+;base64,/i);
  if (prefix) data = data.slice(prefix[0].length);
  if (!PHOTO_MIMES[mime]) return send(res, 400, { ok: false, error: "Ye photo format nahi chalta. JPEG / PNG / WebP / GIF bhejo." });
  if (!data || !/^[A-Za-z0-9+/=_-]+$/.test(data)) return send(res, 400, { ok: false, error: "Photo ka data kharab hai. Dobara bhejkar try karo." });
  if (data.length > PHOTO_MAX_B64) return send(res, 400, { ok: false, error: "Photo bahut badi hai. Chhoti photo bhejkar try karo." });
  const question = (body && typeof body.question === "string") ? body.question.trim().slice(0, 500) : "";
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + PHOTO_MODEL + ":generateContent?key=" + encodeURIComponent(key.trim());
  const payload = {
    systemInstruction: { parts: [{ text: "Tum ek photo samajhne wale helper ho. Jawab HINGLISH mein, chhota aur seedha do. Photo mein jo dikhe, wahi batao — andaza mat lagao, kuch ghado mat." }] },
    contents: [{ role: "user", parts: [
      { text: question ? ("Is photo ko dekh kar is sawal ka jawab Hinglish mein do: " + question + "\nPhoto mein jo dikhe usi se jawab do — jo na dikhe, use ghado mat, imaandaari se bolo ki pata nahi chal raha.") : "Is photo mein kya-kya dikh raha hai, Hinglish mein batao:\n1) Photo mein kya hai — cheezein, log, jagah\n2) Photo mein likha hua text ho to woh bhi padh kar batao\n3) Photo kis baare mein lagta hai\nJo na dikhe, use ghado mat — imaandaari se bolo ki pata nahi chal raha." },
      { inlineData: { mimeType: mime, data: data } }
    ] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
  };
  let upstream = null;
  try {
    upstream = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(9000) });
  } catch (e) { upstream = null; }
  if (!upstream) return send(res, 504, { ok: false, error: "Gemini se jod nahi paya. Thodi der baad dobara try karo." });
  if (upstream.status === 429) return send(res, 429, { ok: false, error: "Free limit poori ho gayi hai. Thodi der ruk kar dobara try karo." });
  if (!upstream.ok) {
    if (upstream.status === 400 || upstream.status === 403) return send(res, 502, { ok: false, error: "AI key ya setting mein gadbad hai." });
    return send(res, 502, { ok: false, error: "Gemini se jawab nahi mila. Thodi der baad dobara try karo." });
  }
  let parsed = null;
  try { parsed = await upstream.json(); } catch (e) { parsed = null; }
  let text = "";
  try {
    const parts = parsed && parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && parsed.candidates[0].content.parts;
    if (Array.isArray(parts)) text = parts.map(function (p) { return p && typeof p.text === "string" ? p.text : ""; }).join("").trim();
  } catch (e) { text = ""; }
  if (!text) return send(res, 502, { ok: false, error: "Gemini ne khali jawab diya. Dobara try karo." });
  return send(res, 200, { ok: true, text: text });
}

// POST /api/freeai?fn=ig-exchange {code, redirect_uri} → {ok, access_token, user_id, expires_in}.
// Instagram Login: OAuth code → short token (api.instagram.com) → 60-day long token (graph.instagram.com).
// App secret server par hi rehta hai, page mein kabhi nahi jata. No admin code (per-user flow).
async function handleIgExchange(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { ok: false, error: "Sirf POST chalega." }); }
  const appId = (process.env.IG_APP_ID || "").trim();
  const appSecret = (process.env.IG_APP_SECRET || "").trim();
  if (!appId || !appSecret) return send(res, 503, { ok: false, error: "Instagram abhi set nahi hua hai — Meta app ka App ID aur Secret Vercel mein daalna baki hai." });
  const body = await readBody(req);
  const code = (body && typeof body.code === "string") ? body.code.trim() : "";
  const redirectUri = (body && typeof body.redirect_uri === "string") ? body.redirect_uri.trim().slice(0, 500) : "";
  if (!code || !redirectUri) return send(res, 400, { ok: false, error: "Login code nahi mila. Dobara Instagram jodo dabao." });
  let shortTok = null, userId = "";
  try {
    const r1 = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: appId, client_secret: appSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code: code }),
      signal: AbortSignal.timeout(9000)
    });
    const j1 = await r1.json().catch(function () { return null; });
    if (!r1.ok || !j1 || !j1.access_token) return send(res, 502, { ok: false, error: "Instagram se token nahi mila — code galat ya expire ho gaya. Dobara jodo dabao." });
    shortTok = j1.access_token; userId = String(j1.user_id || "");
  } catch (e) {
    return send(res, 504, { ok: false, error: "Instagram se jod nahi paya. Thodi der baad dobara try karo." });
  }
  try {
    const url2 = "https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=" + encodeURIComponent(appSecret) + "&access_token=" + encodeURIComponent(shortTok);
    const r2 = await fetch(url2, { signal: AbortSignal.timeout(9000) });
    const j2 = await r2.json().catch(function () { return null; });
    if (!r2.ok || !j2 || !j2.access_token) return send(res, 200, { ok: true, access_token: shortTok, user_id: userId, expires_in: 3600, short_lived: true });
    return send(res, 200, { ok: true, access_token: j2.access_token, user_id: userId, expires_in: (j2.expires_in || 5184000), short_lived: false });
  } catch (e) {
    return send(res, 200, { ok: true, access_token: shortTok, user_id: userId, expires_in: 3600, short_lived: true });
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
  if (fn === "video") return handleVideo(req, res);
  if (fn === "photo") return handlePhoto(req, res);
  if (fn === "ig-exchange") return handleIgExchange(req, res);
  send(res, 400, { ok: false, error: "bad_fn" });
};
