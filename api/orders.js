// api/orders.js — Orders API for the Fashion Goals website (order dashboard).
// Storage: Neon Postgres over its raw HTTP /sql endpoint (no npm packages).
// Env: DATABASE_URL (or POSTGRES_URL / NEON_DATABASE_URL) + REELS_ADMIN_CODE.
// POST /api/orders (no action) = save a new order (customer, no code needed).
// GET /api/orders?code=... = list all orders (admin code only).
// POST /api/orders?action=status {code,id,status} = update status (admin only).
// POST /api/orders?action=delete {code,id} = delete an order (admin only).
// Status: new, packed, shipped, delivered, cancelled.

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
      "CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, order_id TEXT NOT NULL, product TEXT NOT NULL, price INT NOT NULL DEFAULT 0, size TEXT NOT NULL DEFAULT '', colour TEXT NOT NULL DEFAULT '', customer_name TEXT NOT NULL DEFAULT '', mobile TEXT NOT NULL DEFAULT '', pincode TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', payment TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new', created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      []
    );

    // ---- Save a new order (customer, no admin code) ----
    if (req.method === "POST" && action === "") {
      const body = await readBody(req);
      const orderId = typeof body.orderId === "string" ? body.orderId.trim() : "";
      const product = typeof body.product === "string" ? body.product.trim() : "";
      const price = parseInt(body.price, 10) || 0;
      const size = typeof body.size === "string" ? body.size.trim() : "";
      const colour = typeof body.colour === "string" ? body.colour.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const mobile = typeof body.mobile === "string" ? body.mobile.trim() : "";
      const pincode = typeof body.pincode === "string" ? body.pincode.trim() : "";
      const address = typeof body.address === "string" ? body.address.trim() : "";
      const payment = typeof body.payment === "string" ? body.payment.trim() : "";
      if (!orderId || !product || !name || !mobile) {
        send(res, 400, { ok: false, error: "bad_order" });
        return;
      }
      const rows = await neonQuery(
        connString,
        "INSERT INTO orders (order_id, product, price, size, colour, customer_name, mobile, pincode, address, payment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, order_id, product, price, size, colour, customer_name, mobile, pincode, address, payment, status, created_at",
        [orderId, product, price, size, colour, name, mobile, pincode, address, payment]
      );
      send(res, 200, { ok: true, order: rows[0] || null });
      return;
    }

    // ---- List all orders (admin only) ----
    if (req.method === "GET" && action === "") {
      if (!checkAdminCode(codeParam)) {
        send(res, 401, { ok: false, error: "bad_code" });
        return;
      }
      const rows = await neonQuery(
        connString,
        "SELECT id, order_id, product, price, size, colour, customer_name, mobile, pincode, address, payment, status, created_at FROM orders ORDER BY id DESC",
        []
      );
      send(res, 200, { ok: true, orders: rows });
      return;
    }

    // ---- Update status (admin only) ----
    if (req.method === "POST" && action === "status") {
      const body = await readBody(req);
      if (!checkAdminCode(body && body.code)) {
        send(res, 401, { ok: false, error: "bad_code" });
        return;
      }
      const id = parseInt(body.id, 10);
      const allowed = ["new", "packed", "shipped", "delivered", "cancelled"];
      const status = allowed.indexOf(body.status) >= 0 ? body.status : "";
      if (!id || !status) {
        send(res, 400, { ok: false, error: "bad_status" });
        return;
      }
      await neonQuery(connString, "UPDATE orders SET status = $1 WHERE id = $2", [status, id]);
      send(res, 200, { ok: true });
      return;
    }

    // ---- Delete an order (admin only) ----
    if (req.method === "POST" && action === "delete") {
      const body = await readBody(req);
      if (!checkAdminCode(body && body.code)) {
        send(res, 401, { ok: false, error: "bad_code" });
        return;
      }
      const id = parseInt(body.id, 10);
      if (!id) {
        send(res, 400, { ok: false, error: "bad_id" });
        return;
      }
      await neonQuery(connString, "DELETE FROM orders WHERE id = $1", [id]);
      send(res, 200, { ok: true });
      return;
    }

    send(res, 405, { ok: false, error: "method_not_allowed" });
  } catch (err) {
    send(res, 500, { ok: false, error: "server_error" });
  }
};
