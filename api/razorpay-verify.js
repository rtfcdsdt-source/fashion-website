// Razorpay payment verify — Fashion Goals website (Vercel serverless function).
// Checkout se mili signature ko HMAC-SHA256 se check karta hai:
//   HMAC-SHA256(razorpay_order_id + "|" + razorpay_payment_id, RAZORPAY_KEY_SECRET)
// Secret sirf server-side env var se aata hai — page ya response mein kabhi nahi.
// Sirf verify hone par {ok:true} milta hai; tabhi order confirm mana jata hai.

var crypto = require("crypto");

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
  var orderId = body.razorpay_order_id;
  var paymentId = body.razorpay_payment_id;
  var signature = body.razorpay_signature;
  if (!orderId || !paymentId || !signature) {
    return send(res, 400, { ok: false, error: "Payment ki jaankari adhuri hai." });
  }
  var secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    return send(res, 503, { ok: false, error: "Razorpay abhi set nahi hua hai, thodi der baad try karo." });
  }
  var expected = crypto.createHmac("sha256", secret)
    .update(orderId + "|" + paymentId)
    .digest("hex");
  var valid = false;
  try {
    valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (e) {
    valid = false;
  }
  if (!valid) {
    return send(res, 400, { ok: false, error: "Payment verify nahi hua — UPI wale button se try karein." });
  }
  return send(res, 200, { ok: true });
};
