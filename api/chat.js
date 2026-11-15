// Mera AI — Gemini backend (Vercel serverless function, koi dependency nahi).
// Key sirf server-side env var GEMINI_API_KEY se aati hai. Page mein key kabhi nahi hoti,
// aur yahan se key kabhi log ya response mein wapas nahi bheji jati.

var SYS = "Tum 'Mera AI' ho, ek dostana aur madadgaar assistant. User jis language mein likhe (Hindi, Hinglish, English) usi mein jawab do. Jawab saaf, seedha aur chhota rakho. Agar kuch pata nahi to imaandaari se bolo. Pichli baatcheet yaad rakho. Website ya app banane mein madad karo to code step-by-step samjha kar do.";
var MODEL = "gemini-3.5-flash-lite";
var MAX_TURNS = 12; // aakhri 12 turns (user + assistant) bhejte hain
var MAX_TEXT = 4000; // har message ki limit, kharcha bandhne ke liye
var FETCH_TIMEOUT_MS = 9000; // Vercel Hobby 10s limit ke andar rehne ke liye

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

// Client ke messages ko Gemini ke format mein badlo:
// role user -> "user", assistant -> "model"; lagataar ek hi role ko jod do;
// pehla message user ka hona chahiye; aakhri 12 turns hi rakho.
function cleanMessages(input) {
  if (!Array.isArray(input)) return null;
  var out = [];
  for (var i = 0; i < input.length; i++) {
    var m = input[i];
    if (!m || typeof m.text !== "string") continue;
    var text = m.text.trim();
    if (!text) continue;
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    var role = m.role === "assistant" ? "model" : "user";
    if (out.length && out[out.length - 1].role === role) {
      out[out.length - 1].parts[0].text += "\n" + text;
    } else {
      out.push({ role: role, parts: [{ text: text }] });
    }
  }
  // Aakhri 12 turns hi rakho — kaatne ke baad bhi pehla message user ka hona
  // chahiye (Gemini user se shuru na ho to 400 deta hai).
  out = out.slice(-MAX_TURNS * 2);
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length) return null;
  return out;
}

module.exports = async function (req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Sirf POST chalega." });
  }

  var key = process.env.GEMINI_API_KEY;
  if (!key || !String(key).trim()) {
    return json(res, 503, { error: "AI abhi set nahi hua hai. Server par key lagana baaki hai." });
  }

  var body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  var contents = body ? cleanMessages(body.messages) : null;
  if (!contents || !contents.length) {
    return json(res, 400, { error: "Kuch likh kar bhejo, phir jawab milega." });
  }
  if (contents[contents.length - 1].role !== "user") {
    return json(res, 400, { error: "Aakhri message tumhara hona chahiye." });
  }

  var url = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent?key=" + encodeURIComponent(String(key).trim());
  var payload = {
    systemInstruction: { parts: [{ text: SYS }] },
    contents: contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
  };

  var upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch (e) {
    return json(res, 504, { error: "Gemini se jod nahi paya. Thodi der baad dobara try karo." });
  }

  if (upstream.status === 429) {
    return json(res, 429, { error: "Free limit poori ho gayi hai. Thodi der ruk kar dobara try karo." });
  }
  if (!upstream.ok) {
    // Key ya setting ki gadbad (400/403) ya Gemini ki taraf se error.
    // Gemini ka raw error wapas nahi bhejte — usmein kabhi key ka hissa na aaye, isiliye sirf status dekhte hain.
    if (upstream.status === 400 || upstream.status === 403) {
      return json(res, 502, { error: "AI key ya setting mein gadbad hai. Key check karke dobara lagao." });
    }
    return json(res, 502, { error: "Gemini se jawab nahi mila. Thodi der baad dobara try karo." });
  }

  var data = null;
  try { data = await upstream.json(); } catch (e) { data = null; }
  var reply = "";
  try {
    var parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    if (Array.isArray(parts)) {
      reply = parts.map(function (p) { return p && typeof p.text === "string" ? p.text : ""; }).join("").trim();
    }
  } catch (e) { reply = ""; }
  if (!reply) {
    return json(res, 502, { error: "Gemini ne khali jawab diya. Dobara try karo." });
  }
  return json(res, 200, { reply: reply });
};
