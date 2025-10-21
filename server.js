const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL Verbindung
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Tabellen erstellen (mit UNIQUE constraints!)
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
        kennzeichen TEXT UNIQUE
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
    `);
    console.log("✅ Tabellen erfolgreich geprüft/erstellt");
  } catch (err) {
    console.error("❌ Fehler beim Initialisieren der Tabellen:", err);
  }
}

// Fahrer abrufen
app.get("/fahrer", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name FROM fahrer ORDER BY id");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

// Tourdaten für Fahrer+Datum abrufen
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

// Google Maps Link generieren
app.get("/touren/:fahrer_id/:datum/mapslink", async (req, res) => {
  const { fahrer_id, datum } = req.params;
  try {
    const result = await pool.query(
      `SELECT s.adresse
       FROM touren t
       JOIN stopps s ON s.tour_id = t.id
       WHERE t.fahrer_id = $1 AND t.datum = $2
       ORDER BY s.reihenfolge`,
      [fahrer_id, datum]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Keine Stopps für diese Tour gefunden" });
    }

    const stopps = result.rows.map(r => r.adresse);
    const origin = encodeURIComponent(stopps[0]);
    const destination = encodeURIComponent(stopps[stopps.length - 1]);
    const waypoints = stopps
      .slice(1, stopps.length - 1)
      .map(a => encodeURIComponent(a))
      .join("|");

    const mapsLink = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&waypoints=${waypoints}`;
    res.json({ mapsLink });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Erstellen des Maps-Links" });
  }
});

// SEED Demo-Daten
app.get("/seed-demo", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fahrer einfügen
    const fahrer = ["Christoph Arlt", "Hans Noll", "Johannes Backhaus", "Markus Honkomp"];
    const fahrerIds = [];
    for (let name of fahrer) {
      const r = await client.query(
        `INSERT INTO fahrer (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id`,
        [name]
      );
      if (r.rows[0]) fahrerIds.push(r.rows[0].id);
      else {
        const existing = await client.query(`SELECT id FROM fahrer WHERE name=$1`, [name]);
        fahrerIds.push(existing.rows[0].id);
      }
    }

    // Fahrzeug
    const fahrzeugResult = await client.query(
      `INSERT INTO fahrzeuge (typ, kennzeichen) VALUES ('Sprinter', 'CLP-HG 123')
       ON CONFLICT (kennzeichen) DO NOTHING RETURNING id`
    );
    const fahrzeugId = fahrzeugResult.rows[0]
      ? fahrzeugResult.rows[0].id
      : (await client.query(`SELECT id FROM fahrzeuge WHERE kennzeichen='CLP-HG 123'`)).rows[0].id;

    // Tour für morgen
    const morgen = new Date();
    morgen.setDate(morgen.getDate() + 1);
    const datum = morgen.toISOString().slice(0, 10);

    const tourResult = await client.query(
      `INSERT INTO touren (datum, fahrzeug_id, fahrer_id, startzeit, bemerkung)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [datum, fahrzeugId, fahrerIds[0], "08:00", "Demo-Tour für morgen"]
    );
    const tourId = tourResult.rows[0].id;

    // Stopps
    const stopps = [
      { adresse: "Bahnhofstraße 12, 49699 Lindern", lat: 52.85, lng: 7.77 },
      { adresse: "Industriestraße 8, 49661 Cloppenburg", lat: 52.85, lng: 8.05 },
      { adresse: "Bremer Straße 45, 26135 Oldenburg", lat: 53.13, lng: 8.23 },
      { adresse: "Am Markt 5, 26203 Wardenburg", lat: 53.05, lng: 8.20 }
    ];

    for (let i = 0; i < stopps.length; i++) {
      const s = stopps[i];
      await client.query(
        `INSERT INTO stopps (tour_id, adresse, lat, lng, reihenfolge, qr_code)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tourId, s.adresse, s.lat, s.lng, i + 1, `STOPP-${i + 1}`]
      );
    }

    await client.query("COMMIT");
    res.json({ message: "✅ Demo-Daten eingefügt", fahrerIds, tourId });
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
  res.send("🚚 Tourenplan API läuft – Tabellen geprüft ✅");
});

// Server starten
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`API läuft auf Port ${PORT}`);
  await initDb();
});
