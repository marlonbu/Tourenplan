const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
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

  // Sorgt dafür, dass Kennzeichen nicht doppelt angelegt werden (idempotente Seeds)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fahrzeuge_kennzeichen ON fahrzeuge(kennzeichen);
  `);

  console.log("✅ Tabellen erfolgreich geprüft/erstellt");
}

/* =========================
   Basis-Endpunkte
========================= */

// Alle Fahrer
app.get("/fahrer", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fahrer ORDER BY id");
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

// Tour für Fahrer an Datum (jetzt mit allen Zusatzfeldern)
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
    console.error("Fehler /touren:", err);
    res.status(500).json({ error: "Fehler beim Laden der Touren" });
  }
});

// QR-Scan → erledigt setzen
app.post("/scan", async (req, res) => {
  const { stopp_id } = req.body;
  if (!stopp_id) return res.status(400).json({ error: "stopp_id fehlt" });
  try {
    await pool.query("UPDATE stopps SET erledigt = true WHERE id = $1", [stopp_id]);
    res.json({ message: "Stopp bestätigt" });
  } catch (err) {
    console.error("Fehler /scan:", err);
    res.status(500).json({ error: "Fehler beim QR-Scan" });
  }
});

// Debug: alles ausgeben
app.get("/all", async (req, res) => {
  try {
    const [fahrer, fahrzeuge, touren, stopps] = await Promise.all([
      pool.query("SELECT * FROM fahrer ORDER BY id"),
      pool.query("SELECT * FROM fahrzeuge ORDER BY id"),
      pool.query("SELECT * FROM touren ORDER BY id"),
      pool.query("SELECT * FROM stopps ORDER BY id"),
    ]);
    res.json({
      fahrer: fahrer.rows,
      fahrzeuge: fahrzeuge.rows,
      touren: touren.rows,
      stopps: stopps.rows,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fehler bei /all" });
  }
});

/* =========================
   Reset & Seed (idempotent)
========================= */

// ❌ ALLES leeren + IDs zurücksetzen
app.get("/reset", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Reihenfolge wichtig wegen FK: zuerst stopps → touren → fahrzeuge/fahrer
    await client.query(`TRUNCATE TABLE stopps, touren, fahrzeuge, fahrer RESTART IDENTITY CASCADE;`);

    await client.query("COMMIT");
    res.json({ message: "Alle Tabellen geleert" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Fehler bei /reset:", err);
    res.status(500).json({ error: "Fehler beim Reset", details: err.message });
  } finally {
    client.release();
  }
});

// 🚀 Demo-Daten für heute/morgen/übermorgen (ohne Duplikate)
app.get("/seed-demo", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fahrer idempotent
    const fahrerName = "Christoph Arlt";
    const fahrerSel = await client.query("SELECT id FROM fahrer WHERE name = $1", [fahrerName]);
    const fahrerId = fahrerSel.rows[0]
      ? fahrerSel.rows[0].id
      : (await client.query(
          "INSERT INTO fahrer (name) VALUES ($1) RETURNING id",
          [fahrerName]
        )).rows[0].id;

    // Fahrzeug idempotent (per Unique-Index auf kennzeichen)
    const kennz = "CLP-AR 123";
    const fahrzeugSel = await client.query("SELECT id FROM fahrzeuge WHERE kennzeichen = $1", [kennz]);
    const fahrzeugId = fahrzeugSel.rows[0]
      ? fahrzeugSel.rows[0].id
      : (await client.query(
          "INSERT INTO fahrzeuge (typ, kennzeichen) VALUES ($1, $2) RETURNING id",
          ["Sprinter", kennz]
        )).rows[0].id;

    // 3 Tage: heute, morgen, übermorgen
    const dates = [0, 1, 2].map((offset) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return d.toISOString().slice(0, 10);
    });

    const responseTours = [];

    for (const datum of dates) {
      // Falls es schon Touren für diesen Fahrer/Datum gibt → vorher komplett entfernen (inkl. Stopps)
      const existingTours = await client.query(
        "SELECT id FROM touren WHERE fahrer_id = $1 AND datum = $2",
        [fahrerId, datum]
      );
      if (existingTours.rows.length > 0) {
        const ids = existingTours.rows.map((r) => r.id);
        await client.query("DELETE FROM stopps WHERE tour_id = ANY($1::int[])", [ids]);
        await client.query("DELETE FROM touren WHERE id = ANY($1::int[])", [ids]);
      }

      // Tour anlegen
      const tourRes = await client.query(
        `INSERT INTO touren (datum, fahrzeug_id, fahrer_id, startzeit, bemerkung)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [datum, fahrzeugId, fahrerId, "08:00", `Demo-Tour für ${datum}`]
      );
      const tourId = tourRes.rows[0].id;

      // Stopps
      const stopps = [
        {
          adresse: "Lindern (Oldenburg), Rathaus",
          lat: 52.845, lng: 7.767,
          ankunftszeit: "08:30", kunde: "Musterkunde A", kommission: "KOM-1001",
          anmerkung: "Beim Nachbarn abgeben", qr: "QR-001"
        },
        {
          adresse: "Lastrup, Ortsmitte",
          lat: 52.783, lng: 7.867,
          ankunftszeit: "09:00", kunde: "Kunde B", kommission: "KOM-1002",
          anmerkung: "Barzahlung", qr: "QR-002"
        },
        {
          adresse: "Cloppenburg, Bahnhof",
          lat: 52.847, lng: 8.042,
          ankunftszeit: "09:30", kunde: "Kunde C", kommission: "KOM-1003",
          anmerkung: "Große Lieferung", qr: "QR-003"
        },
        {
          adresse: "Oldenburg, Innenstadt",
          lat: 53.143, lng: 8.214,
          ankunftszeit: "10:00", kunde: "Kunde D", kommission: "KOM-1004",
          anmerkung: "Lieferung ins Büro", qr: "QR-004"
        },
      ];

      for (let i = 0; i < stopps.length; i++) {
        const s = stopps[i];
        await client.query(
          `INSERT INTO stopps
           (tour_id, adresse, lat, lng, reihenfolge, erledigt, qr_code, ankunftszeit, kunde, kommission, anmerkung)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [tourId, s.adresse, s.lat, s.lng, i + 1, false, s.qr, s.ankunftszeit, s.kunde, s.kommission, s.anmerkung]
        );
      }

      responseTours.push({ datum, tourId, stopps: stopps.length });
    }

    await client.query("COMMIT");
    res.json({
      message: "✅ Demo-Touren für heute, morgen und übermorgen erstellt (idempotent)",
      fahrerId,
      fahrzeugId,
      tours: responseTours,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Fehler bei /seed-demo:", err);
    res.status(500).json({ error: "Fehler beim Seed", details: err.message });
  } finally {
    client.release();
  }
});

/* =========================
   Root & Start
========================= */

app.get("/", (req, res) => {
  res.send("🚚 Tourenplan API läuft ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`API läuft auf Port ${PORT}`);
  await initDb();
});
