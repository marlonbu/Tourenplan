import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import cors from "cors";
import jwt from "jsonwebtoken";

const app = express();
app.use(bodyParser.json());
app.use(cors());

// 🔑 JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || "meinGeheimesToken";

// Benutzer festlegen
const USERS = [
  { username: "Gehlenborg", password: "Orga1023/" }
];

// PostgreSQL Verbindung
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Tabellen prüfen
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS fahrzeuge (
      id SERIAL PRIMARY KEY,
      typ TEXT NOT NULL,
      kennzeichen TEXT NOT NULL
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      datum DATE NOT NULL,
      fahrzeug_id INT REFERENCES fahrzeuge(id),
      fahrer_id INT REFERENCES fahrer(id),
      startzeit TIME,
      bemerkung TEXT
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS stopps (
      id SERIAL PRIMARY KEY,
      tour_id INT REFERENCES touren(id) ON DELETE CASCADE,
      adresse TEXT NOT NULL,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      reihenfolge INT,
      erledigt BOOLEAN DEFAULT false,
      qr_code TEXT,
      ankunftszeit TIME,
      kunde TEXT,
      kommission TEXT,
      telefon TEXT,
      anmerkung TEXT
    );
  `);

  console.log("✅ Tabellen erfolgreich geprüft/erstellt");
}
initDB();

// Middleware: Token prüfen
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Kein Token vorhanden" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Ungültiger Token" });
    req.user = user;
    next();
  });
}

// Login Endpoint
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = USERS.find(u => u.username === username && u.password === password);

  if (!user) {
    return res.status(401).json({ error: "Ungültiger Benutzername oder Passwort" });
  }

  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: "8h" });
  res.json({ token });
});

// Fahrer abrufen
app.get("/fahrer", authenticateToken, async (req, res) => {
  const result = await db.query("SELECT * FROM fahrer");
  res.json(result.rows);
});

// Touren eines Fahrers für ein Datum
app.get("/touren/:fahrerId/:datum", authenticateToken, async (req, res) => {
  try {
    const { fahrerId, datum } = req.params;
    const result = await db.query(
      "SELECT * FROM stopps WHERE tour_id IN (SELECT id FROM touren WHERE fahrer_id=$1 AND datum=$2) ORDER BY reihenfolge",
      [fahrerId, datum]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Fehler beim Laden der Touren:", err);
    res.status(500).json({ error: "Fehler beim Laden der Touren" });
  }
});

// Reset
app.get("/reset", async (req, res) => {
  try {
    await db.query("TRUNCATE stopps, touren, fahrzeuge, fahrer RESTART IDENTITY CASCADE");
    res.json({ message: "✅ Datenbank zurückgesetzt" });
  } catch (err) {
    console.error("Fehler bei Reset:", err);
    res.status(500).json({ error: "Fehler bei Reset" });
  }
});

// Demo-Daten einfügen
app.get("/seed-demo", async (req, res) => {
  try {
    const fahrerRes = await db.query(
      "INSERT INTO fahrer (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id",
      ["Christoph Arlt"]
    );
    const fahrerId = fahrerRes.rows[0]?.id || 1;

    const fahrzeugRes = await db.query(
      "INSERT INTO fahrzeuge (typ, kennzeichen) VALUES ($1, $2) RETURNING id",
      ["Sprinter", "CLP-HG 123"]
    );
    const fahrzeugId = fahrzeugRes.rows[0].id;

    const tourRes = await db.query(
      "INSERT INTO touren (datum, fahrzeug_id, fahrer_id, startzeit, bemerkung) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      ["2025-10-22", fahrzeugId, fahrerId, "09:00", "Demo-Tour"]
    );
    const tourId = tourRes.rows[0].id;

    await db.query(
      `INSERT INTO stopps (tour_id, adresse, lat, lng, reihenfolge, kunde, kommission, telefon, anmerkung) VALUES
      ($1,'Musterstraße 1, 12345 Musterstadt',52.52,13.405,1,'Kunde A','KOM-1001','01511234567','Lieferung EG'),
      ($1,'Beispielweg 5, 26121 Oldenburg',53.14,8.21,2,'Kunde B','KOM-1002','01731234567','2. Etage links')`,
      [tourId]
    );

    res.json({ message: "✅ Demodaten eingefügt", fahrerId, fahrzeugId, tourId });
  } catch (err) {
    console.error("Fehler bei Seed:", err);
    res.status(500).json({ error: "Fehler bei /seed-demo", details: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 API läuft auf Port ${PORT}`));
