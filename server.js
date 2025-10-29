import express from "express";
import cors from "cors";
import pkg from "pg";
import multer from "multer";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;
const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

// === DB-Setup ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads"));

// === Auth-Middleware ===
const auth = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "Kein Token" });
  const token = header.split(" ")[1];
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ error: "Ungültiger Token" });
  }
};

// === Tabellen erstellen ===
const initTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      fahrer_id INTEGER REFERENCES fahrer(id) ON DELETE CASCADE,
      datum DATE NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stopps (
      id SERIAL PRIMARY KEY,
      tour_id INTEGER REFERENCES touren(id) ON DELETE CASCADE,
      kunde TEXT,
      adresse TEXT,
      telefon TEXT,
      kommission TEXT,
      hinweis TEXT,
      position INTEGER,
      foto_url TEXT,
      foto_name TEXT
    );
  `);
  console.log("✅ Tabellen überprüft/erstellt");
};
initTables();

// === Login ===
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (username === "Gehlenborg" && password === "Orga1023/") {
    const token = jwt.sign({ user: username }, JWT_SECRET, { expiresIn: "8h" });
    res.json({ token });
  } else {
    res.status(401).json({ error: "Login fehlgeschlagen" });
  }
});

// === Fahrer ===
app.get("/fahrer", auth, async (_req, res) => {
  try {
    const r = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
    res.json(r.rows);
  } catch {
    res.status(500).json({ error: "Fehler beim Laden der Fahrer" });
  }
});

app.post("/fahrer", auth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name erforderlich" });
  try {
    const r = await pool.query(
      "INSERT INTO fahrer (name) VALUES ($1) RETURNING *",
      [name]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error("Fehler beim Hinzufügen:", err);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Fahrers" });
  }
});

app.delete("/fahrer/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM fahrer WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Fehler beim Löschen:", err);
    res.status(500).json({ error: "Fehler beim Löschen des Fahrers" });
  }
});

// === Touren ===
app.post("/touren", auth, async (req, res) => {
  const { fahrer_id, datum } = req.body;
  if (!fahrer_id || !datum)
    return res.status(400).json({ error: "Fahrer & Datum erforderlich" });
  try {
    const result = await pool.query(
      "INSERT INTO touren (fahrer_id, datum) VALUES ($1,$2) RETURNING *",
      [fahrer_id, datum]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Fehler beim Anlegen der Tour:", err);
    res.status(500).json({ error: "Fehler beim Anlegen der Tour" });
  }
});

app.get("/touren/:fahrerId/:datum", auth, async (req, res) => {
  const { fahrerId, datum } = req.params;
  try {
    const t = await pool.query(
      "SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2",
      [fahrerId, datum]
    );
    if (t.rows.length === 0) return res.json({ tour: null, stopps: [] });

    const s = await pool.query(
      "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position ASC",
      [t.rows[0].id]
    );
    res.json({ tour: t.rows[0], stopps: s.rows });
  } catch (err) {
    console.error("Fehler beim Laden der Tour:", err);
    res.status(500).json({ error: "Fehler beim Laden der Tour" });
  }
});

// === Stopps ===
app.post("/stopps/:tour_id", auth, async (req, res) => {
  const { tour_id } = req.params;
  const { kunde, adresse, telefon, kommission, hinweis, position } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO stopps (tour_id, kunde, adresse, telefon, kommission, hinweis, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tour_id, kunde, adresse, telefon, kommission, hinweis, position]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Fehler beim Hinzufügen des Stopps:", err);
    res.status(500).json({ error: "Fehler beim Hinzufügen des Stopps" });
  }
});

app.delete("/stopps/:id", auth, async (req, res) => {
  try {
    await pool.query("DELETE FROM stopps WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Fehler beim Löschen des Stopps:", err);
    res.status(500).json({ error: "Fehler beim Löschen des Stopps" });
  }
});

// === Foto Upload ===
const upload = multer({ dest: "uploads/" });

app.post("/stopps/:id/foto", auth, upload.single("foto"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ error: "Kein Foto hochgeladen" });
  const stoppId = req.params.id;
  const filePath = `/uploads/${req.file.filename}`;
  try {
    const r = await pool.query(
      "UPDATE stopps SET foto_url=$1, foto_name=$2 WHERE id=$3 RETURNING *",
      [filePath, req.file.originalname, stoppId]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error("Fehler beim Speichern des Fotos:", err);
    res.status(500).json({ error: "Fehler beim Speichern des Fotos" });
  }
});

app.delete("/stopps/:id/foto", auth, async (req, res) => {
  const stoppId = req.params.id;
  try {
    const r = await pool.query("SELECT foto_url FROM stopps WHERE id=$1", [stoppId]);
    if (r.rows.length && r.rows[0].foto_url) {
      const filePath = path.join(".", r.rows[0].foto_url);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    const result = await pool.query(
      "UPDATE stopps SET foto_url=NULL, foto_name=NULL WHERE id=$1 RETURNING *",
      [stoppId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Fehler beim Löschen des Fotos:", err);
    res.status(500).json({ error: "Fehler beim Löschen des Fotos" });
  }
});

// === Debug ===
app.get("/touren-debug", async (_req, res) => {
  const r = await pool.query("SELECT * FROM touren ORDER BY id DESC");
  res.json(r.rows);
});

app.listen(PORT, () =>
  console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`)
);
