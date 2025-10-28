// =========================
// Tourenplan Backend Server
// =========================

import express from "express";
import cors from "cors";
import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 10000;

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

// ===== POSTGRES VERBINDUNG =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ===== EINFACHE AUTH =====
// Akzeptiert jeden Token (z. B. "Bearer Gehlenborg")
function auth(req, res, next) {
  const header = req.headers["authorization"];
  if (!header) return res.status(401).json({ error: "Kein Token vorhanden" });

  const token = header.split(" ")[1];
  if (!token || token.trim() === "") {
    return res.status(401).json({ error: "Ungültiger Token" });
  }

  req.user = { name: token };
  next();
}

// ===== TABELLEN ANLEGEN =====
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fahrer (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS touren (
        id SERIAL PRIMARY KEY,
        fahrer_id INTEGER REFERENCES fahrer(id) ON DELETE CASCADE,
        datum DATE NOT NULL,
        stopps JSONB DEFAULT '[]'
      );
    `);

    console.log("✅ Tabellen überprüft/erstellt");
  } catch (err) {
    console.error("❌ Fehler beim Initialisieren der DB:", err);
  }
}
initDB();

// =========================
// ===== LOGIN (FAKE) ======
// =========================
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  // Simpler Login für interne Nutzung
  if (username === "Gehlenborg" && password === "Orga1023/") {
    return res.json({ token: "Gehlenborg" });
  }

  return res.status(401).json({ error: "Ungültige Zugangsdaten" });
});

// =========================
// ===== FAHRER ROUTEN =====
// =========================

// Alle Fahrer abrufen
app.get("/fahrer", auth, async (_req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Fehler beim Laden der Fahrer:", err);
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
    console.error("❌ Fehler beim Hinzufügen:", err);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
  }
});

// Fahrer löschen
app.delete("/fahrer/:id", auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await pool.query("DELETE FROM fahrer WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Fehler beim Löschen des Fahrers:", err);
    res.status(500).json({ error: "Fehler beim Löschen" });
  }
});

// ⚠️ TEMPORÄR: ALLE FAHRER LÖSCHEN (manuell aufrufbar)
app.delete("/fahrer", async (_req, res) => {
  try {
    await pool.query("DELETE FROM fahrer");
    console.log("⚠️ Alle Fahrer aus der Datenbank gelöscht!");
    res.json({ success: true, message: "Alle Fahrer gelöscht" });
  } catch (err) {
    console.error("❌ Fehler beim Löschen aller Fahrer:", err);
    res.status(500).json({ error: "Fehler beim Löschen aller Fahrer" });
  }
});

// =========================
// ===== TOUREN ROUTEN =====
// =========================

// Touren abrufen
app.get("/touren", auth, async (_req, res) => {
  try {
    const result = await pool.query("SELECT * FROM touren ORDER BY datum DESC");
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Fehler beim Laden der Touren:", err);
    res.status(500).json({ error: "Fehler beim Laden der Touren" });
  }
});

// Tour hinzufügen
app.post("/touren", auth, async (req, res) => {
  const { fahrer_id, datum, stopps } = req.body;
  if (!fahrer_id || !datum)
    return res.status(400).json({ error: "Fahrer und Datum erforderlich" });

  try {
    const result = await pool.query(
      "INSERT INTO touren (fahrer_id, datum, stopps) VALUES ($1, $2, $3) RETURNING *",
      [fahrer_id, datum, stopps || []]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Fehler beim Anlegen der Tour:", err);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour" });
  }
});

// =========================
// ===== SERVER START ======
// =========================
app.listen(PORT, () =>
  console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`)
);
