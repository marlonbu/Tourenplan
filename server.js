import express from "express";
import pkg from "pg";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

// ======== Auth Middleware ========
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "Kein Token" });
  const token = header.split(" ")[1];
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Ungültiger Token" });
  }
}

// ======== Initialisierung Tabellen ========
async function initTables() {
  try {
    // Fahrer
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fahrer (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);

    // Touren
    await pool.query(`
      CREATE TABLE IF NOT EXISTS touren (
        id SERIAL PRIMARY KEY,
        fahrer_id INTEGER REFERENCES fahrer(id) ON DELETE CASCADE,
        datum DATE NOT NULL
      );
    `);

    // Stopps
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stopps (
        id SERIAL PRIMARY KEY,
        tour_id INTEGER REFERENCES touren(id) ON DELETE CASCADE,
        kunde TEXT,
        adresse TEXT,
        telefon TEXT,
        position INTEGER,
        hinweis TEXT
      );
    `);

    // Fahrer automatisch einfügen, wenn leer
    const existing = await pool.query("SELECT COUNT(*) FROM fahrer");
    if (parseInt(existing.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO fahrer (name) VALUES
        ('Christoph Arlt'),
        ('Johannes Backhaus'),
        ('Hans Noll'),
        ('Markus Honkomp');
      `);
      console.log("✅ Fahrer automatisch hinzugefügt");
    }

    console.log("✅ Tabellen überprüft/erstellt");
  } catch (err) {
    console.error("❌ Fehler bei Tabelleninitialisierung:", err);
  }
}

// ===== Login =====
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (username === "Gehlenborg" && password === "Orga1023/") {
    const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token });
  }
  res.status(401).json({ error: "Login fehlgeschlagen" });
});

// ===== Fahrer =====

// Alle Fahrer abrufen
app.get("/fahrer", auth, async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
    res.json(r.rows);
  } catch (e) {
    console.error("Fehler beim Laden der Fahrer:", e);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

// Fahrer hinzufügen
app.post("/fahrer", auth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name erforderlich" });
  try {
    const result = await pool.query(
      "INSERT INTO fahrer (name) VALUES ($1) RETURNING *",
      [name]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Fehler beim Hinzufügen:", err);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
  }
});

// Fahrer löschen
app.delete("/fahrer/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM fahrer WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Fehler beim Löschen des Fahrers:", err);
    res.status(500).json({ error: "Fehler beim Löschen des Fahrers" });
  }
});

// ===== Touren =====

// Tour anlegen
app.post("/touren", auth, async (req, res) => {
  const { fahrerId, datum } = req.body;
  if (!fahrerId || !datum) return res.status(400).json({ error: "Daten fehlen" });

  try {
    const result = await pool.query(
      `INSERT INTO touren (fahrer_id, datum)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [fahrerId, datum]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    console.error("Fehler beim Anlegen der Tour:", err);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour" });
  }
});

// Stopps einer Tour abrufen
app.get("/touren/:id/stopps", auth, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM stopps WHERE tour_id = $1 ORDER BY position ASC",
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error("Fehler beim Laden der Stopps:", err);
    res.status(500).json({ error: "Fehler beim Laden der Stopps" });
  }
});

// Stopp hinzufügen
app.post("/stopps", auth, async (req, res) => {
  const { tourId, kunde, adresse, telefon, position, hinweis } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO stopps (tour_id, kunde, adresse, telefon, position, hinweis)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [tourId, kunde, adresse, telefon, position, hinweis]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Fehler beim Hinzufügen des Stopps:", err);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Stopps" });
  }
});

// Server starten
app.listen(PORT, async () => {
  await initTables();
  console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`);
});
