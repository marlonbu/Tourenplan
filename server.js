import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pkg from "pg";
import jwt from "jsonwebtoken";
import multer from "multer";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pkg;
const app = express();
app.use(cors());
app.use(bodyParser.json());

// 🗄️ PostgreSQL-Verbindung
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 🔐 Auth Middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Kein Token" });

  try {
    jwt.verify(token, process.env.JWT_SECRET || "tourenplan");
    next();
  } catch (err) {
    return res.status(403).json({ error: "Ungültiger Token" });
  }
}

// 🧱 Tabellen prüfen / erstellen
async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      fahrer_id INTEGER REFERENCES fahrer(id) ON DELETE CASCADE,
      datum DATE
    );
  `);

  await pool.query(`
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
      ankunft TEXT,
      position TEXT
    );
  `);
  console.log("✅ Tabellen überprüft/erstellt");
}
initTables();

// 🔑 Login
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "Gehlenborg" && password === "Orga1023/") {
    const token = jwt.sign({ username }, process.env.JWT_SECRET || "tourenplan", {
      expiresIn: "1h",
    });
    return res.json({ token });
  }
  return res.status(401).json({ error: "Falsche Zugangsdaten" });
});

// 👥 Fahrer abrufen
app.get("/fahrer", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
    res.json(result.rows);
  } catch (err) {
    console.error("Fehler beim Abrufen der Fahrer:", err);
    res.status(500).json({ error: "Fehler beim Abrufen der Fahrer" });
  }
});

// ➕ Fahrer hinzufügen
app.post("/fahrer", auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Name erforderlich" });

    const result = await pool.query("INSERT INTO fahrer (name) VALUES ($1) RETURNING *", [name]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Fehler beim Hinzufügen:", err);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
  }
});

// 🗑️ Einzelnen Fahrer löschen
app.delete("/fahrer/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM fahrer WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Fehler beim Löschen:", err);
    res.status(500).json({ error: "Fehler beim Löschen des Fahrers" });
  }
});

// ⚠️ Alle Fahrer löschen (inkl. Touren + Stopps, mit CASCADE)
app.delete("/fahrer-reset", auth, async (req, res) => {
  try {
    await pool.query("TRUNCATE stopps, touren, fahrer RESTART IDENTITY CASCADE;");
    res.json({ success: true, message: "Alle Fahrer inkl. Touren und Stopps gelöscht" });
  } catch (err) {
    console.error("Fehler beim Löschen aller Fahrer:", err);
    res.status(500).json({ error: "Fehler beim Löschen aller Fahrer" });
  }
});

// 🚚 Tour eines Fahrers abrufen
app.get("/touren/:fahrerId/:datum", auth, async (req, res) => {
  try {
    const { fahrerId, datum } = req.params;
    const tour = await pool.query("SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2", [
      fahrerId,
      datum,
    ]);

    if (tour.rows.length === 0)
      return res.json({ tour: null, stopps: [] });

    const stopps = await pool.query("SELECT * FROM stopps WHERE tour_id=$1 ORDER BY id ASC", [
      tour.rows[0].id,
    ]);
    res.json({ tour: tour.rows[0], stopps: stopps.rows });
  } catch (err) {
    console.error("Fehler beim Laden der Tour:", err);
    res.status(500).json({ error: "Fehler beim Laden der Tour" });
  }
});

// 🧾 Wochenübersicht
app.get("/touren-woche", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM touren ORDER BY datum DESC");
    res.json(result.rows);
  } catch (err) {
    console.error("Fehler beim Abrufen der Wochenübersicht:", err);
    res.status(500).json({ error: "Fehler beim Abrufen der Wochenübersicht" });
  }
});

// 🧹 Komplett-Reset aller Tabellen (Debug)
app.post("/reset", auth, async (req, res) => {
  try {
    await pool.query("TRUNCATE stopps, touren, fahrer RESTART IDENTITY CASCADE;");
    res.json({ success: true, message: "Datenbank vollständig geleert" });
  } catch (err) {
    console.error("Fehler beim Reset:", err);
    res.status(500).json({ error: "Fehler beim Reset der Datenbank" });
  }
});

// 🚀 Start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`);
});
