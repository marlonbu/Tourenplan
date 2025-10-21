import express from "express";
import pg from "pg";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ✅ Tabellen erstellen, wenn nicht vorhanden
async function initDB() {
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
      tour_id INT REFERENCES touren(id) ON DELETE CASCADE,
      adresse TEXT,
      lat NUMERIC,
      lng NUMERIC,
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

// ✅ Endpunkt: Reset (löscht & erstellt neu)
app.get("/reset-db", async (req, res) => {
  try {
    await pool.query(`
      DROP TABLE IF EXISTS stopps CASCADE;
      DROP TABLE IF EXISTS touren CASCADE;
      DROP TABLE IF EXISTS fahrzeuge CASCADE;
      DROP TABLE IF EXISTS fahrer CASCADE;
    `);
    await initDB();
    res.json({ success: true, message: "Tabellen zurückgesetzt & neu erstellt" });
  } catch (err) {
    res.status(500).json({ error: "Fehler bei /reset-db", details: err.message });
  }
});

// ✅ Endpunkt: Seed mit Demo-Daten
app.get("/seed-demo", async (req, res) => {
  try {
    // Fahrer
    const fahrer = ["Christoph Arlt", "Hans Noll", "Johannes Backhaus", "Markus Honkomp"];
    for (let name of fahrer) {
      await pool.query(`INSERT INTO fahrer (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
    }

    // Fahrzeuge
    const fahrzeuge = [
      { typ: "Sprinter", kennzeichen: "CLP-HG 123" },
      { typ: "LKW", kennzeichen: "OL-AB 456" }
    ];
    for (let f of fahrzeuge) {
      await pool.query(
        `INSERT INTO fahrzeuge (typ, kennzeichen) VALUES ($1, $2) ON CONFLICT (kennzeichen) DO NOTHING`,
        [f.typ, f.kennzeichen]
      );
    }

    // Hole IDs für Fahrer & Fahrzeug
    const fahrerRes = await pool.query(`SELECT * FROM fahrer WHERE name = 'Christoph Arlt'`);
    const fahrzeugRes = await pool.query(`SELECT * FROM fahrzeuge LIMIT 1`);
    const fahrerId = fahrerRes.rows[0].id;
    const fahrzeugId = fahrzeugRes.rows[0].id;

    // Demo-Tour für morgen
    const tourRes = await pool.query(
      `INSERT INTO touren (datum, fahrzeug_id, fahrer_id, startzeit, bemerkung)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [new Date(Date.now() + 24 * 60 * 60 * 1000), fahrzeugId, fahrerId, "08:00", "Demo-Tour"]
    );
    const tourId = tourRes.rows[0].id;

    // Stopps mit Zufallsdaten
    const stopps = [
      {
        adresse: "Lindenstraße 12, 49699 Lindern",
        lat: 52.85,
        lng: 7.77,
        reihenfolge: 1,
        kunde: "Kunde A",
        kommission: "12345",
        anmerkung: "Lieferung morgens",
        ankunftszeit: "09:00"
      },
      {
        adresse: "Bahnhofstraße 5, 49661 Cloppenburg",
        lat: 52.85,
        lng: 8.05,
        reihenfolge: 2,
        kunde: "Kunde B",
        kommission: "23456",
        anmerkung: "Palette",
        ankunftszeit: "10:00"
      },
      {
        adresse: "Bremer Heerstraße 200, 26135 Oldenburg",
        lat: 53.14,
        lng: 8.23,
        reihenfolge: 3,
        kunde: "Kunde C",
        kommission: "34567",
        anmerkung: "Express",
        ankunftszeit: "11:00"
      },
      {
        adresse: "Hauptstraße 1, 26122 Oldenburg",
        lat: 53.14,
        lng: 8.21,
        reihenfolge: 4,
        kunde: "Kunde D",
        kommission: "45678",
        anmerkung: "Besonderer Hinweis",
        ankunftszeit: "12:00"
      }
    ];

    for (let s of stopps) {
      await pool.query(
        `INSERT INTO stopps (tour_id, adresse, lat, lng, reihenfolge, kunde, kommission, anmerkung, ankunftszeit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tourId, s.adresse, s.lat, s.lng, s.reihenfolge, s.kunde, s.kommission, s.anmerkung, s.ankunftszeit]
      );
    }

    res.json({ success: true, message: "Demo-Daten eingetragen" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Seed", details: err.message });
  }
});

// ✅ Endpunkte für Frontend
app.get("/fahrer", async (req, res) => {
  const result = await pool.query("SELECT * FROM fahrer ORDER BY id");
  res.json(result.rows);
});

app.get("/touren/:fahrerId/:datum", async (req, res) => {
  const { fahrerId, datum } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2`,
      [fahrerId, datum]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden der Touren" });
  }
});

app.get("/stopps/:tourId", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM stopps WHERE tour_id=$1 ORDER BY reihenfolge`, [
      req.params.tourId,
    ]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden der Stopps" });
  }
});

// Start
app.listen(PORT, () => {
  console.log(`🚀 API läuft auf Port ${PORT}`);
  initDB();
});
