// api/publish-site.js — Mera AI se bani demo website ko GitHub → Vercel par live karo.
// POST /api/publish-site {code, title, html, css, js} = publish.
// Sirf admin (REELS_ADMIN_CODE) kar sakta hai — bina code ke koi bhi is site par page nahi daal sakta.
// Env: GITHUB_PUBLISH_TOKEN (fine-grained PAT, sirf rtfcdsdt-source/fashion-website repo,
//      Contents: read+write) + REELS_ADMIN_CODE.
// Site yahan save hoti hai: sites/<slug>/index.html (fashion-website repo).
// Live URL: https://fashion-website-theta-taupe.vercel.app/sites/<slug>/
// Limit: total code max ~200KB. Wahi slug dobara publish ho to page UPDATE hota hai (naya nahi banta).
// Koi dependency nahi; token kabhi response mein wapas nahi bheja jata.

var REPO_OWNER = "rtfcdsdt-source";
var REPO_NAME = "fashion-website";
var SITE_BASE = "https://fashion-website-theta-taupe.vercel.app/sites/";
var MAX_TOTAL = 200000; // chars

function readBody(req) {
  return new Promise(function (resolve) {
    if (req.body) {
      if (typeof req.body === "string") {
        try { resolve(JSON.parse(req.body)); } catch (e) { resolve({}); }
      } else {
        resolve(req.body);
      }
      return;
    }
    var raw = "";
    req.on("data", function (chunk) { raw += chunk; });
    req.on("end", function () {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
    req.on("error", function () { resolve({}); });
  });
}

function send(res, status, obj) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  res.status(status).json(obj);
}

function checkAdminCode(code) {
  var adminCode = process.env.REELS_ADMIN_CODE || "";
  if (!adminCode) return false;
  return code === adminCode;
}

// Title se URL slug: "Chai Tapri" -> "chai-tapri". Hindi/sirf-symbol title ho to
// title ka hash use hota hai (deterministic — dobara publish karne par wahi page update hota hai).
function slugify(title) {
  var s = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (s) return s;
  var h = 0;
  var t = String(title || "");
  for (var i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) % 100000; }
  return "site-" + h.toString(36);
}

// Preview (srcOf) jaisa hi combined page, bas <title> joda hua.
function combineHtml(title, html, css, js) {
  var t = String(title || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + t + "</title><style>" + String(css || "").replace(/<\/style/gi, "<\\/style") + "</style></head><body>" + String(html || "") + "<script>try{" + String(js || "").replace(/<\/script/gi, "<\\/script") + "}catch(e){}<\/script></body></html>";
}

module.exports = async function (req, res) {
  if (req.method !== "POST") {
    send(res, 405, { ok: false, error: "method" });
    return;
  }
  var body = await readBody(req);
  if (!checkAdminCode(body && body.code)) {
    send(res, 401, { ok: false, error: "bad_code" });
    return;
  }
  var token = process.env.GITHUB_PUBLISH_TOKEN || "";
  if (!token) {
    send(res, 503, { ok: false, error: "no_token" });
    return;
  }
  var title = String((body && body.title) || "").slice(0, 120);
  var html = String((body && body.html) || "");
  var css = String((body && body.css) || "");
  var js = String((body && body.js) || "");
  if (!html.trim() || (html.length + css.length + js.length) > MAX_TOTAL) {
    send(res, 400, { ok: false, error: "bad_request" });
    return;
  }
  var slug = slugify(title);
  var path = "sites/" + slug + "/index.html";
  var full = combineHtml(title, html, css, js);
  var content = Buffer.from(full, "utf8").toString("base64");
  var headers = {
    "Authorization": "Bearer " + token,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json"
  };
  var apiUrl = "https://api.github.com/repos/" + REPO_OWNER + "/" + REPO_NAME + "/contents/" + path;
  // Pehle dekho page pehle se hai ya nahi (hai to update ke liye sha chahiye).
  var sha = null;
  var exists = false;
  try {
    var g = await fetch(apiUrl, { headers: headers, signal: AbortSignal.timeout(5000) });
    if (g.ok) {
      var gd = null;
      try { gd = await g.json(); } catch (e) { gd = null; }
      sha = (gd && gd.sha) || null;
      exists = true;
    } else if (g.status !== 404) {
      send(res, 502, { ok: false, error: "github_error", status: g.status });
      return;
    }
  } catch (e) {
    send(res, 502, { ok: false, error: "github_unreachable" });
    return;
  }
  var putBody = { message: "Publish Mera AI site: " + slug, content: content };
  if (sha) putBody.sha = sha;
  try {
    var p = await fetch(apiUrl, {
      method: "PUT",
      headers: headers,
      body: JSON.stringify(putBody),
      signal: AbortSignal.timeout(5000)
    });
    if (!p.ok) {
      send(res, 502, { ok: false, error: "github_error", status: p.status });
      return;
    }
  } catch (e) {
    send(res, 502, { ok: false, error: "github_unreachable" });
    return;
  }
  send(res, 200, { ok: true, slug: slug, updated: exists, url: SITE_BASE + slug + "/" });
};

module.exports.slugify = slugify;
module.exports.combineHtml = combineHtml;
