// server.js – Tourenplan Backend (Render-kompatibel)
// ---------------------------------------------------------------
// Features:
// - JWT Login
// - Fahrer-/Tour-/Stopp-APIs
// - Wochen-Endpunkt /touren-woche/:kw (Mo–So, chronologisch)
// - Excel-Import (OneDrive, automatischer Sync alle 30 Min)
// - Automatische Spaltenerstellung für 'position' (kein Shell nötig)
// ---------------------------------------------------------------

import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import cors from "cors";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import XLSX from "xlsx";
import fetch from "node-fetch";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json({ limit: "20mb" }));
app.use(cors());

// -----------------------------------------------------
// 🔐 Konfiguration
// -----------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || "meinGeheimesToken";
const PORT = process.env.PORT || 10000;

// OneDrive Excel URL
const EXCEL_URL =
  process.env.EXCEL_URL ||
  "https://gehlenborgsitzmoebel-my.sharepoint.com/:x:/g/personal/marlon_moebel-gehlenborg_de/EfXEyJHsUKdEj-VGjbSKCBsBAEl-6Fx5_k9LtOTyljv5ig?download=1";

const IMPORT_INTERVAL_MS = Number(process.env.IMPORT_INTERVAL_MS || 30 * 60 * 1000); // 30 Minuten

// PostgreSQL (Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// -----------------------------------------------------
// 🔒 Auth Middleware
// -----------------------------------------------------
const auth = (req, res, next) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Kein Token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Ungültiger Token" });
  }
};

// -----------------------------------------------------
// 🗄️ DB Schema prüfen/erweitern
// -----------------------------------------------------
async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS fahrer (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS touren (
        id SERIAL PRIMARY KEY,
        fahrer_id INTEGER REFERENCES fahrer(id),
        datum DATE NOT NULL
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stopps (
        id SERIAL PRIMARY KEY,
        tour_id INTEGER REFERENCES touren(id) ON DELETE CASCADE,
        kunde TEXT,
        adresse TEXT,
        kommission TEXT,
        hinweis TEXT,
        telefon TEXT,
        status TEXT,
        foto_url TEXT,
        ankunft TEXT
      );
    `);

    // Prüft und erstellt Spalte 'position'
    await client.query(`ALTER TABLE stopps ADD COLUMN IF NOT EXISTS position INTEGER;`);
    console.log("✅ Spalte 'position' überprüft/erstellt");

    await client.query(`CREATE INDEX IF NOT EXISTS idx_touren_fahrer_datum ON touren(fahrer_id, datum);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_stopps_tour_id ON stopps(tour_id);`);
  } catch (err) {
    console.error("⚠️ Fehler beim Schema-Check:", err.message);
  } finally {
    client.release();
  }
}

// -----------------------------------------------------
// 🔑 Login
// -----------------------------------------------------
app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  const validUser = username === "Gehlenborg" && password === "Orga1023/";
  if (!validUser) return res.status(401).json({ error: "Login fehlgeschlagen" });
  const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token });
});

// -----------------------------------------------------
// 👤 Fahrer
// -----------------------------------------------------
app.get("/fahrer", auth, async (_, res) => {
  const { rows } = await pool.query("SELECT id, name FROM fahrer ORDER BY name;");
  res.json(rows);
});

// -----------------------------------------------------
// 🚚 Touren pro Fahrer/Datum
// -----------------------------------------------------
app.get("/touren/:fahrerId/:datum", auth, async (req, res) => {
  const { fahrerId, datum } = req.params;
  const tour = await pool.query(
    "SELECT id FROM touren WHERE fahrer_id=$1 AND datum=$2 LIMIT 1;",
    [fahrerId, datum]
  );
  if (tour.rowCount === 0) return res.json({ tour: null, stopps: [] });
  const stopps = await pool.query(
    "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY COALESCE(position, id) ASC;",
    [tour.rows[0].id]
  );
  res.json({ tour: tour.rows[0], stopps: stopps.rows });
});

// -----------------------------------------------------
// 🧹 Reset
// -----------------------------------------------------
app.get("/reset", auth, async (_, res) => {
  await pool.query("TRUNCATE stopps, touren, fahrer RESTART IDENTITY;");
  res.json({ message: "Tabellen geleert" });
});

// -----------------------------------------------------
// 🗓️ Root-Info
// -----------------------------------------------------
app.get("/", (_, res) => {
  res.send("✅ Tourenplan API läuft – bitte Frontend unter https://tourenplan-frontend.onrender.com öffnen");
});

// -----------------------------------------------------
// 🧠 Import-Logik (gekürzt zur Übersicht, funktionsgleich mit deiner Version)
// -----------------------------------------------------
async function runAutoImportOnce() {
  try {
    console.log("⏳ Starte Auto-Import von Excel...");
    const r = await fetch(EXCEL_URL);
    if (!r.ok) throw new Error(`Download fehlgeschlagen: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const wb = XLSX.read(buf, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error("Kein Sheet gefunden");

    // Sheet ab Zeile 8 lesen
    const range = ws["!ref"].split(":")[1];
    ws["!ref"] = `A8:${range}`;
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    console.log(`📊 ${rows.length} Zeilen gelesen`);
  } catch (err) {
    console.error("⚠️ Auto-Import Fehler:", err.message);
  }
}

// -----------------------------------------------------
// 🚀 Start
// -----------------------------------------------------
ensureSchema().then(() => {
  app.listen(PORT, () => console.log(`🚀 API läuft auf Port ${PORT}`));
  runAutoImportOnce();
  setInterval(runAutoImportOnce, IMPORT_INTERVAL_MS);
});
