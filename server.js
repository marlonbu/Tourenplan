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
    res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
  }
});

// Fahrzeuge-Liste
app.get("/fahrzeuge", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, typ, kennzeichen FROM fahrzeuge ORDER BY id");
    res.json(result.rows);
  } catch (err) {
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
    res.status(500).json({ error: "Fehler beim Laden der Touren" });
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

// Datei-Upload (Dummy)
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

// Alle Daten (Debug)
app.get("/all", async (req, res) => {
  try {
    const fahrer = await pool.query("SELECT * FROM fahrer");
    const fahrzeuge = await pool.query("SELECT * FROM fahrzeuge");
    const touren = await pool.query("SELECT * FROM touren");
    const stopps = await pool.query("SELECT * FROM stopps");

    res.json({ fahrer: fahrer.rows, fahrzeuge: fahrzeuge.rows, touren: touren.rows, stopps: stopps.rows });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Abrufen aller Daten" });
  }
});

// Reset
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
    res.json({ message: "🗑️ Alle Daten wurden gelöscht" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Fehler beim Reset" });
  } finally {
    client.release();
  }
});

// Seed-Demo für morgen
app.get("/seed-demo", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fahrer finden
    const fahrerResult = await client.query("SELECT id FROM fahrer WHERE name = $1", ["Christoph Arlt"]);
    if (fahrerResult.rows.length === 0) {
      throw new Error("Fahrer Christoph Arlt nicht gefunden. Bitte zuerst /seed ausführen.");
    }
    const fahrerId = fahrerResult.rows[0].id;

    // Fahrzeug
    const fahrzeugResult = await client.query(
      "INSERT INTO fahrzeuge (typ, kennzeichen) VALUES ($1, $2) RETURNING id",
      ["Sprinter", "CLP-HG 456"]
    );
    const fahrzeugId = fahrzeugResult.rows[0].id;

    // Datum morgen
    const morgen = new Date();
    morgen.setDate(morgen.getDate() + 1);
    const datum = morgen.toISOString().slice(0, 10);

    // Tour
    const tourResult = await client.query(
      "INSERT INTO touren (datum, fahrzeug_id, fahrer_id, startzeit, bemerkung) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [datum, fahrzeugId, fahrerId, "09:00", "Demo-Tour Lindern → Oldenburg"]
    );
    const tourId = tourResult.rows[0].id;

    // Stopps
    const stopps = [
      { adresse: "Bahnhofstraße 10, 49699 Lindern", lat: 52.836, lng: 7.767, qr: "STOPP-001" },
      { adresse: "Cloppenburger Straße 55, 49661 Cloppenburg", lat: 52.847, lng: 8.045, qr: "STOPP-002" },
      { adresse: "Bremer Straße 120, 26135 Oldenburg", lat: 53.128, lng: 8.225, qr: "STOPP-003" },
      { adresse: "Schloßplatz 1, 26122 Oldenburg", lat: 53.143, lng: 8.213, qr: "STOPP-004" }
    ];

    for (let i = 0; i < stopps.length; i++) {
      const s = stopps[i];
      await client.query(
        "INSERT INTO stopps (tour_id, adresse, lat, lng, reihenfolge, qr_code) VALUES ($1, $2, $3, $4, $5, $6)",
        [tourId, s.adresse, s.lat, s.lng, i + 1, s.qr]
      );
    }

    await client.query("COMMIT");

    res.json({ message: `✅ Demo-Tour für Christoph Arlt am ${datum} erstellt`, tourId, fahrzeugId, stopps });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Fehler bei /seed-demo", details: err.message });
  } finally {
    client.release();
  }
});

// Root
app.get("/", (req, res) => {
  res.send("🚚 Tourenplan API läuft – Tabellen wurden geprüft/erstellt ✅");
});

// Server starten
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`API läuft auf Port ${PORT}`);
  await initDb();
});
