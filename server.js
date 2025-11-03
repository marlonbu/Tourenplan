// server.js – Vollständiger Produktionscode (Stand: korrigierte Routing-Reihenfolge & Logging)

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

// Uploads-Ordner prüfen
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
app.use("/uploads", express.static("uploads"));

// Multer Setup
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, "uploads/"),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});
const upload = multer({ storage });

// PostgreSQL Setup
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// JWT Setup
const JWT_SECRET = process.env.JWT_SECRET || "tourenplan_secret";
const JWT_EXPIRES_IN = "7d";

// Auth Middleware
const auth = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Kein Token" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Ungültiger oder abgelaufener Token" });
  }
};

// Login
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "Gehlenborg" && password === "Orga1023/") {
    const payload = { sub: username, name: "Gehlenborg", role: "admin" };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    return res.json({ token });
  }
  return res.status(401).json({ error: "Login fehlgeschlagen" });
});

// Tabellen initialisieren
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
      anmerkung_fahrer TEXT DEFAULT NULL,
      foto_url TEXT
    );
  `);
  console.log("✅ Tabellen bereit (inkl. anmerkung_fahrer)");
})().catch((e) => console.error("❌ DB-Init Fehler:", e));

// Healthcheck
app.get("/health", (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Fahrer abrufen
app.get("/fahrer", auth, async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM fahrer ORDER BY id ASC");
    res.json(r.rows);
  } catch (e) {
    console.error("Fehler beim Laden der Fahrer:", e);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

// Touren abrufen
app.get("/touren/:fahrer_id/:datum", auth, async (req, res) => {
  try {
    const { fahrer_id, datum } = req.params;
    const tour = await pool.query(
      "SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2",
      [fahrer_id, datum]
    );
    if (tour.rows.length === 0) return res.json({ tour: null, stopps: [] });

    const stopps = await pool.query(
      "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position ASC, id ASC",
      [tour.rows[0].id]
    );
    res.json({ tour: tour.rows[0], stopps: stopps.rows });
  } catch (e) {
    console.error("❌ Fehler beim Laden der Tour:", e);
    res.status(500).json({ error: "Fehler beim Laden der Tour" });
  }
});

// Stopps nach Tour-ID abrufen (Admin)
app.get("/touren/:id/stopps", auth, async (req, res) => {
  const tourId = req.params.id;
  try {
    console.log("🔍 Lade Stopps für Tour:", tourId);
    const r = await pool.query(
      "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position ASC, id ASC",
      [tourId]
    );
    res.json(r.rows);
  } catch (e) {
    console.error("❌ Fehler beim Laden der Stopps:", e);
    res.status(500).json({ error: "Fehler beim Laden der Stopps" });
  }
});

// Stopp-Anmerkung aktualisieren
app.patch("/stopps/:id", auth, async (req, res) => {
  try {
    const { anmerkung_fahrer } = req.body;
    const result = await pool.query(
      "UPDATE stopps SET anmerkung_fahrer=$1 WHERE id=$2 RETURNING *",
      [anmerkung_fahrer, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (e) {
    console.error("Fehler beim Aktualisieren des Stopps:", e);
    res.status(500).json({ error: "Fehler beim Aktualisieren des Stopps" });
  }
});

// Foto-Upload für Stopp
app.post("/stopps/:id/foto", auth, upload.single("foto"), async (req, res) => {
  try {
    const filePath = `/uploads/${req.file.filename}`;
    const result = await pool.query(
      "UPDATE stopps SET foto_url=$1 WHERE id=$2 RETURNING *",
      [filePath, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (e) {
    console.error("Fehler beim Speichern des Fotos:", e);
    res.status(500).json({ error: "Fehler beim Foto-Upload" });
  }
});

// Tour löschen
app.delete("/touren/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM touren WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Fehler beim Löschen der Tour" });
  }
});

// Wochenexport (PDF/Excel)
app.get("/export/kw/:kw", auth, async (req, res) => {
  try {
    const kw = parseInt(req.params.kw, 10);
    const result = await pool.query(
      "SELECT * FROM touren WHERE EXTRACT(WEEK FROM datum) = $1 ORDER BY datum ASC",
      [kw]
    );
    res.json(result.rows);
  } catch (e) {
    console.error("Fehler beim Wochenexport:", e);
    res.status(500).json({ error: "Fehler beim Wochenexport" });
  }
});

// Excel-Import
app.post("/import/excel", auth, upload.single("file"), async (req, res) => {
  try {
    // Excel-Import Logik folgt (Platzhalter)
    res.json({ ok: true, message: "Import erfolgreich (noch Dummy)" });
  } catch (e) {
    console.error("Fehler beim Excel-Import:", e);
    res.status(500).json({ error: "Fehler beim Excel-Import" });
  }
});

// 🔥 Globales Error-Logging (hilft, 500er zu finden)
app.use((err, req, res, next) => {
  console.error("🔥 Unerwarteter Serverfehler:", err.stack);
  res.status(500).json({ error: "Interner Serverfehler" });
});

// ⚠️ Diese zwei Zeilen MÜSSEN GANZ UNTEN stehen:
const __dirnameFull = path.resolve();
app.use(express.static(path.join(__dirnameFull, "dist")));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirnameFull, "dist", "index.html"));
});

// Serverstart
app.listen(port, () => {
  console.log(`🚀 Tourenplan Backend läuft auf Port ${port}`);
});
