// server.js — Express + PostgreSQL + stabile JWT-Auth (optional deaktivierbar)
// + Legacy-Kompatibilität: optionaler Dev-Token "Gehlenborg" (ALLOW_DEV_TOKEN)
// Node ≥ 18, ESM aktiv

import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import multer from "multer";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// --------- Uploads-Verzeichnis (lokal ausliefern) ----------
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
app.use("/uploads", express.static("uploads"));

// --------- Multer (lokale Ablage – OneDrive später) ----------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, "uploads/"),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, "_");
    cb(null, `${Date.now()}-${safe}`);
  },
});
const upload = multer({ storage });

// --------- PostgreSQL ----------
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --------- Auth (JWT + optional deaktivierbar + Legacy-Token) ----------
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-render";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
// Legacy-Token standardmäßig erlaubt, zum harten Umschalten auf reines JWT setze ALLOW_DEV_TOKEN=false
const ALLOW_DEV_TOKEN = process.env.ALLOW_DEV_TOKEN !== "false";

const auth = (req, res, next) => {
  // Debug/CI-Modus: Auth abschalten
  if (process.env.DISABLE_AUTH === "true") return next();

  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;

  // --- Legacy-Kompatibilität: früherer Dev-Token "Gehlenborg"
  if (ALLOW_DEV_TOKEN && (header === "Gehlenborg" || bearer === "Gehlenborg")) {
    req.user = { sub: "Gehlenborg", name: "Gehlenborg", role: "legacy" };
    return next();
  }

  // --- Regulär: JWT erwartet
  if (!bearer) return res.status(401).json({ error: "Kein Token" });

  try {
    const payload = jwt.verify(bearer, JWT_SECRET);
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: "Ungültiger oder abgelaufener Token" });
  }
};

// DEV‑Login ersetzt früheren festen Token:
// POST /login -> { token }
app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  const ok = username === "Gehlenborg" && password === "Orga1023/";
  if (!ok) return res.status(401).json({ error: "Login fehlgeschlagen" });

  const payload = { sub: username, name: "Gehlenborg", role: "admin" };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  return res.json({ token });
});

// --------- Tabellen prüfen/erstellen (idempotent) ----------
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
  console.log("✅ Tabellen bereit");
})().catch((e) => console.error("❌ DB‑Init Fehler:", e));

// --------- Debug/Service ----------
app.get("/health", (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// Zeigt, ob ein Authorization‑Header vorhanden ist und ob der JWT gültig ist
app.get("/whoami", (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  const isLegacyDevToken =
    header === "Gehlenborg" || token === "Gehlenborg";

  let decoded = null;
  let validJwt = false;
  if (token) {
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      validJwt = true;
    } catch {
      validJwt = false;
    }
  }

  res.json({
    authDisabled: process.env.DISABLE_AUTH === "true",
    allowDevToken: ALLOW_DEV_TOKEN,
    hasAuthHeader: Boolean(header),
    isLegacyDevToken,
    validJwt,
    user: decoded
      ? { sub: decoded.sub, name: decoded.name, role: decoded.role, exp: decoded.exp }
      : isLegacyDevToken
      ? { sub: "Gehlenborg", name: "Gehlenborg", role: "legacy" }
      : null,
  });
});

// ============================================================
// ========== FAHRER ==========================================
// ============================================================
app.get("/fahrer", auth, async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM fahrer ORDER BY id ASC");
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
    res.json({ ok: true });
  } catch (e) {
    console.error("Fehler /fahrer DELETE:", e);
    res.status(500).json({ error: "Fehler beim Löschen des Fahrers" });
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
      "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position ASC, id ASC",
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
  const { tour_id } = req.params;
  const {
    kunde = null,
    adresse = null,
    telefon = null,
    kommission = null,
    hinweis = null,
    position = null,
  } = req.body || {};

  try {
    const r = await pool.query(
      `INSERT INTO stopps (tour_id, kunde, adresse, telefon, kommission, hinweis, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tour_id, kunde, adresse, telefon, kommission, hinweis, position]
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
    res.json({ ok: true });
  } catch (e) {
    console.error("Fehler /stopps DELETE:", e);
    res.status(500).json({ error: "Fehler beim Löschen des Stopps" });
  }
});

// Foto hochladen
app.post("/stopps/:id/foto", auth, upload.single("foto"), async (req, res) => {
  try {
    const stoppId = req.params.id;
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Kein Foto empfangen" });

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
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore unlink error */
        }
      }
    }

    const r = await pool.query("UPDATE stopps SET foto_url=NULL WHERE id=$1 RETURNING *", [
      stoppId,
    ]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Stopp nicht gefunden" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("Fehler /stopps/:id/foto DELETE:", e);
    res.status(500).json({ error: "Fehler beim Foto-Löschen" });
  }
});

// --------- Debug ----------
app.get("/touren-debug", async (_req, res) => {
  const r = await pool.query("SELECT * FROM touren ORDER BY id DESC");
  res.json(r.rows);
});

// --------- Start ----------
app.listen(port, () => {
  console.log(`🚀 Tourenplan Backend läuft auf Port ${port}`);
});
