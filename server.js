import express from "express";
import bodyParser from "body-parser";
import pkg from "pg";
import cors from "cors";

const { Pool } = pkg;
const app = express();
app.use(bodyParser.json());
app.use(cors());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Tabellen erstellen
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrzeuge (
      id SERIAL PRIMARY KEY,
      typ TEXT NOT NULL,
      kennzeichen TEXT UNIQUE NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      datum DATE NOT NULL,
      fahrzeug_id INTEGER REFERENCES fahrzeuge(id),
      fahrer_id INTEGER REFERENCES fahrer(id),
      startzeit TIME,
      bemerkung TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS stopps (
      id SERIAL PRIMARY KEY,
      tour_id INTEGER REFERENCES touren(id) ON DELETE CASCADE,
      adresse TEXT NOT NULL,
      lat NUMERIC,
      lng NUMERIC,
      reihenfolge INTEGER,
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

// ✅ Seed-Daten: DB reset + neue Demo-Tour
app.get("/seed-demo", async (req, res) => {
  try {
    await initDb();

    // Alles löschen und IDs zurücksetzen
    await pool.query(`
      TRUNCATE stopps, touren, fahrzeuge, fahrer RESTART IDENTITY CASCADE;
    `);

    // Fahrer
    const fahrer = ["Christoph Arlt", "Hans Noll", "Johannes Backhaus", "Markus Honkomp"];
    for (let name of fahrer) {
      await pool.query(`INSERT INTO fahrer (name) VALUES ($1)`, [name]);
    }

    // Fahrzeuge
    const fahrzeuge = [
      { typ: "Sprinter", kennzeichen: "CLP-AR 123" },
      { typ: "Sprinter", kennzeichen: "CLP-NO 456" }
    ];
    for (let f of fahrzeuge) {
      await pool.query(`INSERT INTO fahrzeuge (typ, kennzeichen) VALUES ($1,$2)`, [f.typ, f.kennzeichen]);
    }

    // Tour für morgen (für Fahrer 1 und Fahrzeug 1)
    const morgen = new Date();
    morgen.setDate(morgen.getDate() + 1);
    const datum = morgen.toISOString().slice(0, 10);

    const tourRes = await pool.query(
      `INSERT INTO touren (datum, fahrzeug_id, fahrer_id, startzeit, bemerkung)
       VALUES ($1, 1, 1, '08:00:00', 'Demo-Tour West') RETURNING id`,
      [datum]
    );
    const tourId = tourRes.rows[0].id;

    // Stopps
    const stopps = [
      {
        adresse: "Bahnhofstraße 1, 49699 Lindern",
        lat: 52.843,
        lng: 7.772,
        reihenfolge: 1,
        kunde: "Kunde A",
        kommission: "KOM-1001",
        ankunftszeit: "09:00:00",
        anmerkung: "Anruf vor Anlieferung"
      },
      {
        adresse: "Industriestraße 8, 49661 Cloppenburg",
        lat: 52.847,
        lng: 8.047,
        reihenfolge: 2,
        kunde: "Kunde B",
        kommission: "KOM-1002",
        ankunftszeit: "10:30:00",
        anmerkung: "Palette"
      },
      {
        adresse: "Bremer Heerstraße 200, 26135 Oldenburg",
        lat: 53.143,
        lng: 8.223,
        reihenfolge: 3,
        kunde: "Kunde C",
        kommission: "KOM-1003",
        ankunftszeit: "12:00:00",
        anmerkung: "Expresslieferung"
      },
      {
        adresse: "Am Markt 5, 26203 Wardenburg",
        lat: 53.046,
        lng: 8.201,
        reihenfolge: 4,
        kunde: "Kunde D",
        kommission: "KOM-1004",
        ankunftszeit: "13:30:00",
        anmerkung: "Besonderer Hinweis"
      }
    ];

    for (let s of stopps) {
      await pool.query(
        `INSERT INTO stopps 
         (tour_id, adresse, lat, lng, reihenfolge, kunde, kommission, ankunftszeit, anmerkung)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tourId, s.adresse, s.lat, s.lng, s.reihenfolge, s.kunde, s.kommission, s.ankunftszeit, s.anmerkung]
      );
    }

    res.json({ message: "✅ Demo-Daten erstellt", tourId });
  } catch (err) {
    console.error("❌ Fehler beim Seed:", err);
    res.status(500).json({ error: "Fehler beim Seed", details: err.message });
  }
});

// Fahrer-Endpunkt
app.get("/fahrer", async (req, res) => {
  const result = await pool.query("SELECT * FROM fahrer ORDER BY id");
  res.json(result.rows);
});

// Touren nach Fahrer und Datum
app.get("/touren/:fahrerId/:datum", async (req, res) => {
  const { fahrerId, datum } = req.params;
  const result = await pool.query(
    `SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2`,
    [fahrerId, datum]
  );
  res.json(result.rows);
});

// Stopps für eine Tour
app.get("/stopps/:tourId", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY reihenfolge",
    [req.params.tourId]
  );
  res.json(result.rows);
});

// Startseite
app.get("/", (req, res) => {
  res.send("🚚 Tourenplan API läuft – Tabellen geprüft ✅");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ API läuft auf Port ${PORT}`);
  initDb();
});
