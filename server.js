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

// Tabellen automatisch erstellen, falls sie nicht existieren
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
    console.error(err);
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
    console.error(err);
    res.status(500).json({ error: "Fehler beim QR-Scan" });
  }
});

// Datei-Upload (Platzhalter)
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

// SEED-ENDPUNKT für Demodaten
app.get("/seed", async (req, res) => {
  try {
    // Fahrer einfügen
    const fahrer = await pool.query(
      "INSERT INTO fahrer (name) VALUES ($1) RETURNING id",
      ["Hans Mustermann"]
    );

    // Fahrzeug einfügen
    const fahrzeug = await pool.query(
      "INSERT INTO fahrzeuge (typ, kennzeichen) VALUES ($1, $2) RETURNING id",
      ["Sprinter", "CLP-HG 123"]
    );

    // Tour einfügen (für heute)
    const tour = await pool.query(
      "INSERT INTO touren (datum, fahrzeug_id, fahrer_id, startzeit, bemerkung) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [new Date().toISOString().slice(0, 10), fahrzeug.rows[0].id, fahrer.rows[0].id, "08:00", "Demo-Tour"]
    );

    // Stopp einfügen
    await pool.query(
      "INSERT INTO stopps (tour_id, adresse, lat, lng, reihenfolge, qr_code) VALUES ($1, $2, $3, $4, $5, $6)",
      [tour.rows[0].id, "Musterstraße 1, 12345 Musterstadt", 52.52, 13.405, 1, "QR-DEMO-123"]
    );

    res.json({ message: "✅ Demodaten wurden eingefügt!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Einfügen der Demodaten" });
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
  await initDb(); // Tabellen beim Start prüfen/erstellen
});
