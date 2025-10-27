import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import jwt from "jsonwebtoken";
import multer from "multer";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;

// === Middleware ===
app.use(cors());
app.use(bodyParser.json());
app.use("/uploads", express.static("uploads"));

// === PostgreSQL Verbindung ===
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// === Multer für Foto-Uploads ===
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

// === JWT Middleware ===
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Kein Token" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "orga1023");
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Ungültiger Token" });
  }
}

// === Tabellen erstellen ===
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      fahrer_id INTEGER REFERENCES fahrer(id),
      datum DATE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stopps (
      id SERIAL PRIMARY KEY,
      tour_id INTEGER REFERENCES touren(id),
      kunde TEXT,
      adresse TEXT,
      kommission TEXT,
      hinweis TEXT,
      telefon TEXT,
      status TEXT DEFAULT 'offen',
      foto_url TEXT,
      ankunft TIMESTAMP,
      position INTEGER
    );
  `);

  // Fahrer hinzufügen (wenn leer)
  const fahrer = [
    "Christoph Arlt",
    "Hans Noll",
    "Johannes Backhaus",
    "Markus Honkomp",
  ];
  for (const name of fahrer) {
    await pool.query("INSERT INTO fahrer (name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
  }
  console.log("✅ Tabellen überprüft/erstellt");
}
initDB();

// === LOGIN ===
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (username === "Gehlenborg" && password === "Orga1023/") {
    const token = jwt.sign({ username, role: "admin" }, process.env.JWT_SECRET || "orga1023", {
      expiresIn: "8h",
    });
    return res.json({ token });
  }
  res.status(401).json({ error: "Falsche Zugangsdaten" });
});

// === Aktuellen Benutzer abrufen ===
app.get("/me", auth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

// === Fahrer-Liste ===
app.get("/fahrer", auth, async (req, res) => {
  const result = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
  res.json(result.rows);
});

// === Tour für Fahrer + Datum abrufen ===
app.get("/touren/:fahrerId/:datum", auth, async (req, res) => {
  const { fahrerId, datum } = req.params;
  const tour = await pool.query(
    "SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2",
    [fahrerId, datum]
  );
  if (tour.rows.length === 0) {
    return res.status(404).json({ error: "Keine Tour gefunden" });
  }
  const tourId = tour.rows[0].id;
  const stopps = await pool.query(
    "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position ASC",
    [tourId]
  );
  res.json({ tour: tour.rows[0], stopps: stopps.rows });
});

// === Neue Tour anlegen ===
app.post("/touren", auth, async (req, res) => {
  const { fahrer_id, datum } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO touren (fahrer_id, datum) VALUES ($1, $2) RETURNING *",
      [fahrer_id, datum]
    );
    res.json({ tour: result.rows[0] });
  } catch (err) {
    console.error("Fehler beim Anlegen der Tour:", err);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour" });
  }
});

// === Stopp hinzufügen ===
app.post("/stopps", auth, async (req, res) => {
  const { tour_id, kunde, adresse, kommission, hinweis, telefon, position } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO stopps (tour_id, kunde, adresse, kommission, hinweis, telefon, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tour_id, kunde, adresse, kommission, hinweis, telefon, position]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Fehler beim Hinzufügen des Stopps:", err);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Stopps" });
  }
});

// === Stopp löschen ===
app.delete("/stopps/:id", auth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM stopps WHERE id=$1", [id]);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Fehler beim Löschen" });
  }
});

// === Foto-Upload ===
app.post("/stopps/:id/foto", auth, upload.single("foto"), async (req, res) => {
  const { id } = req.params;
  const foto_url = `/uploads/${req.file.filename}`;
  await pool.query("UPDATE stopps SET foto_url=$1 WHERE id=$2", [foto_url, id]);
  res.json({ success: true, foto_url });
});

// === Server starten ===
app.listen(PORT, () => {
  console.log(`🚀 Backend läuft auf Port ${PORT}`);
});
