// api/products.js — User-added products for the Fashion Goals shop (Add Product).
// Storage: Neon Postgres over its raw HTTP /sql endpoint (no npm packages).
// Env: DATABASE_URL (or POSTGRES_URL / NEON_DATABASE_URL) + REELS_ADMIN_CODE.
// POST /api/products {code, name, price, photo} = add a product (admin only).
// GET /api/products = list all user products (public — the shop fetches this).
// POST /api/products?action=delete {code, id} = delete a product (admin only).

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
  try {
    const u = new URL(req.url, "http://localhost");
    action = u.searchParams.get("action") || "";
  } catch (e) { /* keep default */ }

  try {
    await neonQuery(
      connString,
      "CREATE TABLE IF NOT EXISTS user_products (id SERIAL PRIMARY KEY, name TEXT NOT NULL, price INT NOT NULL, photo TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      []
    );

    // ---- Add a product (admin only) ----
    if (req.method === "POST" && action === "") {
      const body = await readBody(req);
      if (!checkAdminCode(body && body.code)) {
        send(res, 401, { ok: false, error: "bad_code" });
        return;
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const photo = typeof body.photo === "string" ? body.photo.trim() : "";
      const price = parseInt(body.price, 10);
      if (!name || !photo || !price || price <= 0) {
        send(res, 400, { ok: false, error: "bad_product" });
        return;
      }
      if (photo.indexOf("http://") !== 0 && photo.indexOf("https://") !== 0) {
        send(res, 400, { ok: false, error: "bad_photo_link" });
        return;
      }
      if (name.length > 200 || photo.length > 2000) {
        send(res, 400, { ok: false, error: "bad_product" });
        return;
      }
      const rows = await neonQuery(
        connString,
        "INSERT INTO user_products (name, price, photo) VALUES ($1,$2,$3) RETURNING id, name, price, photo, created_at",
        [name, price, photo]
      );
      const p = rows[0];
      send(res, 200, {
        ok: true,
        product: { id: "u-" + p.id, name: p.name, price: p.price, photo: p.photo, created_at: p.created_at },
      });
      return;
    }

    // ---- List all user products (public) ----
    if (req.method === "GET" && action === "") {
      const rows = await neonQuery(
        connString,
        "SELECT id, name, price, photo, created_at FROM user_products ORDER BY id DESC",
        []
      );
      const products = rows.map(function (r) {
        return { id: "u-" + r.id, name: r.name, price: r.price, photo: r.photo, created_at: r.created_at };
      });
      send(res, 200, { ok: true, products: products });
      return;
    }

    // ---- Delete a product (admin only) ----
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
      await neonQuery(connString, "DELETE FROM user_products WHERE id = $1", [id]);
      send(res, 200, { ok: true });
      return;
    }

    send(res, 405, { ok: false, error: "method_not_allowed" });
  } catch (err) {
    send(res, 500, { ok: false, error: "server_error" });
  }
};
