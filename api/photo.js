// api/photo.js — Serve one hosted photo by id (public link).
// GET /api/photo?id=<id> returns the image bytes with its stored mime type.
// Env: DATABASE_URL (or POSTGRES_URL / NEON_DATABASE_URL). No admin code (public link).

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

module.exports = async (req, res) => {
  const connString = getConnString();
  if (!connString) {
    res.status(503).send("not_configured");
    return;
  }
  let id = 0;
  try {
    const u = new URL(req.url, "http://localhost");
    id = parseInt(u.searchParams.get("id"), 10) || 0;
  } catch (e) { /* keep 0 */ }
  if (!id) {
    res.status(400).send("bad_id");
    return;
  }
  try {
    const rows = await neonQuery(
      connString,
      "SELECT data, mime FROM photos WHERE id = $1",
      [id]
    );
    if (!rows.length) {
      res.status(404).send("not_found");
      return;
    }
    const buf = Buffer.from(rows[0].data, "base64");
    res.setHeader("Content-Type", rows[0].mime || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.status(200).send(buf);
  } catch (err) {
    res.status(500).send("server_error");
  }
};
