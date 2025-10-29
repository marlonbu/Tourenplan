import express from "express";
import cors from "cors";
import pkg from "pg";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bodyParser from "body-parser";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

// ---- DB ----------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

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
      fahrer_id INTEGER NOT NULL REFERENCES fahrer(id),
      datum DATE NOT NULL,
      UNIQUE (fahrer_id, datum)
    );
  `);

  // Stopps (separate Tabelle, optional genutzt)
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
      ankunft TEXT,
      position INTEGER
    );
  `);

  // Sicherstellen: touren.fahrer_id → ON DELETE CASCADE
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
    FOREIGN KEY (fahrer_id) REFERENCES fahrer(id) ON DELETE CASCADE;
  `);

  console.log("✅ Tabellen überprüft/erstellt + Cascade aktiv");
}
initDB().catch((e) => {
  console.error("❌ initDB Fehler:", e);
});

// ---- Auth --------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || "orga_secret";

function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    console.warn("⚠️ Kein Authorization-Header");
    return res.status(401).json({ error: "Kein Token" });
  }
  const token = authHeader.split(" ")[1];
  try {
    jwt.verify(token, JWT_SECRET);
    return next();
  } catch (e) {
    console.warn("⚠️ Ungültiger Token:", e?.message);
    return res.status(401).json({ error: "Ungültiger Token" });
  }
}

app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (username === "Gehlenborg" && password === "Orga1023/") {
    const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: "12h" });
    return res.json({ token });
  }
  return res.status(401).json({ error: "Ungültige Anmeldedaten" });
});

// ---- Fahrer ------------------------------------------------
app.get("/fahrer", auth, async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
    res.json(r.rows);
  } catch (e) {
    console.error("❌ Fehler beim Laden der Fahrer:", e);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

app.post("/fahrer", auth, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "Name erforderlich" });

    const r = await pool.query(
      "INSERT INTO fahrer (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *",
      [name.trim()]
    );
    if (r.rows.length === 0) return res.json({ message: "Fahrer bereits vorhanden" });
    console.log("✅ Fahrer hinzugefügt:", r.rows[0]);
    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ Fehler beim Hinzufügen des Fahrers:", e);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
  }
});

app.delete("/fahrer/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query("DELETE FROM fahrer WHERE id=$1", [id]);
    console.log("🗑️ Fahrer gelöscht:", id);
    res.json({ success: true });
  } catch (e) {
    console.error("❌ Fehler beim Löschen des Fahrers:", e);
    res.status(500).json({ error: "Fehler beim Löschen des Fahrers" });
  }
});

// 👉 Seed-Route zum schnellen Wiederbefüllen (auth-pflichtig)
app.post("/fahrer/seed", auth, async (req, res) => {
  try {
    const { namen } = req.body || {};
    const list = Array.isArray(namen) ? namen : [];
    if (list.length === 0) {
      return res.status(400).json({ error: "namen: [] erforderlich" });
    }

    const values = list.map((n) => `('${n.replace(/'/g, "''")}')`).join(",");
    const sql =
      "INSERT INTO fahrer (name) VALUES " +
      values +
      " ON CONFLICT (name) DO NOTHING RETURNING *";
    const r = await pool.query(sql);
    console.log(`✅ Fahrer-Seed: ${r.rows.length} neu hinzugefügt`);
    res.json({ added: r.rows.length, rows: r.rows });
  } catch (e) {
    console.error("❌ Seed-Fehler:", e);
    res.status(500).json({ error: "Fehler beim Seed" });
  }
});

// ---- Touren ------------------------------------------------
// Anlegen/Upsert
app.post("/touren", auth, async (req, res) => {
  try {
    const { fahrer_id, datum } = req.body || {};
    if (!fahrer_id || !datum)
      return res.status(400).json({ error: "Fahrer und Datum erforderlich" });

    // Existiert?
    const exists = await pool.query(
      "SELECT id FROM touren WHERE fahrer_id=$1 AND datum=$2::date",
      [Number(fahrer_id), datum]
    );

    let r;
    if (exists.rows.length > 0) {
      r = await pool.query(
        "UPDATE touren SET datum=$2::date WHERE fahrer_id=$1 AND datum=$2::date RETURNING *",
        [Number(fahrer_id), datum]
      );
    } else {
      r = await pool.query(
        "INSERT INTO touren (fahrer_id, datum) VALUES ($1, $2::date) RETURNING *",
        [Number(fahrer_id), datum]
      );
    }

    console.log("📅 Tour bereitgestellt:", r.rows[0]);
    res.json(r.rows[0]);
  } catch (e) {
    console.error("❌ Fehler beim Anlegen der Tour:", e);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour" });
  }
});

// Laden (inkl. Stopps)
app.get("/touren/:fahrerId/:datum", auth, async (req, res) => {
  try {
    const fahrerId = Number(req.params.fahrerId);
    const datum = req.params.datum;

    const tour = await pool.query(
      "SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2::date",
      [fahrerId, datum]
    );
    if (tour.rows.length === 0) return res.json({ tour: null, stopps: [] });

    const stopps = await pool.query(
      "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position ASC, id ASC",
      [tour.rows[0].id]
    );
    res.json({ tour: tour.rows[0], stopps: stopps.rows });
  } catch (e) {
    console.error("❌ Fehler beim Laden der Tour:", e);
    res.status(500).json({ error: "Fehler beim Laden der Tour" });
  }
});

// ---- Start -------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`));
