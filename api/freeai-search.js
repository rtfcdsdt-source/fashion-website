// api/freeai-search.js — Free AI Chat ki live search (Serper.dev Google Search API).
// POST /api/freeai-search {q} → {ok: true, results: [{title, snippet, link}]}.
// Env: SERPER_API_KEY (Vercel env; Mera AI wali key hi use hoti hai — 2,500 free queries).
// Key na ho ya search fail ho → khaali results — chat kabhi nahi rukta.
// NOTE: koi admin code nahi chahiye — Mera AI ki live search ki tarah public feature hai.

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
};
