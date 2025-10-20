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
        name TEXT NOT NULL
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

/* ===========================
   📌 API ENDPOINTS
=========================== */

// Fahrer-Liste
app.get("/fahrer", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name FROM fahrer ORDER BY id");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

// Fahrer hinzufügen
app.post("/fahrer/add", async (req, res) => {
  const { name } = req.body;

  if (!name || name.trim() === "") {
    return res.status(400).json({ error: "Fahrername ist erforderlich" });
  }

  try {
    // Prüfen, ob Fahrer schon existiert
    const check = await pool.query("SELECT id FROM fahrer WHERE name = $1", [name.trim()]);
    if (check.rows.length > 0) {
      return res.json({ message: "⚠️ Fahrer existiert bereits", name });
    }

    const result = await pool.query(
      "INSERT INTO fahrer (name) VALUES ($1) RETURNING id, name",
      [name.trim()]
    );

    res.json({ message: "✅ Fahrer hinzugefügt", fahrer: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
  }
});

// Fahrzeuge-Liste
app.get("/fahrzeuge", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, typ, kennzeichen FROM fahrzeuge ORDER BY id");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Laden der Fahrzeuge" });
  }
});

// Touren eines Fahrers für bestimmtes Datum
app.get("/touren/:fahrer_id/:datum", async (req, res) => {
  const { fahrer_id, datum } = req.params;
  try {
    const result = await pool.query(
      `SELECT t.id as tour_id, s.id as stopp_id, s.adresse, s.reihenfolge, s.lat, s.lng, s.erledigt
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

// QR-Code Check-in (Stopp erledigen)
app.post("/scan", async (req, res) => {
  const { stopp_id } = req.body;
  try {
    await pool.query("UPDATE stopps SET erledigt = true WHERE id = $1", [stopp_id]);
    res.json({ message: "Stopp bestätigt" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim QR-Scan" });
  }
});

// Datei-Upload (Dummy-Version)
const upload = multer({ dest: "uploads/" });
app.post("/upload/:stopp_id", upload.single("foto"), async (req, res) => {
  const stopp_id = req.params.stopp_id;
  const url = `/uploads/${req.file.filename}`;
  try {
    await pool.query(
      "INSERT INTO dokumentation (stopp_id, foto_url) VALUES ($1, $2)",
      [stopp_id, url]
    );
    res.json({ message: "Foto gespeichert", url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Foto-Upload" });
  }
});

// ALLE Daten ausgeben (Debug)
app.get("/all", async (req, res) => {
  try {
    const fahrer = await pool.query("SELECT * FROM fahrer");
    const fahrzeuge = await pool.query("SELECT * FROM fahrzeuge");
    const touren = await pool.query("SELECT * FROM touren");
    const stopps = await pool.query("SELECT * FROM stopps");

    res.json({
      fahrer: fahrer.rows,
      fahrzeuge: fahrzeuge.rows,
      touren: touren.rows,
      stopps: stopps.rows
    });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Abrufen aller Daten" });
  }
});

// Reset-Endpunkt (alle Daten löschen)
app.get("/reset", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query("TRUNCATE dokumentation RESTART IDENTITY CASCADE");
    await client.query("TRUNCATE stopps RESTART IDENTITY CASCADE");
    await client.query("TRUNCATE touren RESTART IDENTITY CASCADE");
    await client.query("TRUNCATE fahrzeuge RESTART IDENTITY CASCADE");
    await client.query("TRUNCATE fahrer RESTART IDENTITY CASCADE");

    await client.query("COMMIT");
    res.json({ message: "🗑️ Alle Daten wurden erfolgreich gelöscht" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Fehler beim Reset:", err);
    res.status(500).json({ error: "Fehler beim Zurücksetzen der Daten", details: err.message });
  } finally {
    client.release();
  }
});

// Seed-Endpunkt (Fahrer ohne Duplikate einfügen + Demo-Tour)
app.get("/seed", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const fahrerNamen = [
      "Christoph Arlt",
      "Hans Noll",
      "Johannes Backhaus",
      "Markus Honkomp"
    ];

    const fahrerIds = [];
    for (const name of fahrerNamen) {
      const check = await client.query(
        "SELECT id FROM fahrer WHERE name = $1",
        [name]
      );

      if (check.rows.length === 0) {
        const insert = await client.query(
          "INSERT INTO fahrer (name) VALUES ($1) RETURNING id",
          [name]
        );
        fahrerIds.push(insert.rows[0].id);
      } else {
        fahrerIds.push(check.rows[0].id);
      }
    }

    const fahrzeugResult = await client.query(
      "INSERT INTO fahrzeuge (typ, kennzeichen) VALUES ($1, $2) RETURNING id",
      ["Sprinter", "CLP-HG 123"]
    );
    const fahrzeugId = fahrzeugResult.rows[0].id;

    const heute = new Date().toISOString().slice(0, 10);
    const tourResult = await client.query(
      "INSERT INTO touren (datum, fahrzeug_id, fahrer_id, startzeit, bemerkung) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [heute, fahrzeugId, fahrerIds[0], "08:00", "Kundentour"]
    );
    const tourId = tourResult.rows[0].id;

    await client.query(
      "INSERT INTO stopps (tour_id, adresse, lat, lng, reihenfolge, qr_code) VALUES ($1, $2, $3, $4, $5, $6)",
      [tourId, "Musterstraße 1, 12345 Musterstadt", 52.52, 13.405, 1, "QR-DEMO-123"]
    );

    await client.query("COMMIT");

    res.json({
      message: "✅ Fahrer & Demodaten eingefügt (ohne Duplikate)",
      fahrerIds,
      fahrzeugId,
      tourId
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Fehler beim Seed:", err);
    res.status(500).json({ error: "Fehler beim Seed", details: err.message });
  } finally {
    client.release();
  }
});

// Root-Seite
app.get("/", (req, res) => {
  res.send("🚚 Tourenplan API läuft – Tabellen wurden geprüft/erstellt ✅");
});

// Server starten
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`API läuft auf Port ${PORT}`);
  await initDb();
});
