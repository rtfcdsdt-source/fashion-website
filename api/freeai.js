// api/freeai.js — Free AI Chat ka EK HI server endpoint.
// Vercel Hobby plan mein max 12 Serverless Functions hote hain — isliye Free AI Chat
// ke aath kaam (live search + permanent chat + permanent memory + video samajh + photo samajh
// + Instagram token exchange + YouTube search + music dhun) ek hi file mein hain.
// Route ?fn= se:
//   POST /api/freeai?fn=search {q} → {ok, results: [{title, snippet, link}]} (Serper Google Search)
//   GET  /api/freeai?fn=chat&code=... → chat load karo (admin/owner)
//   POST /api/freeai?fn=chat {code, messages} → chat save karo (admin/owner)
//   POST /api/freeai?fn=chat&action=clear {code} → chat delete karo (admin/owner)
//   GET  /api/freeai?fn=memory&code=... → yaadein load karo (admin/owner)
//   POST /api/freeai?fn=memory {code, memories} → yaadein save karo (admin/owner)
//   POST /api/freeai?fn=memory&action=clear {code} → yaadein delete karo (admin/owner).
//   Chat/memory ka DUSRA raasta (har user ke liye): Google login ka access token
//   bhejo — POST body mein {gtoken, ...} ya GET par "Authorization: Bearer <token>"
//   header. Server token ko Google tokeninfo se jaanchta hai; sahi token par chat
//   us user ki apni key "user:<google-sub>" par save/load hoti hai (har device par
//   wahi chat). Galat/expire token par 401 — shared "main" chat par fallback NAHI.
//   POST /api/freeai?fn=video {video: {mimeType, data}} → {ok, text} (Gemini video samajh, no admin code)
//   POST /api/freeai?fn=photo {image: {mimeType, data}, question?} → {ok, text} (Gemini photo samajh, no admin code)
//   POST /api/freeai?fn=ig-exchange {code, redirect_uri} → {ok, access_token, user_id, expires_in} (Instagram Login token, no admin code)
//   POST /api/freeai?fn=youtube {q} → {ok, results: [{videoId, title, channel, link}]} (YouTube search, no admin code)
//   POST /api/freeai?fn=music {prompt} → {ok, audio: "data:audio/wav;base64,...", duration: 10} (MusicGen dhun, no admin code)
// Env: SERPER_API_KEY (search) + DATABASE_URL (ya POSTGRES_URL / NEON_DATABASE_URL) + REELS_ADMIN_CODE + GEMINI_API_KEY (video + photo) + IG_APP_ID + IG_APP_SECRET (Instagram exchange) + YOUTUBE_API_KEY (YouTube search) + HF_API_TOKEN (MusicGen dhun — Hugging Face ka free token).
// Storage: Neon Postgres over its raw HTTP /sql endpoint (no npm packages).
// Chat limit: max 100 messages, har message max 4000 chars, total max ~200,000 chars.
// Memory limit: max 30 yaadein, har yaad max 500 chars, total max ~50,000 chars.
// NOTE: Mera AI (meraai-chat.js / meraai-memory.js) jaisa hi bunyadi dhancha hai.
// Chat/memory ki pehchan ke do raaste hain: (1) Google login — har user ki chat
// uski apni key "user:<sub>" par (neeche resolveStoreKey dekho); (2) owner ka
// admin code — purani fixed key ("main") par, bilkul pehle jaisa.
// Search mein koi admin code nahi chahiye (Mera AI ki live search ki tarah public feature);
// chat/memory bina Google token ya admin code ke padh/save nahi ho sakte.

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

// ---- Google login wali pehchan (chat/memory ka per-user save, batch 5) ----
// Client Google Identity Services se access token laata hai (scope: sirf
// openid email profile). Server us token ko Google ke tokeninfo se jaanchta
// hai — token isi site ke OAuth client ke liye bana ho (audience/issued_to
// ka milan) aur expire na hua ho, tabhi uske Google sub ko pehchan mana jata
// hai aur chat "user:<sub>" key par save hoti hai. Client ID public hai
// (page ke GIS config mein bhi wahi dikhta hai) — secret nahi hai.
const GOOGLE_CLIENT_ID = "463015858598-mhp99at2ecutc0b81r24afica9c06p04.apps.googleusercontent.com";

