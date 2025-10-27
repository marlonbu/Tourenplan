import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pkg from "pg";
import jwt from "jsonwebtoken";
import multer from "multer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "tourenplan_secret";

app.use(cors());
app.use(bodyParser.json());

// DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Tabellen + Fahrer
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fahrer (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS touren (
      id SERIAL PRIMARY KEY,
      fahrer_id INTEGER REFERENCES fahrer(id),
      datum DATE NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stopps (
      id SERIAL PRIMARY KEY,
      tour_id INTEGER REFERENCES touren(id),
      kunde TEXT,
      adresse TEXT,
      kommission TEXT,
      hinweis TEXT,
      telefon TEXT,
      status TEXT,
      foto_url TEXT,
      ankunft TEXT,
      position TEXT
    );
  `);
  const c = await pool.query("SELECT COUNT(*) FROM fahrer");
  if (parseInt(c.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO fahrer (name) VALUES
      ('Christoph Arlt'),
      ('Hans Noll'),
      ('Johannes Backhaus'),
      ('Markus Honkomp');
    `);
    console.log("✅ Fahrer hinzugefügt (Standardliste)");
  }
  console.log("✅ Tabellen überprüft/erstellt");
}
initDB();

// Auth
function verifyToken(req, res, next) {
  const header = req.headers["authorization"];
  if (!header) return res.status(401).json({ error: "Kein Token" });
  const token = header.split(" ")[1];
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Ungültiger Token" });
  }
}

// Login
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "Gehlenborg" && password === "Orga1023/") {
    const token = jwt.sign({ user: "Gehlenborg" }, JWT_SECRET, { expiresIn: "8h" });
    return res.json({ token });
  }
  return res.status(401).json({ error: "Falsche Zugangsdaten" });
});

// Fahrer
app.get("/fahrer", verifyToken, async (_, res) => {
  const r = await pool.query("SELECT id, name FROM fahrer ORDER BY name ASC");
  res.json(r.rows);
});

// Tour + Stopps (Tag)
app.get("/touren/:fahrerId/:datum", verifyToken, async (req, res) => {
  const { fahrerId, datum } = req.params;
  let tour = await pool.query("SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2", [fahrerId, datum]);
  if (tour.rows.length === 0) {
    tour = await pool.query("INSERT INTO touren (fahrer_id, datum) VALUES ($1,$2) RETURNING *", [fahrerId, datum]);
  }
  const stopps = await pool.query("SELECT * FROM stopps WHERE tour_id=$1 ORDER BY id ASC", [tour.rows[0].id]);
  res.json({ tour: tour.rows[0], stopps: stopps.rows });
});

// Gesamt/Filter
app.get("/touren-woche", verifyToken, async (req, res) => {
  const { von, bis, fahrer_id, kunde } = req.query;
  let sql = `
    SELECT t.datum, f.name AS fahrer_name, s.kunde, s.adresse, s.kommission
    FROM stopps s
    JOIN touren t ON s.tour_id = t.id
    JOIN fahrer f ON t.fahrer_id = f.id
    WHERE 1=1
  `;
  const params = [];
  if (von) { params.push(von); sql += ` AND t.datum >= $${params.length}`; }
  if (bis) { params.push(bis); sql += ` AND t.datum <= $${params.length}`; }
  if (fahrer_id) { params.push(fahrer_id); sql += ` AND t.fahrer_id = $${params.length}`; }
  if (kunde) { params.push(`%${kunde}%`); sql += ` AND s.kunde ILIKE $${params.length}`; }
  sql += " ORDER BY t.datum DESC, f.name ASC";
  const r = await pool.query(sql, params);
  res.json(r.rows);
});

// Stopps anlegen
app.post("/stopps", verifyToken, async (req, res) => {
  const { fahrer_id, datum, kunde, adresse, kommission, hinweis, telefon, position } = req.body;
  if (!fahrer_id || !datum) return res.status(400).json({ error: "Fehlende Felder" });
  let tour = await pool.query("SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2", [fahrer_id, datum]);
  if (tour.rows.length === 0) {
    tour = await pool.query("INSERT INTO touren (fahrer_id, datum) VALUES ($1,$2) RETURNING *", [fahrer_id, datum]);
  }
  const r = await pool.query(
    `INSERT INTO stopps (tour_id,kunde,adresse,kommission,hinweis,telefon,position)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tour.rows[0].id, kunde, adresse, kommission, hinweis, telefon, position]
  );
  res.json(r.rows[0]);
});

// Stopp löschen
app.delete("/stopps/:id", verifyToken, async (req, res) => {
  await pool.query("DELETE FROM stopps WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// Foto-Upload
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({ storage });
app.post("/upload-foto", verifyToken, upload.single("foto"), async (req, res) => {
  const { stopp_id } = req.body;
  const filePath = `/uploads/${req.file.filename}`;
  await pool.query("UPDATE stopps SET foto_url=$1 WHERE id=$2", [filePath, stopp_id]);
  res.json({ success: true, foto_url: filePath });
});
app.use("/uploads", express.static(uploadDir));

app.get("/", (_, res) => res.send("✅ Tourenplan Backend läuft (CRUD + Upload + Fahrer-Init)"));

app.listen(PORT, () => {
  console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`);
});
