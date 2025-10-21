const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Tabellen erstellen/erweitern
async function initDb() {
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
      qr_code TEXT,
      ankunftszeit TIME,
      kunde TEXT,
      kommission TEXT,
      anmerkung TEXT
    );
  `);
  console.log("✅ Tabellen erfolgreich geprüft/erstellt");
}

// Fahrer abrufen
app.get("/fahrer", async (req, res) => {
  const result = await pool.query("SELECT * FROM fahrer ORDER BY id");
  res.json(result.rows);
});

// Tourdaten inkl. neuer Felder abrufen
app.get("/touren/:fahrer_id/:datum", async (req, res) => {
  const { fahrer_id, datum } = req.params;
  try {
    const result = await pool.query(
      `SELECT t.id as tour_id, s.id as stopp_id, s.adresse, s.reihenfolge, 
              s.lat, s.lng, s.erledigt, s.ankunftszeit, s.kunde, s.kommission, s.anmerkung
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

// QR-Code Check-in
app.post("/scan", async (req, res) => {
  const { stopp_id } = req.body;
  try {
    await pool.query("UPDATE stopps SET erledigt = true WHERE id = $1", [
      stopp_id
    ]);
    res.json({ message: "Stopp bestätigt" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim QR-Scan" });
  }
});

// 🚀 Seed-Demo
app.get("/seed-demo", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fahrer
    const fahrerRes = await client.query(
      `INSERT INTO fahrer (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      ["Christoph Arlt"]
    );
    const fahrerId = fahrerRes.rows[0].id;

    // Fahrzeug
    const fahrzeugRes = await client.query(
      `INSERT INTO fahrzeuge (typ, kennzeichen) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING id`,
      ["Sprinter", "CLP-AR 123"]
    );
    const fahrzeugId =
      fahrzeugRes.rows.length > 0 ? fahrzeugRes.rows[0].id : 1;

    // Datum für morgen
    const morgen = new Date();
    morgen.setDate(morgen.getDate() + 1);
    const datum = morgen.toISOString().slice(0, 10);

    // Tour
    const tourRes = await client.query(
      `INSERT INTO touren (datum, fahrzeug_id, fahrer_id, startzeit, bemerkung)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [datum, fahrzeugId, fahrerId, "08:00", "Demo-Tour mit Extras"]
    );
    const tourId = tourRes.rows[0].id;

    // Stopps mit neuen Feldern
    const stopps = [
      {
        adresse: "Lindern (Oldenburg), Rathaus",
        lat: 52.845,
        lng: 7.767,
        qr: "QR-001",
        ankunftszeit: "08:30",
        kunde: "Musterkunde A",
        kommission: "KOM-1001",
        anmerkung: "Beim Nachbarn abgeben"
      },
      {
        adresse: "Lastrup, Ortsmitte",
        lat: 52.783,
        lng: 7.867,
        qr: "QR-002",
        ankunftszeit: "09:00",
        kunde: "Kunde B",
        kommission: "KOM-1002",
        anmerkung: "Barzahlung"
      },
      {
        adresse: "Cloppenburg, Bahnhof",
        lat: 52.847,
        lng: 8.042,
        qr: "QR-003",
        ankunftszeit: "09:30",
        kunde: "Kunde C",
        kommission: "KOM-1003",
        anmerkung: "Große Lieferung"
      },
      {
        adresse: "Oldenburg, Innenstadt",
        lat: 53.143,
        lng: 8.214,
        qr: "QR-004",
        ankunftszeit: "10:00",
        kunde: "Kunde D",
        kommission: "KOM-1004",
        anmerkung: "Lieferung ins Büro"
      }
    ];

    for (let i = 0; i < stopps.length; i++) {
      await client.query(
        `INSERT INTO stopps 
         (tour_id, adresse, lat, lng, reihenfolge, qr_code, ankunftszeit, kunde, kommission, anmerkung)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          tourId,
          stopps[i].adresse,
          stopps[i].lat,
          stopps[i].lng,
          i + 1,
          stopps[i].qr,
          stopps[i].ankunftszeit,
          stopps[i].kunde,
          stopps[i].kommission,
          stopps[i].anmerkung
        ]
      );
    }

    await client.query("COMMIT");

    res.json({
      message: "✅ Demo-Tour erstellt mit Extra-Feldern",
      fahrerId,
      fahrzeugId,
      tourId,
      datum,
      stopps: stopps.length
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Fehler bei /seed-demo:", err);
    res.status(500).json({
      error: "Fehler beim Seed",
      details: err.message
    });
  } finally {
    client.release();
  }
});

// Root
app.get("/", (req, res) => {
  res.send("🚚 Tourenplan API läuft ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`API läuft auf Port ${PORT}`);
  await initDb();
});