async function verifyGoogleToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(token.trim()), { signal: AbortSignal.timeout(5000) });
    if (!r || !r.ok) return null;
    const j = await r.json().catch(function () { return null; });
    if (!j || typeof j !== "object") return null;
    const aud = typeof j.audience === "string" ? j.audience : (typeof j.issued_to === "string" ? j.issued_to : "");
    if (aud !== GOOGLE_CLIENT_ID) return null;
    const expIn = parseInt(j.expires_in, 10);
    if (!isNaN(expIn) && expIn <= 0) return null;
    const sub = (typeof j.user_id === "string" && j.user_id) ? j.user_id : (typeof j.sub === "string" ? j.sub : "");
    if (!sub) return null;
    return { sub: sub, email: typeof j.email === "string" ? j.email : "" };
  } catch (e) { return null; }
}

function googleTokenFromReq(req, body) {
  let tok = "";
  try {
    const auth = (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
    if (typeof auth === "string" && auth.toLowerCase().indexOf("bearer ") === 0) tok = auth.slice(7).trim();
  } catch (e) { tok = ""; }
  if (!tok && body && typeof body.gtoken === "string") tok = body.gtoken.trim();
  return tok;
}

// Chat/Memory ke liye storage key tay karo:
//  - Google token diya gaya ho → use jaancho; sahi ho to "user:<sub>",
//    galat/expire ho to 401 (shared "main" chat par KABHI chup-chaap fallback nahi).
//  - Token na ho → purana owner raasta: admin code sahi ho to "main", warna 401.
// Key mile to wahi return hoti hai; 401 bhej diya ho to null.
async function resolveStoreKey(req, res, body, codeParam) {
  const gtok = googleTokenFromReq(req, body);
  if (gtok) {
    const who = await verifyGoogleToken(gtok);
    if (!who) {
      send(res, 401, { ok: false, error: "Google login ki jaanch nahi ho payi — token galat hai ya expire ho gaya hai. Dobara Google se login karo." });
      return null;
    }
    return "user:" + who.sub;
  }
  const codeOk = req.method === "GET" ? checkAdminCode(codeParam) : checkAdminCode(body && body.code);
  if (!codeOk) {
    send(res, 401, { ok: false, error: "Admin code galat hai ya diya hi nahi gaya." });
    return null;
  }
  return KEY;
}

// ---- Live search (Serper.dev; key na ho ya fail ho → khaali results, chat kabhi nahi rukta) ----
async function handleSearch(req, res) {
  if (req.method !== "POST") {
    send(res, 405, { ok: false, error: "Sirf POST chalega." });
    return;
  }
  const body = await readBody(req);
  const q = typeof (body && body.q) === "string" ? body.q.trim().slice(0, 200) : "";
  if (!q) {
    send(res, 400, { ok: false, error: "Kya dhoondhna hai, wo likho." });
    return;
  }
  const key = process.env.SERPER_API_KEY;
  if (!key || !String(key).trim()) {
    send(res, 200, { ok: true, results: [], note: "Live search band hai — server par search ki chaabi (SERPER_API_KEY) set nahi hai." });
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
      send(res, 200, { ok: true, results: [], note: "Search service ne mana kiya" + (r ? " (HTTP " + r.status + ")" : "") + " — is baar live results nahi mile." });
      return;
    }
    let d = null;
    try { d = await r.json(); } catch (e) { d = null; }
    if (!d || typeof d !== "object") {
      send(res, 200, { ok: true, results: [], note: "Search se kharab jawab aaya — is baar live results nahi mile." });
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
    const note = (e && e.name === "TimeoutError")
      ? "Search mein samay khatm ho gaya (timeout) — is baar live results nahi mile."
      : "Search se jod nahi paya (network) — is baar live results nahi mile.";
    send(res, 200, { ok: true, results: [], note: note });
  }
}

// ---- Permanent chat (table freeai_chats) ----
// Pehchan: Google token → key "user:<sub>"; warna admin code → key "main" (owner).
async function handleChat(req, res, action, codeParam) {
  const connString = getConnString();
  if (!connString) {
    send(res, 503, { ok: false, error: "Server par database set nahi hai — ye suvidha abhi band hai." });
    return;
  }
  const body = req.method === "POST" ? await readBody(req) : null;
  const storeKey = await resolveStoreKey(req, res, body, codeParam);
  if (!storeKey) return; // 401 jawab resolveStoreKey ne bhej diya hai
  try {
    await neonQuery(
      connString,
      "CREATE TABLE IF NOT EXISTS freeai_chats (key TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      []
    );

    if (req.method === "GET" && action === "") {
      const rows = await neonQuery(
        connString,
        "SELECT messages FROM freeai_chats WHERE key = $1",
        [storeKey]
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
      const cleaned = cleanMessages(body && body.messages);
      if (cleaned === null) {
        send(res, 400, { ok: false, error: "Messages sahi roop mein nahi aaye." });
        return;
      }
      const json = JSON.stringify(cleaned);
      if (json.length > 200000) {
        send(res, 400, { ok: false, error: "Data bahut bada hai — seema se zyada hai." });
        return;
      }
      await neonQuery(
        connString,
        "INSERT INTO freeai_chats (key, messages, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET messages = EXCLUDED.messages, updated_at = now()",
        [storeKey, json]
      );
      send(res, 200, { ok: true, count: cleaned.length });
      return;
    }

    if (req.method === "POST" && action === "clear") {
      await neonQuery(
        connString,
        "DELETE FROM freeai_chats WHERE key = $1",
        [storeKey]
      );
      send(res, 200, { ok: true });
      return;
    }

    send(res, 405, { ok: false, error: "Ye tareeka (method) nahi chalta — GET ya POST bhejo." });
  } catch (err) {
    send(res, 500, { ok: false, error: "Database se jod nahi paya — chat save/load nahi ho paya. Dobara try karo." });
  }
}

// ---- Permanent memory (table freeai_memory) ----
// Pehchan chat wali hi hai (resolveStoreKey): Google token → "user:<sub>",
// warna admin code → "main". Dono handler ek hi storage/key pattern par hain,
// isliye per-user keying yahan bhi waisa hi lagaya gaya hai (batch 5).
async function handleMemory(req, res, action, codeParam) {
  const connString = getConnString();
  if (!connString) {
    send(res, 503, { ok: false, error: "Server par database set nahi hai — ye suvidha abhi band hai." });
    return;
  }
  const body = req.method === "POST" ? await readBody(req) : null;
  const storeKey = await resolveStoreKey(req, res, body, codeParam);
  if (!storeKey) return; // 401 jawab resolveStoreKey ne bhej diya hai
  try {
    await neonQuery(
      connString,
      "CREATE TABLE IF NOT EXISTS freeai_memory (key TEXT PRIMARY KEY, memories TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      []
    );

    if (req.method === "GET" && action === "") {
      const rows = await neonQuery(
        connString,
        "SELECT memories FROM freeai_memory WHERE key = $1",
        [storeKey]
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
      const cleaned = cleanMemories(body && body.memories);
      if (cleaned === null) {
        send(res, 400, { ok: false, error: "Yaadein sahi roop mein nahi aayi." });
        return;
      }
      const json = JSON.stringify(cleaned);
      if (json.length > 50000) {
        send(res, 400, { ok: false, error: "Data bahut bada hai — seema se zyada hai." });
        return;
      }
      await neonQuery(
        connString,
        "INSERT INTO freeai_memory (key, memories, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET memories = EXCLUDED.memories, updated_at = now()",
        [storeKey, json]
      );
      send(res, 200, { ok: true, count: cleaned.length });
      return;
    }

    if (req.method === "POST" && action === "clear") {
      await neonQuery(
        connString,
        "DELETE FROM freeai_memory WHERE key = $1",
        [storeKey]
      );
      send(res, 200, { ok: true });
      return;
    }

    send(res, 405, { ok: false, error: "Ye tareeka (method) nahi chalta — GET ya POST bhejo." });
  } catch (err) {
    send(res, 500, { ok: false, error: "Database se jod nahi paya — yaadein save/load nahi ho payin. Dobara try karo." });
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

// Gemini fetch, EK retry ke saath — pehli koshish timeout/network par fail ho
// to ek baar aur try (flaw 18). Har koshish 4.5s ki hai taaki do koshish mil
// kar bhi Vercel Hobby ki ~10s function deewar ke andar rahen; purani ek hi
// 9s wali koshish mein retry ki koi jagah hi nahi bachi thi. HTTP jawab mil
// jaye (kisi bhi status ka) to wahi asal jawab hai — us par retry nahi hota,
// uski wajah handler mein status ke saath naam se aati hai.
async function fetchGeminiRetry(url, payload) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(4500) });
    } catch (e) { /* timeout / network — dusri koshish, phir null */ }
  }
  return null;
}

