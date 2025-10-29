import express from "express";
import cors from "cors";
import pkg from "pg";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// 🧠 PostgreSQL-Verbindung
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// 🔐 Auth-Middleware
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Kein Token" });
  try {
    jwt.verify(token, process.env.JWT_SECRET || "orga_secret");
    next();
  } catch {
    res.status(401).json({ error: "Ungültiger Token" });
  }
};

// 🧩 Tabellen-Erstellung mit ON DELETE CASCADE
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      fahrer_id INTEGER REFERENCES fahrer(id) ON DELETE CASCADE,
      datum DATE NOT NULL,
      stopps JSONB DEFAULT '[]'
    );
  `);
  console.log("✅ Tabellen überprüft/erstellt + Cascade aktiv");
})();

// ===== LOGIN =====
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (username === "Gehlenborg" && password === "Orga1023/") {
    const token = jwt.sign({ user: username }, process.env.JWT_SECRET || "orga_secret", {
      expiresIn: "12h",
    });
    return res.json({ token });
  }
  res.status(401).json({ error: "Ungültige Anmeldedaten" });
});

// ===== FAHRER =====
app.get("/fahrer", auth, async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

app.post("/fahrer", auth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name erforderlich" });
  try {
    const result = await pool.query("INSERT INTO fahrer (name) VALUES ($1) RETURNING *", [name]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Fehler beim Hinzufügen:", err);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
  }
});

app.delete("/fahrer/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM fahrer WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Fehler beim Löschen:", err);
    res.status(500).json({ error: "Fehler beim Löschen des Fahrers" });
  }
});

// ===== ALLE Fahrer löschen (Admin Reset)
app.delete("/fahrer", auth, async (_req, res) => {
  try {
    await pool.query("DELETE FROM fahrer");
    res.json({ success: true });
  } catch (err) {
    console.error("Fehler beim Löschen aller Fahrer:", err);
    res.status(500).json({ error: "Fehler beim Löschen aller Fahrer" });
  }
});

// ===== TOUREN =====
app.post("/touren", auth, async (req, res) => {
  try {
    const { fahrer_id, datum, stopps = [] } = req.body;

    if (!fahrer_id || !datum) {
      return res.status(400).json({ error: "Fahrer und Datum erforderlich" });
    }

    const result = await pool.query(
      "INSERT INTO touren (fahrer_id, datum, stopps) VALUES ($1, $2::date, $3::jsonb) RETURNING *",
      [fahrer_id, datum, JSON.stringify(stopps)]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Fehler beim Anlegen der Tour:", err);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour" });
  }
});

app.get("/touren/:fahrer_id/:datum", auth, async (req, res) => {
  try {
    const { fahrer_id, datum } = req.params;
    const result = await pool.query(
      "SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2::date",
      [fahrer_id, datum]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Fehler beim Laden der Tour:", err);
    res.status(500).json({ error: "Fehler beim Laden der Tour" });
  }
});

// ===== TOUR-LISTE (Gesamtübersicht)
app.post("/touren-gesamt", auth, async (req, res) => {
  try {
    const { fahrerId, from, to } = req.body;
    let query = "SELECT * FROM touren WHERE 1=1";
    const params = [];

    if (fahrerId) {
      params.push(fahrerId);
      query += ` AND fahrer_id=$${params.length}`;
    }
    if (from) {
      params.push(from);
      query += ` AND datum >= $${params.length}::date`;
    }
    if (to) {
      params.push(to);
      query += ` AND datum <= $${params.length}::date`;
    }

    query += " ORDER BY datum DESC";
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Fehler /touren-gesamt:", err);
    res.status(500).json({ error: "Fehler beim Laden der Tourübersicht" });
  }
});

// ===== START
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`));
