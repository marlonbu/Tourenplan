const express = require("express");
const { Pool } = require("pg");
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
    console.log("✅ Tabellen erfolgreich geprüft/erstellt");
  } catch (err) {
    console.error("❌ Fehler beim Initialisieren der Tabellen:", err);
  }
}

// Fahrer abrufen
app.get("/fahrer", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fahrer ORDER BY name");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

// Touren für Fahrer und Datum abrufen
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

// Stopps pro Tour abrufen
app.get("/stopps/:tour_id", async (req, res) => {
  const { tour_id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM stopps WHERE tour_id = $1 ORDER BY reihenfolge", [tour_id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Laden der Stopps" });
  }
});

// ✅ Seed-Endpunkt mit fester Demo-Tour für 22.10.2025
app.get("/seed-demo", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fahrer einfügen (nur wenn nicht vorhanden)
    const fahrerResult = await client.query(
      `INSERT INTO fahrer (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      ["Christoph Arlt"]
    );
    const fahrerId = fahrerResult.rows[0].id;

    // Fahrzeug einfügen (nur wenn nicht vorhanden)
    const fahrzeugResult = await client.query(
      `INSERT INTO fahrzeuge (typ, kennzeichen) VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      ["Sprinter", "CLP-CA 123"]
    );
    const fahrzeugId =
      fahrzeugResult.rows.length > 0
        ? fahrzeugResult.rows[0].id
        : (await client.query("SELECT id FROM fahrzeuge WHERE kennzeichen=$1", ["CLP-CA 123"])).rows[0].id;

    // Tour für den 22.10.2025
    const tourResult = await client.query(
      `INSERT INTO touren (datum, fahrzeug_id, fahrer_id, startzeit, bemerkung)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      ["2025-10-22", fahrzeugId, fahrerId, "08:00", "Demo-Tour Oldenburg"]
    );

    let tourId;
    if (tourResult.rows.length > 0) {
      tourId = tourResult.rows[0].id;
    } else {
      const existing = await client.query(
        "SELECT id FROM touren WHERE datum=$1 AND fahrer_id=$2",
        ["2025-10-22", fahrerId]
      );
      tourId = existing.rows[0].id;
    }

    // Stopps (4 Stationen zwischen Lindern und Oldenburg)
    const stopps = [
      { adresse: "Lindern, Hauptstraße 10", lat: 52.835, lng: 7.771 },
      { adresse: "Lastrup, Kirchplatz 5", lat: 52.783, lng: 7.867 },
      { adresse: "Cloppenburg, Bahnhofstraße 20", lat: 52.844, lng: 8.045 },
      { adresse: "Oldenburg, Lange Straße 30", lat: 53.143, lng: 8.214 }
    ];

    for (let i = 0; i < stopps.length; i++) {
      await client.query(
        `INSERT INTO stopps (tour_id, adresse, lat, lng, reihenfolge, qr_code)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [tourId, stopps[i].adresse, stopps[i].lat, stopps[i].lng, i + 1, `QR-${i + 1}`]
      );
    }

    await client.query("COMMIT");
    res.json({ message: "✅ Demo-Tour erfolgreich erstellt", tourId, fahrerId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Fehler beim Seed-Demo:", err);
    res.status(500).json({ error: "Fehler beim Seed-Demo", details: err.message });
  } finally {
    client.release();
  }
});

// Startseite
app.get("/", (req, res) => {
  res.send("🚚 Tourenplan API läuft – Tabellen wurden geprüft/erstellt ✅");
});

// Server starten
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`API läuft auf Port ${PORT}`);
  await initDb();
});