async function handleVideo(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { ok: false, error: "Sirf POST chalega." }); }
  const key = process.env.GEMINI_API_KEY || "";
  if (!key.trim()) return send(res, 503, { ok: false, error: "Video samajh abhi set nahi hua hai — server par AI ki chaabi (GEMINI_API_KEY) set nahi hai." });
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
  const upstream = await fetchGeminiRetry(url, payload);
  if (!upstream) return send(res, 504, { ok: false, error: "Gemini se samay par jawab nahi aaya — do koshishon mein bhi samay khatm ho gaya (timeout). Dobara try karo." });
  if (upstream.status === 429) return send(res, 429, { ok: false, error: "Free limit poori ho gayi hai. Thodi der ruk kar dobara try karo." });
  if (!upstream.ok) {
    if (upstream.status === 400 || upstream.status === 403) return send(res, 502, { ok: false, error: "AI ki chaabi ya setting mein gadbad hai (HTTP " + upstream.status + ")." });
    return send(res, 502, { ok: false, error: "Upar wali service (Gemini) ne mana kiya — HTTP " + upstream.status + ". Thodi der baad dobara try karo." });
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
  if (!key.trim()) return send(res, 503, { ok: false, error: "Photo samajh abhi set nahi hua hai — server par AI ki chaabi (GEMINI_API_KEY) set nahi hai." });
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
  const upstream = await fetchGeminiRetry(url, payload);
  if (!upstream) return send(res, 504, { ok: false, error: "Gemini se samay par jawab nahi aaya — do koshishon mein bhi samay khatm ho gaya (timeout). Dobara try karo." });
  if (upstream.status === 429) return send(res, 429, { ok: false, error: "Free limit poori ho gayi hai. Thodi der ruk kar dobara try karo." });
  if (!upstream.ok) {
    if (upstream.status === 400 || upstream.status === 403) return send(res, 502, { ok: false, error: "AI ki chaabi ya setting mein gadbad hai (HTTP " + upstream.status + ")." });
    return send(res, 502, { ok: false, error: "Upar wali service (Gemini) ne mana kiya — HTTP " + upstream.status + ". Thodi der baad dobara try karo." });
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
    if (e && e.name === "TimeoutError") return send(res, 504, { ok: false, error: "Instagram se samay par jod nahi paya — samay khatm ho gaya (timeout). Dobara try karo." });
    return send(res, 504, { ok: false, error: "Instagram se jod nahi paya (network). Thodi der baad dobara try karo." });
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

// ---- YouTube search (YouTube Data API v3; key na ho → 503, chat kabhi nahi rukta) ----
async function handleYoutube(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { ok: false, error: "Sirf POST chalega." }); }
  const key = (process.env.YOUTUBE_API_KEY || "").trim();
  if (!key) return send(res, 503, { ok: false, error: "YouTube search abhi set nahi hua hai — YouTube Data API ki key Vercel mein daalni baki hai." });
  const body = await readBody(req);
  const q = typeof (body && body.q) === "string" ? body.q.trim().slice(0, 200) : "";
  if (!q) return send(res, 400, { ok: false, error: "Kya dhoondhna hai, wo likho." });
  try {
    const url = "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=" + encodeURIComponent(q) + "&key=" + encodeURIComponent(key);
    const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
    const j = await r.json().catch(function () { return null; });
    if (!j) return send(res, 502, { ok: false, error: "YouTube se kharab jawab aaya — dobara try karo." });
    if (!r.ok) {
      const reasons = (j.error && Array.isArray(j.error.errors)) ? j.error.errors : [];
      const quota = r.status === 429 || reasons.some(function (x) { return x && (x.reason === "quotaExceeded" || x.reason === "dailyLimitExceeded"); });
      if (quota) return send(res, 429, { ok: false, error: "YouTube ka kota khatm ho gaya hai — thodi der ya kal dobara try karo." });
      return send(res, 502, { ok: false, error: "Upar wali service (YouTube) ne mana kiya — HTTP " + r.status + ". Dobara try karo." });
    }
    if (!Array.isArray(j.items)) return send(res, 502, { ok: false, error: "YouTube se kharab jawab aaya — dobara try karo." });
    const results = j.items.map(function (it) {
      var id = it && it.id && it.id.videoId ? String(it.id.videoId) : "";
      var sn = (it && it.snippet) || {};
      return { videoId: id, title: String(sn.title || ""), channel: String(sn.channelTitle || ""), link: id ? "https://www.youtube.com/watch?v=" + id : "" };
    }).filter(function (x) { return !!x.videoId; });
    return send(res, 200, { ok: true, results: results });
  } catch (e) {
    if (e && e.name === "TimeoutError") return send(res, 504, { ok: false, error: "YouTube se samay par jod nahi paya — samay khatm ho gaya (timeout). Dobara try karo." });
    return send(res, 504, { ok: false, error: "YouTube se jod nahi paya (network) — thodi der baad dobara try karo." });
  }
}

