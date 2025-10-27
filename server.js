import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import jwt from "jsonwebtoken";
import multer from "multer";
import pg from "pg";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(bodyParser.json());
app.use("/uploads", express.static("uploads"));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Uploads
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

// Auth
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Kein Token" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "orga1023");
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Ungültiger Token" });
  }
}

// Init
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      fahrer_id INTEGER REFERENCES fahrer(id),
      datum DATE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stopps (
      id SERIAL PRIMARY KEY,
      tour_id INTEGER REFERENCES touren(id),
      kunde TEXT,
      adresse TEXT,
      kommission TEXT,
      hinweis TEXT,
      telefon TEXT,
      status TEXT DEFAULT 'offen',
      foto_url TEXT,
      ankunft TIMESTAMP,
      position INTEGER
    );
  `);

  const base = [
    "Christoph Arlt",
    "Hans Noll",
    "Johannes Backhaus",
    "Markus Honkomp",
  ];
  for (const name of base) {
    await pool.query(
      "INSERT INTO fahrer (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
      [name]
    );
  }
  console.log("✅ Tabellen überprüft/erstellt");
}
initDB();

// Login (einfach)
app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (username === "Gehlenborg" && password === "Orga1023/") {
    const token = jwt.sign({ username, role: "admin" }, process.env.JWT_SECRET || "orga1023", {
      expiresIn: "8h",
    });
    return res.json({ token });
  }
  return res.status(401).json({ error: "Falsche Zugangsdaten" });
});

// Me
app.get("/me", auth, (req, res) => {
  res.json({ username: req.user.username || "Gehlenborg", role: req.user.role || "admin" });
});

// Fahrer
app.get("/fahrer", auth, async (req, res) => {
  const r = await pool.query("SELECT id, name FROM fahrer ORDER BY name ASC");
  res.json(r.rows);
});

// Tagestour
app.get("/touren/:fahrerId/:datum", auth, async (req, res) => {
  const { fahrerId, datum } = req.params;
  const tour = await pool.query(
    "SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2",
    [fahrerId, datum]
  );
  if (tour.rows.length === 0) {
    return res.status(404).json({ error: "Keine Tour gefunden" });
  }
  const tourId = tour.rows[0].id;
  const stopps = await pool.query(
    "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position NULLS LAST, id ASC",
    [tourId]
  );
  res.json({ tour: tour.rows[0], stopps: stopps.rows });
});

// Tour anlegen
app.post("/touren", auth, async (req, res) => {
  const { fahrer_id, datum } = req.body || {};
  try {
    const r = await pool.query(
      "INSERT INTO touren (fahrer_id, datum) VALUES ($1,$2) RETURNING *",
      [fahrer_id, datum]
    );
    res.json({ tour: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour" });
  }
});

// Stopp anlegen
app.post("/stopps", auth, async (req, res) => {
  const { tour_id, kunde, adresse, kommission, hinweis, telefon, position } = req.body || {};
  try {
    const r = await pool.query(
      `INSERT INTO stopps (tour_id, kunde, adresse, kommission, hinweis, telefon, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tour_id, kunde, adresse, kommission, hinweis, telefon, position]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Stopps" });
  }
});

// Stopp löschen
app.delete("/stopps/:id", auth, async (req, res) => {
  const { id } = req.params;
  await pool.query("DELETE FROM stopps WHERE id=$1", [id]);
  res.json({ success: true });
});

// Foto Upload
app.post("/stopps/:id/foto", auth, upload.single("foto"), async (req, res) => {
  const { id } = req.params;
  const url = `/uploads/${req.file.filename}`;
  await pool.query("UPDATE stopps SET foto_url=$1 WHERE id=$2", [url, id]);
  res.json({ success: true, foto_url: url });
});

// *** NEU: Gesamtübersicht /touren-woche ***
app.get("/touren-woche", auth, async (req, res) => {
  let { von, bis, fahrer_id, kunde } = req.query;

  const where = [];
  const params = [];

  if (von) {
    params.push(von);
    where.push(`t.datum >= $${params.length}`);
  }
  if (bis) {
    params.push(bis);
    where.push(`t.datum <= $${params.length}`);
  }
  if (fahrer_id) {
    params.push(fahrer_id);
    where.push(`t.fahrer_id = $${params.length}`);
  }
  if (kunde) {
    params.push(`%${kunde}%`);
    where.push(`s.kunde ILIKE $${params.length}`);
  }

  const sql = `
    SELECT t.datum::text AS datum,
           f.name AS fahrer_name,
           s.kunde, s.adresse, s.kommission
    FROM stopps s
    JOIN touren t ON s.tour_id = t.id
    JOIN fahrer f ON t.fahrer_id = f.id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY t.datum DESC, f.name ASC, s.id ASC
  `;

  try {
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Laden der Übersicht" });
  }
});

app.get("/", (_req, res) => res.send("✅ Tourenplan Backend läuft"));

app.listen(PORT, () => {
  console.log(`🚀 Backend läuft auf Port ${PORT}`);
});
