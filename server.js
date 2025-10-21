const express = require("express");
const { Pool } = require("pg");
const multer = require("multer");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL-Verbindung
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Tabellen automatisch erstellen
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fahrer (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
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
    console.log("✅ Tabellen erfolgreich geprüft/erstellt");
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
              s.lat, s.lng, s.erledigt, s.qr_code
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

// ✅ Toggle erledigt-Status
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
    res.status(500).json({ error: "Fehler beim Umschalten" });
  }
});

// Reset und Seed-Demo
app.get("/reset", async (req, res) => {
  try {
    await pool.query("TRUNCATE dokumentation, stopps, touren, fahrzeuge, fahrer RESTART IDENTITY CASCADE");
    res.json({ message: "✅ Alle Daten gelöscht" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Reset" });
  }
});

app.get("/seed-demo", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const fahrer = await client.query(
      "INSERT INTO fahrer (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id",
      ["Christoph Arlt"]
    );
    const fahrerId = fahrer.rows[0]?.id || 1;

    const fahrzeug = await client.query(
      "INSERT INTO fahrzeuge (typ, kennzeichen) VALUES ($1, $2) RETURNING id",
      ["Sprinter", "CLP-HG 123"]
    );
    const fahrzeugId = fahrzeug.rows[0].id;

    const datum = new Date().toISOString().slice(0, 10);
    const tour = await client.query(
      "INSERT INTO touren (datum, fahrzeug_id, fahrer_id, startzeit, bemerkung) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [datum, fahrzeugId, fahrerId, "08:00", "Demo-Tour"]
    );
    const tourId = tour.rows[0].id;

    await client.query(
      "INSERT INTO stopps (tour_id, adresse, lat, lng, reihenfolge, qr_code) VALUES ($1,$2,$3,$4,$5,$6)",
      [tourId, "Musterstraße 1, 12345 Musterstadt", 52.52, 13.405, 1, "QR-001"]
    );
    await client.query(
      "INSERT INTO stopps (tour_id, adresse, lat, lng, reihenfolge, qr_code) VALUES ($1,$2,$3,$4,$5,$6)",
      [tourId, "Beispielallee 10, 26122 Oldenburg", 53.14, 8.21, 2, "QR-002"]
    );

    await client.query("COMMIT");
    res.json({ message: "✅ Demodaten eingefügt" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Fehler beim Seed:", err);
    res.status(500).json({ error: "Fehler beim Einfügen der Demodaten" });
  } finally {
    client.release();
  }
});

// Startseite
app.get("/", (req, res) => {
  res.send("🚚 Tourenplan API läuft – Tabellen geprüft/erstellt ✅");
});

// Server starten
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`API läuft auf Port ${PORT}`);
  await initDb();
});