// MusicGen (Hugging Face) — 10 second ki bina-lyrics dhun banao.
// POST /api/freeai?fn=music {prompt} → {ok, audio: "data:audio/wav;base64,...", duration: 10}
// Free tier: token-based (HF_API_TOKEN, bina card), ~100 dhun/roz, max 30s;
// yahan 10s mangte hain taaki Vercel ki 10s wall mein jawab aa jaye (garam model ~5-10s).
// Model musicgen-small (300M) — dhun hi banata hai, gaata nahi (no vocals/lyrics).
async function handleMusic(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { ok: false, error: "Sirf POST chalega." }); }
  const key = (process.env.HF_API_TOKEN || "").trim();
  if (!key) return send(res, 503, { ok: false, error: "no_token" });
  const body = await readBody(req);
  const prompt = typeof (body && body.prompt) === "string" ? body.prompt.trim().slice(0, 200) : "";
  if (!prompt) return send(res, 400, { ok: false, error: "Kis mood ki dhun chahiye, wo likho." });
  try {
    const r = await fetch("https://router.huggingface.co/hf-inference/models/facebook/musicgen-small", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 500 } }),
      signal: AbortSignal.timeout(9000),
    });
    if (r.status === 401 || r.status === 403) return send(res, 401, { ok: false, error: "bad_token" });
    if (r.status === 429) return send(res, 429, { ok: false, error: "limit" });
    if (r.status === 503) {
      let est = 20;
      try { const j = await r.clone().json(); if (j && j.estimated_time) est = Math.ceil(Number(j.estimated_time) || 20); } catch (e) {}
      return send(res, 503, { ok: false, error: "loading", retry_after: Math.min(Math.max(est, 5), 60) });
    }
    if (!r.ok) return send(res, 502, { ok: false, error: "MusicGen ne mana kiya (HTTP " + r.status + ") — thodi der baad dobara try karo." });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return send(res, 502, { ok: false, error: "MusicGen se khaali jawab mila — dobara try karo." });
    if (buf.length > 4000000) return send(res, 502, { ok: false, error: "Dhun bahut badi ban gayi — chhoti prompt se dobara try karo." });
    return send(res, 200, { ok: true, audio: "data:audio/wav;base64," + buf.toString("base64"), duration: 10 });
  } catch (e) {
    if (e && e.name === "TimeoutError") return send(res, 504, { ok: false, error: "MusicGen se samay par jod nahi paya — samay khatm ho gaya (timeout). Dobara try karo." });
    return send(res, 504, { ok: false, error: "MusicGen se jod nahi paya (network) — thodi der baad dobara try karo." });
  }
}

module.exports = async (req, res) => {
  // CORS: the standalone Free AI Chat app (own Vercel project / origin) calls
  // this endpoint cross-origin. No cookies are used (the admin code / Google
  // token travels in the POST body or the Authorization header), so a
  // permissive origin is safe here.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
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
  if (fn === "youtube") return handleYoutube(req, res);
  if (fn === "music") return handleMusic(req, res);
  send(res, 400, { ok: false, error: "Ye kaam (fn) pehchana nahi gaya." });
};
