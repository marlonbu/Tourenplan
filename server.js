import express from "express";
import cors from "cors";
import pg from "pg";
import multer from "multer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;
app.use(cors());
app.use(express.json());

// 📁 Upload-Ordner bereitstellen
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
app.use("/uploads", express.static("uploads"));

// Multer-Konfiguration (für spätere OneDrive-Integration vorbereitet)
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, "uploads/"),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});
const upload = multer({ storage });

// DB-Verbindung
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Auth-Middleware
const auth = (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token || token !== "Gehlenborg") {
    return res.status(401).json({ error: "Kein gültiger Token" });
  }
  next();
};

// Tabellen erzeugen
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      fahrer_id INT REFERENCES fahrer(id) ON DELETE CASCADE,
      datum DATE NOT NULL,
      bemerkung TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stopps (
      id SERIAL PRIMARY KEY,
      tour_id INT REFERENCES touren(id) ON DELETE CASCADE,
      kunde TEXT,
      adresse TEXT,
      telefon TEXT,
      kommission TEXT,
      hinweis TEXT,
      position INT,
      foto_url TEXT
    );
  `);
  console.log("✅ Tabellen geprüft/erstellt + Cascade aktiv");
})();

// ========== FAHRER ==========
app.get("/fahrer", auth, async (_req, res) => {
  const result = await pool.query("SELECT * FROM fahrer ORDER BY name ASC");
  res.json(result.rows);
});

app.post("/fahrer", auth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name erforderlich" });
  const result = await pool.query(
    "INSERT INTO fahrer (name) VALUES ($1) RETURNING *",
    [name]
  );
  res.json(result.rows[0]);
});

app.delete("/fahrer/:id", auth, async (req, res) => {
  await pool.query("DELETE FROM fahrer WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// ========== TOUREN ==========
app.post("/touren", auth, async (req, res) => {
  const { fahrer_id, datum } = req.body;
  if (!fahrer_id || !datum)
    return res.status(400).json({ error: "Fahrer & Datum erforderlich" });
  const result = await pool.query(
    "INSERT INTO touren (fahrer_id, datum) VALUES ($1, $2) RETURNING *",
    [fahrer_id, datum]
  );
  res.json(result.rows[0]);
});

app.get("/touren/:fahrer_id/:datum", auth, async (req, res) => {
  const { fahrer_id, datum } = req.params;
  const tour = await pool.query(
    "SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2",
    [fahrer_id, datum]
  );
  if (tour.rows.length === 0)
    return res.json({ tour: null, stopps: [] });

  const stopps = await pool.query(
    "SELECT * FROM stopps WHERE tour_id=$1 ORDER BY position ASC",
    [tour.rows[0].id]
  );
  res.json({ tour: tour.rows[0], stopps: stopps.rows });
});

// ========== STOPPS ==========
app.post("/stopps/:tour_id", auth, async (req, res) => {
  const { kunde, adresse, telefon, kommission, hinweis, position } = req.body;
  const r = await pool.query(
    `INSERT INTO stopps (tour_id, kunde, adresse, telefon, kommission, hinweis, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.params.tour_id, kunde, adresse, telefon, kommission, hinweis, position]
  );
  res.json(r.rows[0]);
});

app.delete("/stopps/:id", auth, async (req, res) => {
  await pool.query("DELETE FROM stopps WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// ========== 📸 FOTO-UPLOAD ==========
app.post("/stopps/:id/foto", auth, upload.single("foto"), async (req, res) => {
  try {
    const stoppId = req.params.id;
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Keine Datei erhalten" });

    // 🔄 Später hier OneDrive-Upload einfügen:
    // const onedriveUrl = await uploadToOneDrive(file);

    const localUrl = `${req.protocol}://${req.get("host")}/uploads/${file.filename}`;
    const result = await pool.query(
      "UPDATE stopps SET foto_url=$1 WHERE id=$2 RETURNING *",
      [localUrl, stoppId]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "Stopp nicht gefunden" });

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Fehler beim Foto-Upload:", err);
    res.status(500).json({ error: "Fehler beim Foto-Upload" });
  }
});

// ========== 📸 FOTO-LÖSCHEN ==========
app.delete("/stopps/:id/foto", auth, async (req, res) => {
  try {
    const stoppId = req.params.id;
    const cur = await pool.query("SELECT foto_url FROM stopps WHERE id=$1", [stoppId]);
    const url = cur.rows[0]?.foto_url;

    if (url) {
      const filename = path.basename(url);
      const filePath = path.join("uploads", filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    const result = await pool.query(
      "UPDATE stopps SET foto_url=NULL WHERE id=$1 RETURNING *",
      [stoppId]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Stopp nicht gefunden" });

    res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ Fehler beim Foto-Löschen:", err);
    res.status(500).json({ error: "Fehler beim Foto-Löschen" });
  }
});

app.listen(port, () =>
  console.log(`🚀 Tourenplan Backend läuft auf Port ${port}`)
);
