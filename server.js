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

      CREATE TABLE IF NOT EXISTS stoppdetails (
        id SERIAL PRIMARY KEY,
        stopp_id INT REFERENCES stopps(id),
        ankunftszeit TIME,
        kunde TEXT,
        kommission TEXT,
        kundenadresse TEXT,
        anmerkung TEXT
      );
    `);
    console.log("✅ Tabellen erfolgreich geprüft/erstellt");
  } catch (err) {
    console.error("❌ Fehler beim Initialisieren der Tabellen:", err);
  }
}

// ------------------------------------------
// Routen
// ------------------------------------------

// Alle Daten ausgeben
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
    res.status(500).json({ error: "Fehler bei /all", details: err.message });
  }
});

// Alle Fahrer abrufen
app.get("/fahrer", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fahrer ORDER BY id ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

// Alle Fahrzeuge abrufen
app.get("/fahrzeuge", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fahrzeuge ORDER BY id ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden der Fahrzeuge" });
  }
});

// Touren für Fahrer abrufen
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
    res.status(500).json({ error: "Fehler beim Laden der Touren" });
  }
});

// Google Maps Link für Tour generieren
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
    console.error("❌ Fehler beim Generieren des Maps-Links:", err);
    res.status(500).json({ error: "Fehler beim Erstellen des Maps-Links" });
  }
});

// QR-Code Check-in
app.post("/scan", async (req, res) => {
  const { stopp_id } = req.body;
  try {
    await pool.query("UPDATE stopps SET erledigt = true WHERE id = $1", [stopp_id]);
    res.json({ message: "Stopp bestätigt" });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim QR-Scan" });
  }
});

// Datei-Upload Dummy
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
    res.status(500).json({ error: "Fehler beim Foto-Upload" });
  }
});

// Demo Seed
app.get("/seed-demo", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fahrer
    const fahrerNamen = ["Christoph Arlt", "Hans Noll", "Johannes Backhaus", "Markus Honkomp"];
    let fahrerIds = [];
    for (const name of fahrerNamen) {
      const result = await client.query(
        "INSERT INTO fahrer (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        [name]
      );
      fahrerIds.push(result.rows[0].id);
    }

    // Fahrzeug
    const fahrzeugResult = await client.query(
      "INSERT INTO fahrzeuge (typ, kennzeichen) VALUES ($1, $2) RETURNING id",
      ["Sprinter", "CLP-HG 123"]
    );
    const fahrzeugId = fahrzeugResult.rows[0].id;

    // Tour
    const datum = new Date().toISOString().slice(0, 10);
    const tourResult = await client.query(
      "INSERT INTO touren (datum, fahrzeug_id, fahrer_id, startzeit, bemerkung) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [datum, fahrzeugId, fahrerIds[0], "08:00", "Demo-Tour"]
    );
    const tourId = tourResult.rows[0].id;

    // Stopps
    const stopps = [
      "Bahnhofstr. 12, 49699 Lindern",
      "Industriestr. 8, 49661 Cloppenburg",
      "Bremer Str. 45, 26135 Oldenburg",
      "Am Markt 5, 26203 Wardenburg"
    ];

    let counter = 1;
    for (const adresse of stopps) {
      const stopp = await client.query(
        "INSERT INTO stopps (tour_id, adresse, reihenfolge, erledigt, qr_code) VALUES ($1,$2,$3,false,$4) RETURNING id",
        [tourId, adresse, counter, `STOPP-${counter}`]
      );

      await client.query(
        "INSERT INTO stoppdetails (stopp_id, ankunftszeit, kunde, kommission, kundenadresse, anmerkung) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          stopp.rows[0].id,
          `${8 + counter}:00`,
          `Kunde ${counter}`,
          `KOM-${100 + counter}`,
          adresse,
          `Anmerkung ${counter}`
        ]
      );

      counter++;
    }

    await client.query("COMMIT");

    res.json({ message: "✅ Demo-Tour eingefügt" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Fehler bei /seed-demo", details: err.message });
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
