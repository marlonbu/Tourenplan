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

// 🗄️ PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 🔐 Auth
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Kein Token" });
  try {
    jwt.verify(token, process.env.JWT_SECRET || "tourenplan");
    next();
  } catch {
    return res.status(403).json({ error: "Ungültiger Token" });
  }
}

// 🧱 Tabellen
async function initTables() {
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
      datum DATE NOT NULL,
      UNIQUE (fahrer_id, datum)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stopps (
      id SERIAL PRIMARY KEY,
      tour_id INTEGER NOT NULL REFERENCES touren(id) ON DELETE CASCADE,
      kunde TEXT,
      adresse TEXT,
      kommission TEXT,
      hinweis TEXT,
      telefon TEXT,
      status TEXT,
      foto_url TEXT,
      ankunft TIME,
      position INTEGER DEFAULT 0
    );
  `);
  console.log("✅ Tabellen überprüft/erstellt");
}
initTables();

// 🔑 Login (ein gemeinsamer Account wie besprochen)
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "Gehlenborg" && password === "Orga1023/") {
    const token = jwt.sign({ username }, process.env.JWT_SECRET || "tourenplan", { expiresIn: "8h" });
    return res.json({ token });
  }
  return res.status(401).json({ error: "Falsche Zugangsdaten" });
});

//
// ===== Fahrer =====
//
app.get("/fahrer", auth, async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Abrufen der Fahrer" });
  }
});

app.post("/fahrer", auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Name erforderlich" });
    const r = await pool.query("INSERT INTO fahrer (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING *", [name.trim()]);
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
  }
});

app.delete("/fahrer/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM fahrer WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Löschen des Fahrers" });
  }
});

// Admin-Reset (alles leer)
app.delete("/fahrer-reset", auth, async (_req, res) => {
  try {
    await pool.query("TRUNCATE stopps, touren, fahrer RESTART IDENTITY CASCADE;");
    res.json({ success: true, message: "Alle Fahrer inkl. Touren und Stopps gelöscht" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Löschen aller Fahrer" });
  }
});

//
// ===== Touren & Stopps (Planung) =====
//

// Tour abrufen (bestehender Endpunkt)
app.get("/touren/:fahrerId/:datum", auth, async (req, res) => {
  try {
    const { fahrerId, datum } = req.params; // datum: YYYY-MM-DD
    const t = await pool.query("SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2", [fahrerId, datum]);
    if (t.rows.length === 0) return res.json({ tour: null, stopps: [] });

    const s = await pool.query("SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position ASC, id ASC", [t.rows[0].id]);
    res.json({ tour: t.rows[0], stopps: s.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Laden der Tour" });
  }
});

// Tour anlegen (oder bestehende zurückgeben)
app.post("/touren", auth, async (req, res) => {
  try {
    const { fahrerId, datum } = req.body; // datum: YYYY-MM-DD
    if (!fahrerId || !datum) return res.status(400).json({ error: "fahrerId und datum erforderlich" });

    const r = await pool.query(
      "INSERT INTO touren (fahrer_id, datum) VALUES ($1,$2) ON CONFLICT (fahrer_id, datum) DO UPDATE SET datum=EXCLUDED.datum RETURNING *",
      [fahrerId, datum]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour" });
  }
});

// Stopps einer Tour abrufen
app.get("/touren/:tourId/stopps", auth, async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position ASC, id ASC", [req.params.tourId]);
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Laden der Stopps" });
  }
});

// Stopp hinzufügen
app.post("/touren/:tourId/stopps", auth, async (req, res) => {
  try {
    const tourId = req.params.tourId;
    const {
      kunde = "",
      adresse = "",
      kommission = "",
      hinweis = "",
      telefon = "",
      status = "",
      ankunft = null,
      position = 0,
    } = req.body;

    if (!adresse?.trim() || !kunde?.trim()) return res.status(400).json({ error: "Kunde und Adresse erforderlich" });

    const r = await pool.query(
      `INSERT INTO stopps (tour_id, kunde, adresse, kommission, hinweis, telefon, status, ankunft, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [tourId, kunde.trim(), adresse.trim(), kommission.trim(), hinweis.trim(), telefon.trim(), status.trim(), ankunft, position ?? 0]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Stopps" });
  }
});

// Stopp bearbeiten
app.put("/stopps/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const {
      kunde, adresse, kommission, hinweis, telefon, status, ankunft, position,
    } = req.body;

    const r = await pool.query(
      `UPDATE stopps
         SET kunde = COALESCE($1, kunde),
             adresse = COALESCE($2, adresse),
             kommission = COALESCE($3, kommission),
             hinweis = COALESCE($4, hinweis),
             telefon = COALESCE($5, telefon),
             status  = COALESCE($6, status),
             ankunft = COALESCE($7, ankunft),
             position= COALESCE($8, position)
       WHERE id=$9
       RETURNING *`,
      [kunde, adresse, kommission, hinweis, telefon, status, ankunft, position, id]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Aktualisieren des Stopps" });
  }
});

// Stopp löschen
app.delete("/stopps/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM stopps WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Löschen des Stopps" });
  }
});

//
// ===== Wochenübersicht / Reset (bleibt) =====
//
app.get("/touren-woche", auth, async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM touren ORDER BY datum DESC");
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Abrufen der Wochenübersicht" });
  }
});

app.post("/reset", auth, async (_req, res) => {
  try {
    await pool.query("TRUNCATE stopps, touren, fahrer RESTART IDENTITY CASCADE;");
    res.json({ success: true, message: "Datenbank vollständig geleert" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Reset der Datenbank" });
  }
});

// 🚀 Start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`));
