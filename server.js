// server.js – Tourenplan Backend (komplett, mit Fahrer-Initialisierung & Foto-Upload)
//
// ✔ CRUD Touren & Stopps
// ✔ Fahrer werden automatisch hinzugefügt (alphabetisch)
// ✔ Foto-Upload: /upload-foto → speichert in /uploads/stopp_<id>.jpg
// ✔ Frontend-kompatibel (React + Vite + Render)
// Version: Oktober 2025

import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { Pool } from "pg";
import multer from "multer";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// ---------- Uploads-Ordner ----------
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use("/uploads", express.static(uploadDir));

// ---------- DB-Verbindung ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ---------- Auth ----------
const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET || "dev-secret", { expiresIn: "8h" });
const authFree = new Set(["/login", "/health", "/uploads"]);

app.use((req, res, next) => {
  if ([...authFree].some((p) => req.path.startsWith(p))) return next();
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Kein Token" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    next();
  } catch {
    return res.status(401).json({ error: "Ungültiger Token" });
  }
});

// ---------- Tabellen anlegen ----------
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      fahrer_id INTEGER NOT NULL REFERENCES fahrer(id) ON DELETE CASCADE,
      datum DATE NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stopps (
      id SERIAL PRIMARY KEY,
      tour_id INTEGER NOT NULL REFERENCES touren(id) ON DELETE CASCADE,
      kunde TEXT NOT NULL,
      adresse TEXT NOT NULL,
      kommission TEXT,
      hinweis TEXT,
      telefon TEXT,
      status TEXT DEFAULT 'offen',
      foto_url TEXT,
      ankunft TIMESTAMP NULL,
      position INTEGER
    );
  `);
}

// ---------- Fahrer-Initialisierung ----------
async function ensureDefaultFahrer() {
  const defaultFahrer = [
    "Christoph Arlt",
    "Johannes Backhaus",
    "Hans Noll",
    "Markus Honkomp",
  ].sort();

  for (const name of defaultFahrer) {
    await pool.query("INSERT INTO fahrer (name) VALUES ($1) ON CONFLICT (name) DO NOTHING;", [name]);
  }
  console.log("✅ Fahrer hinzugefügt/überprüft:", defaultFahrer.join(", "));
}

// ---------- Auth ----------
app.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === "Gehlenborg" && password === "Orga1023/") {
    return res.json({ token: signToken({ user: username }) });
  }
  res.status(401).json({ error: "Login fehlgeschlagen" });
});
app.get("/health", (_, res) => res.json({ ok: true }));

// ---------- Fahrer ----------
app.get("/fahrer", async (_, res) => {
  const { rows } = await pool.query("SELECT id,name FROM fahrer ORDER BY name");
  res.json(rows);
});

// ---------- Tagestour ----------
app.get("/touren/:fahrerId/:datum", async (req, res) => {
  const { fahrerId, datum } = req.params;
  const tourRes = await pool.query(
    "SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2 LIMIT 1;",
    [fahrerId, datum]
  );
  if (tourRes.rowCount === 0) return res.json({ tour: null, stopps: [] });
  const tour = tourRes.rows[0];
  const stopps = await pool.query(
    "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY COALESCE(position,id);",
    [tour.id]
  );
  res.json({ tour, stopps: stopps.rows });
});

// ---------- CRUD Touren ----------
app.post("/touren", async (req, res) => {
  const { fahrer_id, datum } = req.body;
  const { rows } = await pool.query(
    "INSERT INTO touren (fahrer_id,datum) VALUES ($1,$2) RETURNING *;",
    [fahrer_id, datum]
  );
  res.status(201).json(rows[0]);
});
app.delete("/touren/:id", async (req, res) => {
  await pool.query("DELETE FROM stopps WHERE tour_id=$1;", [req.params.id]);
  await pool.query("DELETE FROM touren WHERE id=$1;", [req.params.id]);
  res.json({ ok: true });
});

// ---------- CRUD Stopps ----------
app.post("/stopps", async (req, res) => {
  const {
    tour_id,
    kunde,
    adresse,
    kommission,
    hinweis,
    telefon,
    status,
    position,
  } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO stopps (tour_id,kunde,adresse,kommission,hinweis,telefon,status,position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *;`,
    [tour_id, kunde, adresse, kommission, hinweis, telefon, status, position]
  );
  res.status(201).json(rows[0]);
});
app.put("/stopps/:id", async (req, res) => {
  const keys = Object.keys(req.body);
  if (!keys.length) return res.status(400).json({ error: "Keine Daten" });
  const sets = keys.map((k, i) => `${k}=$${i + 1}`).join(",");
  const vals = [...Object.values(req.body), req.params.id];
  const { rows } = await pool.query(
    `UPDATE stopps SET ${sets} WHERE id=$${vals.length} RETURNING *;`,
    vals
  );
  res.json(rows[0]);
});
app.delete("/stopps/:id", async (req, res) => {
  await pool.query("DELETE FROM stopps WHERE id=$1;", [req.params.id]);
  res.json({ ok: true });
});

// ---------- Upload Foto ----------
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const id = req.body.stopp_id || "unbekannt";
    cb(null, `stopp_${id}.jpg`);
  },
});
const upload = multer({ storage });

app.post("/upload-foto", upload.single("foto"), async (req, res) => {
  try {
    const stoppId = req.body.stopp_id;
    const relPath = `/uploads/${req.file.filename}`;
    await pool.query("UPDATE stopps SET foto_url=$1 WHERE id=$2;", [relPath, stoppId]);
    res.json({ ok: true, url: relPath });
  } catch (e) {
    console.error("Upload Fehler:", e);
    res.status(500).json({ error: "Upload fehlgeschlagen" });
  }
});

// ---------- Reset ----------
app.post("/reset", async (_, res) => {
  await pool.query("TRUNCATE stopps, touren RESTART IDENTITY CASCADE;");
  res.json({ ok: true });
});

// ---------- Root ----------
app.get("/", (_, res) => {
  res.send("✅ Tourenplan Backend läuft (CRUD + Upload + Fahrer-Init aktiv)");
});

// ---------- Start ----------
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  await ensureTables();
  await ensureDefaultFahrer();
  console.log(`🚀 Backend läuft auf Port ${PORT}`);
});
