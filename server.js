// server.js — stabiler Stand mit Hybrid‑Auth (Gehlenborg ODER JWT‑artig),
// optionalem Auth‑Disable, Fahrer/Touren/Stopps/Fotos + Debug‑Routes.

import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ---------- Uploads (lokal ausliefern) ----------
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
app.use("/uploads", express.static("uploads"));

// ---------- Multer (lokale Ablage – später OneDrive integrierbar) ----------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, "uploads/"),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  },
});
const upload = multer({ storage });

// ---------- PostgreSQL ----------
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------- Auth (Hybrid + optional deaktivierbar) ----------
const isJwtLike = (t) => typeof t === "string" && /^\S+\.\S+\.\S+$/.test(t);

const auth = (req, res, next) => {
  if (process.env.DISABLE_AUTH === "true") return next();

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: "Kein Token" });

  // akzeptiere manuellen Dev‑Token ODER irgendein JWT‑artiges Token
  if (token === "Gehlenborg" || isJwtLike(token)) return next();

  return res.status(401).json({ error: "Ungültiger Token" });
};

// Minimal‑Login: gibt als Token „Gehlenborg“ zurück (für manuelle Anmeldung)
app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === "Gehlenborg" && password === "Orga1023/") {
    return res.json({ token: "Gehlenborg" });
  }
  return res.status(401).json({ error: "Login fehlgeschlagen" });
});

// ---------- Tabellen prüfen / erstellen ----------
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      fahrer_id INT REFERENCES fahrer(id) ON DELETE CASCADE,
      datum DATE NOT NULL,
      bemerkung TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stopps (
      id SERIAL PRIMARY KEY,
      tour_id INT REFERENCES touren(id) ON DELETE CASCADE,
      kunde TEXT,
      adresse TEXT,
      telefon TEXT,
      kommission TEXT,
      hinweis TEXT,
      position INT,
      foto_url TEXT
    );
  `);

  console.log("✅ Tabellen überprüft/erstellt");
})().catch((e) => console.error("❌ DB‑Init Fehler:", e));

// ---------- Debug ----------
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get("/whoami", (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  res.json({
    authDisabled: process.env.DISABLE_AUTH === "true",
    hasAuthHeader: Boolean(header),
    tokenSample: token ? token.slice(0, 10) + "…" : null,
  });
});

// ============================================================
// ========== FAHRER ==========================================
// ============================================================
app.get("/fahrer", auth, async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
    res.json(r.rows);
  } catch (e) {
    console.error("Fehler /fahrer GET:", e);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

app.post("/fahrer", auth, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "Name erforderlich" });
  try {
    const r = await pool.query(
      "INSERT INTO fahrer (name) VALUES ($1) RETURNING *",
      [name]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error("Fehler /fahrer POST:", e);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
  }
});

app.delete("/fahrer/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM fahrer WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error("Fehler /fahrer DELETE:", e);
    res.status(500).json({ error: "Fehler beim Löschen" });
  }
});

// ============================================================
// ========== TOUREN ==========================================
// ============================================================
app.post("/touren", auth, async (req, res) => {
  const { fahrer_id, datum } = req.body || {};
  if (!fahrer_id || !datum)
    return res.status(400).json({ error: "Fahrer & Datum erforderlich" });

  try {
    const r = await pool.query(
      "INSERT INTO touren (fahrer_id, datum) VALUES ($1,$2) RETURNING *",
      [fahrer_id, datum]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error("Fehler /touren POST:", e);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour" });
  }
});

app.get("/touren/:fahrer_id/:datum", auth, async (req, res) => {
  try {
    const { fahrer_id, datum } = req.params;
    const t = await pool.query(
      "SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2",
      [fahrer_id, datum]
    );
    if (t.rows.length === 0) return res.json({ tour: null, stopps: [] });

    const tour = t.rows[0];
    const s = await pool.query(
      "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position ASC",
      [tour.id]
    );
    res.json({ tour, stopps: s.rows });
  } catch (e) {
    console.error("Fehler /touren GET:", e);
    res.status(500).json({ error: "Fehler beim Laden der Tour" });
  }
});

// ============================================================
// ========== STOPPS ==========================================
// ============================================================
app.post("/stopps/:tour_id", auth, async (req, res) => {
  const { kunde, adresse, telefon, kommission, hinweis, position } = req.body || {};
  try {
    const r = await pool.query(
      `INSERT INTO stopps (tour_id, kunde, adresse, telefon, kommission, hinweis, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.tour_id, kunde, adresse, telefon, kommission, hinweis, position]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error("Fehler /stopps POST:", e);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Stopps" });
  }
});

app.delete("/stopps/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM stopps WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error("Fehler /stopps DELETE:", e);
    res.status(500).json({ error: "Fehler beim Löschen des Stopps" });
  }
});

// ============================================================
// ========== FOTO‑UPLOAD =====================================
// ============================================================
app.post("/stopps/:id/foto", auth, upload.single("foto"), async (req, res) => {
  try {
    const stoppId = req.params.id;
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Keine Datei erhalten" });

    const publicUrl = `${req.protocol}://${req.get("host")}/uploads/${file.filename}`;
    const r = await pool.query(
      "UPDATE stopps SET foto_url=$1 WHERE id=$2 RETURNING *",
      [publicUrl, stoppId]
    );

    if (r.rows.length === 0) return res.status(404).json({ error: "Stopp nicht gefunden" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("Fehler /stopps/:id/foto POST:", e);
    res.status(500).json({ error: "Fehler beim Foto-Upload" });
  }
});

app.delete("/stopps/:id/foto", auth, async (req, res) => {
  try {
    const stoppId = req.params.id;
    const cur = await pool.query("SELECT foto_url FROM stopps WHERE id=$1", [stoppId]);
    const url = cur.rows[0]?.foto_url;

    if (url) {
      const filename = path.basename(url);
      const filePath = path.join("uploads", filename);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }

    const r = await pool.query(
      "UPDATE stopps SET foto_url=NULL WHERE id=$1 RETURNING *",
      [stoppId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "Stopp nicht gefunden" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("Fehler /stopps/:id/foto DELETE:", e);
    res.status(500).json({ error: "Fehler beim Foto-Löschen" });
  }
});

// ---------- Debug ----------
app.get("/touren-debug", async (_req, res) => {
  const r = await pool.query("SELECT * FROM touren ORDER BY id DESC");
  res.json(r.rows);
});

// ---------- Start ----------
app.listen(port, () => {
  console.log(`🚀 Tourenplan Backend läuft auf Port ${port}`);
});
