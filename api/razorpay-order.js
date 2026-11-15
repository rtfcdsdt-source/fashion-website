// Razorpay order — Fashion Goals website (Vercel serverless function, koi dependency nahi).
// Sirf 6 featured products ke liye: har ek ₹700 = 70000 paise.
// Keys sirf server-side env vars RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET se aati hain.
// Page mein key/secret kabhi nahi hote, aur yahan se kabhi log ya response mein
// wapas nahi bheje jate — sirf Key ID checkout.js ko diya jata hai (woh public hota hai).
// Order banana FREE hai — sirf successful payment par ~2% fee lagti hai.

var FEATURED = {
  "flannel": "Red Check Flannel Shirt",
  "floral": "Floral Summer Shirt",
  "blue-jeans": "Classic Blue Jeans",
  "black-jeans": "Black Ripped Jeans",
  "light-jeans": "Light-Wash Ripped Jeans",
  "white-oxford": "White Oxford Shirt"
};
var AMOUNT_PAISE = 70000; // ₹700
var FETCH_TIMEOUT_MS = 8000; // Vercel Hobby 10s limit ke andar rehne ke liye

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

module.exports = async function (req, res) {
  if (req.method !== "POST") {
    return send(res, 405, { ok: false, error: "Sirf POST allowed hai." });
  }
  var body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};
  var productId = body.productId;
  if (!productId || !FEATURED[productId]) {
    return send(res, 400, { ok: false, error: "Ye product Razorpay se nahi kharida ja sakta." });
  }
  var keyId = process.env.RAZORPAY_KEY_ID;
  var secret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !secret) {
    return send(res, 503, { ok: false, error: "Razorpay abhi set nahi hua hai, thodi der baad try karo." });
  }
  // Receipt hi Order ID hai — UPI flow jaisa "FG" + timestamp format,
  // taaki payment aur WhatsApp order ek hi ID se match ho sakein.
  var receipt = "FG" + Date.now();
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
  try {
    var r = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Basic " + Buffer.from(keyId + ":" + secret).toString("base64")
      },
      body: JSON.stringify({
        amount: AMOUNT_PAISE,
        currency: "INR",
        receipt: receipt,
        notes: { product: productId, name: FEATURED[productId] }
      }),
      signal: ctrl.signal
    });
    var data = {};
    try { data = await r.json(); } catch (e) { data = {}; }
    if (!r.ok || !data.id) {
      return send(res, 502, { ok: false, error: "Razorpay se order nahi bana — dobara try karo." });
    }
    return send(res, 200, {
      ok: true,
      orderId: data.id,
      receipt: receipt,
      keyId: keyId,
      amount: AMOUNT_PAISE,
      currency: "INR"
    });
  } catch (e) {
    return send(res, 504, { ok: false, error: "Razorpay se jod nahi paya — dobara try karo." });
  } finally {
    clearTimeout(timer);
  }
};
