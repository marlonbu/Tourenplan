import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pkg from "pg";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(bodyParser.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const JWT_SECRET = process.env.JWT_SECRET || "geheim";
const upload = multer({ dest: "uploads/" });
const PORT = process.env.PORT || 10000;

// =============================
// Tabellen initialisieren
// =============================
async function initDB() {
  // Fahrer
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
  `);

  // Touren
  await pool.query(`
    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      fahrer_id INTEGER REFERENCES fahrer(id),
      datum DATE NOT NULL,
      UNIQUE (fahrer_id, datum)
    );
  `);

  // Stopps
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
      position INTEGER
    );
  `);

  // ✅ Sicherstellen, dass touren → fahrer ON DELETE CASCADE verwendet
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'touren_fahrer_id_fkey'
        AND table_name = 'touren'
      ) THEN
        ALTER TABLE touren DROP CONSTRAINT touren_fahrer_id_fkey;
      END IF;
    END $$;
  `);

  await pool.query(`
    ALTER TABLE touren
    ADD CONSTRAINT touren_fahrer_id_fkey
    FOREIGN KEY (fahrer_id)
    REFERENCES fahrer(id)
    ON DELETE CASCADE;
  `);

  console.log("✅ Tabellen überprüft/erstellt + Cascade aktiv");
}
initDB();

// =============================
// Authentifizierung
// =============================
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (username === "Gehlenborg" && password === "Orga1023/") {
    const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: "8h" });
    return res.json({ token });
  }
  return res.status(401).json({ error: "Ungültige Zugangsdaten" });
});

function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ error: "Kein Token übermittelt" });
  const token = authHeader.split(" ")[1];
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(403).json({ error: "Ungültiger oder abgelaufener Token" });
  }
}

// =============================
// Fahrer-Endpunkte
// =============================
app.get("/fahrer", auth, async (_req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Fehler beim Laden der Fahrer:", err);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

app.post("/fahrer", auth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name erforderlich" });
  try {
    const result = await pool.query(
      "INSERT INTO fahrer (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *",
      [name]
    );
    if (result.rows.length === 0)
      return res.json({ message: "Fahrer bereits vorhanden" });
    console.log(`✅ Fahrer hinzugefügt: ${name}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Fehler beim Hinzufügen:", err);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
  }
});

app.delete("/fahrer/:id", auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query("DELETE FROM fahrer WHERE id=$1", [id]);
    console.log(`🗑️ Fahrer gelöscht: ID ${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Fehler beim Löschen des Fahrers:", err);
    res.status(500).json({ error: "Fehler beim Löschen" });
  }
});

// =============================
// Touren / Planung
// =============================
app.post("/touren", auth, async (req, res) => {
  try {
    const { fahrer_id, datum } = req.body || {};
    if (!fahrer_id || !datum)
      return res.status(400).json({ error: "Fahrer und Datum erforderlich" });

    const r = await pool.query(
      `INSERT INTO touren (fahrer_id, datum)
       VALUES ($1, $2)
       ON CONFLICT (fahrer_id, datum)
       DO UPDATE SET datum = EXCLUDED.datum
       RETURNING *`,
      [Number(fahrer_id), datum]
    );

    console.log(`📅 Tour erstellt/bereitgestellt: Fahrer ${fahrer_id}, Datum ${datum}`);
    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ Fehler beim Anlegen der Tour:", e.message);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour", details: e.message });
  }
});

app.get("/touren/:fahrerId/:datum", auth, async (req, res) => {
  try {
    const fahrerId = Number(req.params.fahrerId);
    const datum = req.params.datum;

    const tour = await pool.query(
      "SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2",
      [fahrerId, datum]
    );

    if (tour.rows.length === 0) return res.json({ tour: null, stopps: [] });

    const stopps = await pool.query(
      "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position ASC, id ASC",
      [tour.rows[0].id]
    );

    res.json({ tour: tour.rows[0], stopps: stopps.rows });
  } catch (e) {
    console.error("❌ Fehler beim Laden der Tour:", e.message);
    res.status(500).json({ error: "Fehler beim Laden der Tour", details: e.message });
  }
});

// =============================
// Uploads / Fotos
// =============================
app.post("/upload", upload.single("foto"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Keine Datei erhalten" });
  res.json({ url: `/uploads/${req.file.filename}` });
});
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// =============================
// ⚠️ Manuelles Reset-Feature (optional)
// =============================
app.delete("/reset-db", async (_req, res) => {
  try {
    await pool.query("DELETE FROM stopps");
    await pool.query("DELETE FROM touren");
    await pool.query("DELETE FROM fahrer");
    res.json({ success: true, message: "Alle Tabellen geleert" });
    console.log("⚠️ Datenbank komplett zurückgesetzt");
  } catch (err) {
    console.error("❌ Fehler beim Reset:", err);
    res.status(500).json({ error: "Fehler beim Reset" });
  }
});

// =============================
// Serverstart
// =============================
app.listen(PORT, () =>
  console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`)
);
