const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const app = express();
const port = process.env.PORT || 3000;

// Geheimschlüssel für JWT
const SECRET_KEY = process.env.JWT_SECRET || "meinSuperPasswort";

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL Verbindung
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Middleware: Auth prüfen
function authenticateToken(req, res, next) {
  // Pass-Token aus dem Header
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// === Login Endpoint ===
app.post("/login", (req, res) => {
  const { password } = req.body;

  // Passwortcheck (nur ein globales Passwort!)
  if (password === (process.env.APP_PASSWORD || "1234")) {
    const token = jwt.sign({ user: "admin" }, SECRET_KEY, { expiresIn: "8h" });
    res.json({ token });
  } else {
    res.status(401).json({ error: "Falsches Passwort" });
  }
});

// === Fahrer abrufen ===
app.get("/fahrer", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fahrer ORDER BY id ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

// === Touren abrufen ===
app.get("/touren/:fahrerId/:datum", authenticateToken, async (req, res) => {
  const { fahrerId, datum } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2 ORDER BY id ASC",
      [fahrerId, datum]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Laden der Touren" });
  }
});

// === Reset ===
app.get("/reset", authenticateToken, async (req, res) => {
  try {
    await pool.query("TRUNCATE touren, fahrer RESTART IDENTITY CASCADE");
    res.json({ message: "Reset erfolgreich" });
  } catch (err) {
    res.status(500).json({ error: "Fehler beim Reset" });
  }
});

// === Seed Demo ===
app.get("/seed-demo", authenticateToken, async (req, res) => {
  try {
    // Fahrer hinzufügen
    await pool.query(`
      INSERT INTO fahrer (name) VALUES 
      ('Christoph Arlt'), 
      ('Hans Noll'), 
      ('Johannes Backhaus'), 
      ('Markus Honkomp')
      ON CONFLICT DO NOTHING;
    `);

    // Demo-Tour für Christoph Arlt am 22.10.2025
    await pool.query(`
      INSERT INTO touren (fahrer_id, datum, kunde, kommission, adresse, telefon, anmerkung, ankunftszeit, lat, lng, status)
      VALUES 
      (1, '2025-10-22', 'Möbel Müller', 'KOM-1001', 'Lindern, Hauptstraße 12', '04962-123456', 'Bitte hinten abladen', '08:30', 52.839, 7.774, ''),
      (1, '2025-10-22', 'Wohnwelt Schmidt', 'KOM-1002', 'Cloppenburg, Bahnhofstraße 7', '04471-234567', '', '10:00', 52.847, 8.05, ''),
      (1, '2025-10-22', 'Küchenstudio Meyer', 'KOM-1003', 'Oldenburg, Nadorster Straße 25', '0441-345678', 'Vorsicht Glas', '12:00', 53.143, 8.213, ''),
      (1, '2025-10-22', 'Möbel Hansa', 'KOM-1004', 'Oldenburg, Alexanderstraße 99', '0441-987654', '', '13:30', 53.15, 8.22, '')
      ON CONFLICT DO NOTHING;
    `);

    res.json({ message: "Demo Daten erstellt" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Fehler beim Seed", details: err.message });
  }
});

// === Server starten ===
app.listen(port, () => {
  console.log(`🚀 Server läuft auf Port ${port}`);
});
