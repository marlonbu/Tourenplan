// server.js – Tourenplan Backend (Render-kompatibel, mit Wochen-Endpunkt)

import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import cors from "cors";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());
app.use(cors());

// -----------------------------------------------------
// 🔐 Konfiguration
// -----------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || "meinGeheimesToken";
const PORT = process.env.PORT || 10000;

// PostgreSQL (Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// -----------------------------------------------------
// 📁 Upload-Verzeichnis
// -----------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

// Multer
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

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
// 🗄️ DB Schema prüfen
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
        tour_id INTEGER REFERENCES touren(id),
        kunde TEXT,
        adresse TEXT,
        kommission TEXT,
        hinweis TEXT,
        telefon TEXT,
        status TEXT,
        foto_url TEXT
      );
    `);
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
    "SELECT id, fahrer_id, datum FROM touren WHERE fahrer_id=$1 AND datum=$2 LIMIT 1",
    [fahrerId, datum]
  );
  if (tour.rowCount === 0) return res.json({ tour: null, stopps: [] });
  const tourId = tour.rows[0].id;

  const stopps = await pool.query(
    "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY id ASC",
    [tourId]
  );
  res.json({ tour: tour.rows[0], stopps: stopps.rows });
});

// -----------------------------------------------------
// 🆕 Wochen-Endpunkt: Alle Fahrer, KW → Mo–So
// -----------------------------------------------------
app.get("/touren-woche/:kw", auth, async (req, res) => {
  const kw = parseInt(req.params.kw);
  if (isNaN(kw) || kw < 1 || kw > 53) {
    return res.status(400).json({ error: "Ungültige Kalenderwoche" });
  }

  const year = new Date().getFullYear();

  // Montag der KW berechnen (ISO-Standard)
  const simple = new Date(year, 0, 1 + (kw - 1) * 7);
  const dow = simple.getDay();
  const monday = new Date(simple);
  monday.setDate(simple.getDate() - ((dow + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const startDate = monday.toISOString().split("T")[0];
  const endDate = sunday.toISOString().split("T")[0];

  try {
    const query = `
      SELECT
        f.name AS fahrer,
        s.kunde,
        s.kommission,
        s.hinweis,
        t.datum
      FROM stopps s
      JOIN touren t ON s.tour_id = t.id
      JOIN fahrer f ON t.fahrer_id = f.id
      WHERE t.datum BETWEEN $1 AND $2
      ORDER BY t.datum ASC, f.name ASC;
    `;
    const { rows } = await pool.query(query, [startDate, endDate]);
    res.json({ kw, startDate, endDate, touren: rows });
  } catch (err) {
    console.error("Fehler bei /touren-woche:", err);
    res.status(500).json({ error: "Fehler beim Laden der Wochentouren" });
  }
});

// -----------------------------------------------------
// 🌱 Demo-Daten
// -----------------------------------------------------
app.get("/seed-demo", auth, async (_, res) => {
  await pool.query("TRUNCATE stopps, touren, fahrer RESTART IDENTITY;");
  const fahrer = await pool.query(
    "INSERT INTO fahrer (name) VALUES ('Christoph Arlt') RETURNING id;"
  );
  const fahrerId = fahrer.rows[0].id;

  const today = new Date();
  const tour = await pool.query(
    "INSERT INTO touren (fahrer_id, datum) VALUES ($1, $2) RETURNING id;",
    [fahrerId, today.toISOString().split("T")[0]]
  );
  const tourId = tour.rows[0].id;

  const stopps = [
    ["Kunde A", "Möhlenkamp 26, 49681 Garrel", "12345", "Anlieferung am Vormittag"],
    ["Kunde B", "Schwaneburger Weg 39, 26169 Friesoythe", "23456", "Bitte vorher anrufen"],
    ["Kunde C", "Am Rundtörn 18, 26135 Oldenburg", "34567", "Hintereingang nutzen"],
    ["Kunde D", "Wiesenstr. 31a, 28857 Syke", "45678", "Ladung nur absetzen"],
  ];

  for (const [kunde, adresse, kommission, hinweis] of stopps) {
    await pool.query(
      "INSERT INTO stopps (tour_id, kunde, adresse, kommission, hinweis) VALUES ($1,$2,$3,$4,$5);",
      [tourId, kunde, adresse, kommission, hinweis]
    );
  }

  res.json({ message: "Demo-Daten erfolgreich erstellt" });
});

// -----------------------------------------------------
// 🚀 Start
// -----------------------------------------------------
ensureSchema().then(() => {
  app.listen(PORT, () => console.log(`🚀 API läuft auf Port ${PORT}`));
});
