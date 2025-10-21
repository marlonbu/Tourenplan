const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL-Verbindung
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Tabellen automatisch erstellen + neue Spalten hinzufügen
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fahrer (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fahrzeuge (
        id SERIAL PRIMARY KEY,
        typ TEXT,
        kennzeichen TEXT
      );

      CREATE TABLE IF NOT EXISTS touren (
        id SERIAL PRIMARY KEY,
        datum DATE NOT NULL,
        fahrzeug_id INT REFERENCES fahrzeuge(id),
        fahrer_id INT REFERENCES fahrer(id),
        startzeit TIME,
        bemerkung TEXT
      );

      CREATE TABLE IF NOT EXISTS stopps (
        id SERIAL PRIMARY KEY,
        tour_id INT REFERENCES touren(id),
        adresse TEXT,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        reihenfolge INT,
        erledigt BOOLEAN DEFAULT false,
        qr_code TEXT
      );

      CREATE TABLE IF NOT EXISTS dokumentation (
        id SERIAL PRIMARY KEY,
        stopp_id INT REFERENCES stopps(id),
        foto_url TEXT,
        kommentar TEXT,
        erstellt_am TIMESTAMP DEFAULT now()
      );
    `);

    // 🔑 Neue Spalten in stopps ergänzen, falls noch nicht vorhanden
    await pool.query(`
      ALTER TABLE stopps
        ADD COLUMN IF NOT EXISTS telefon TEXT,
        ADD COLUMN IF NOT EXISTS hinweis TEXT,
        ADD COLUMN IF NOT EXISTS status_text TEXT,
        ADD COLUMN IF NOT EXISTS foto_url TEXT;
    `);

    console.log("✅ Tabellen erfolgreich geprüft/erstellt + Spalten ergänzt");
  } catch (err) {
    console.error("❌ Fehler beim Initialisieren der Tabellen:", err);
  }
}

// Fahrer abrufen
app.get("/fahrer", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fahrer ORDER BY id");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

// Touren für Fahrer abrufen
app.get("/touren/:fahrer_id/:datum", async (req, res) => {
  const { fahrer_id, datum } = req.params;
  try {
    const result = await pool.query(
      `SELECT t.id as tour_id, s.id as stopp_id, s.adresse, s.reihenfolge, 
              s.lat, s.lng, s.erledigt, s.telefon, s.hinweis, s.status_text
       FROM touren t
       JOIN stopps s ON s.tour_id = t.id
       WHERE t.fahrer_id = $1 AND t.datum = $2
       ORDER BY s.reihenfolge`,
      [fahrer_id, datum]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Laden der Touren" });
  }
});

// QR-Code / Checkbox Umschalten erledigt ja/nein
app.post("/scan", async (req, res) => {
  const { stopp_id } = req.body;
  try {
    const result = await pool.query(
      "UPDATE stopps SET erledigt = NOT erledigt WHERE id = $1 RETURNING erledigt",
      [stopp_id]
    );
    res.json({ message: "Status geändert", erledigt: result.rows[0].erledigt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Umschalten des Status" });
  }
});

// Reset: Tabellen leeren
app.get("/reset", async (req, res) => {
  try {
    await pool.query("TRUNCATE dokumentation, stopps, touren, fahrzeuge, fahrer RESTART IDENTITY CASCADE");
    res.json({ message: "✅ Tabellen geleert" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Reset" });
  }
});

// Seed: Demo-Daten einfügen
app.get("/seed-demo", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fahrer
    const fahrerResult = await client.query(
      "INSERT INTO fahrer (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      ["Christoph Arlt"]
    );
    const fahrerId = fahrerResult.rows[0].id;

    // Fahrzeug
    const fahrzeugResult = await client.query(
      "INSERT INTO fahrzeuge (typ, kennzeichen) VALUES ($1, $2) RETURNING id",
      ["Sprinter", "CLP-HG 123"]
    );
    const fahrzeugId = fahrzeugResult.rows[0].id;

    // Tour
    const datum = new Date().toISOString().slice(0, 10);
    const tourResult = await client.query(
      "INSERT INTO touren (datum, fahrzeug_id, fahrer_id, startzeit, bemerkung) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [datum, fahrzeugId, fahrerId, "08:00", "Demo-Tour"]
    );
    const tourId = tourResult.rows[0].id;

    // Stopp
    await client.query(
      `INSERT INTO stopps (tour_id, adresse, lat, lng, reihenfolge, qr_code, telefon, hinweis, status_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        tourId,
        "Musterstraße 1, 12345 Musterstadt",
        52.52,
        13.405,
        1,
        "QR-DEMO-123",
        "01234-56789",
        "Beim Nachbarn klingeln",
        "offen"
      ]
    );

    await client.query("COMMIT");
    res.json({ message: "✅ Demo-Daten eingefügt" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Fehler beim Seed:", err);
    res.status(500).json({ error: "Fehler beim Seed", details: err.message });
  } finally {
    client.release();
  }
});

// Startseite
app.get("/", (req, res) => {
  res.send("🚚 Tourenplan API läuft – Tabellen + neue Spalten geprüft/erstellt ✅");
});

// Server starten
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`API läuft auf Port ${PORT}`);
  await initDb();
});
