import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pkg from "pg";
import jwt from "jsonwebtoken";
import multer from "multer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";

dotenv.config();
const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "tourenplan_secret";

app.use(cors());
app.use(bodyParser.json());

// ======================================================
// DB
// ======================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ======================================================
// Init DB (Tabellen + Basisdaten)
// ======================================================
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS benutzer (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      rolle TEXT NOT NULL CHECK (rolle IN ('admin', 'fahrer')),
      fahrer_id INTEGER REFERENCES fahrer(id)
    );
  `);

  // Fahrer seeden (nur wenn leer)
  const fCount = await pool.query("SELECT COUNT(*) FROM fahrer");
  if (parseInt(fCount.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO fahrer (name) VALUES
      ('Christoph Arlt'),
      ('Hans Noll'),
      ('Johannes Backhaus'),
      ('Markus Honkomp');
    `);
    console.log("✅ Fahrer hinzugefügt (Standardliste)");
  }

  // Admin & Beispiel-Fahrer-User seeden (nur wenn fehlend)
  const adminUser = "Gehlenborg";
  const adminPass = "Orga1023/"; // wie bisher
  const adminExists = await pool.query("SELECT 1 FROM benutzer WHERE username=$1", [adminUser]);
  if (adminExists.rowCount === 0) {
    const hash = await bcrypt.hash(adminPass, 10);
    await pool.query(
      "INSERT INTO benutzer (username, password_hash, rolle, fahrer_id) VALUES ($1,$2,'admin',NULL)",
      [adminUser, hash]
    );
    console.log("✅ Admin-Benutzer angelegt (username: Gehlenborg)");
  }

  // Beispiel-Fahrer Nutzer (Passwort: Start123!) – anpassbar/entfernbar
  const fahrerCredentials = [
    { username: "carlt", name: "Christoph Arlt" },
    { username: "hnoll", name: "Hans Noll" },
    { username: "jbackhaus", name: "Johannes Backhaus" },
    { username: "mhonkomp", name: "Markus Honkomp" },
  ];
  for (const u of fahrerCredentials) {
    const exists = await pool.query("SELECT 1 FROM benutzer WHERE username=$1", [u.username]);
    if (exists.rowCount === 0) {
      const f = await pool.query("SELECT id FROM fahrer WHERE name=$1", [u.name]);
      if (f.rowCount) {
        const hash = await bcrypt.hash("Start123!", 10);
        await pool.query(
          "INSERT INTO benutzer (username, password_hash, rolle, fahrer_id) VALUES ($1,$2,'fahrer',$3)",
          [u.username, hash, f.rows[0].id]
        );
      }
    }
  }

  console.log("✅ Tabellen überprüft/erstellt");
}
initDB();

// ======================================================
// Auth Helpers
// ======================================================
function verifyToken(req, res, next) {
  const header = req.headers["authorization"];
  if (!header) return res.status(401).json({ error: "Kein Token" });
  const token = header.split(" ")[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { userId, username, role, fahrer_id }
    next();
  } catch {
    return res.status(401).json({ error: "Ungültiger Token" });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Nur für Admins" });
  next();
}

// ======================================================
// LOGIN (ein Login für Admin & Fahrer)
// ======================================================
app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Fehlende Zugangsdaten" });

  const r = await pool.query("SELECT * FROM benutzer WHERE username=$1", [username]);
  if (r.rowCount === 0) return res.status(401).json({ error: "Benutzer oder Passwort falsch" });

  const user = r.rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Benutzer oder Passwort falsch" });

  const token = jwt.sign(
    { userId: user.id, username: user.username, role: user.rolle, fahrer_id: user.fahrer_id || null },
    JWT_SECRET,
    { expiresIn: "8h" }
  );

  return res.json({
    token,
    role: user.rolle,
    fahrer_id: user.fahrer_id || null,
    username: user.username,
  });
});

// Aktueller User (für Frontend, um Rolle/Fahrer zu kennen)
app.get("/me", verifyToken, async (req, res) => {
  res.json({
    userId: req.user.userId,
    username: req.user.username,
    role: req.user.role,
    fahrer_id: req.user.fahrer_id || null,
  });
});

// ======================================================
// FAHRER
// ======================================================
app.get("/fahrer", verifyToken, async (req, res) => {
  if (req.user.role === "fahrer" && req.user.fahrer_id) {
    const r = await pool.query("SELECT id, name FROM fahrer WHERE id=$1", [req.user.fahrer_id]);
    return res.json(r.rows);
  }
  const r = await pool.query("SELECT id, name FROM fahrer ORDER BY name ASC");
  res.json(r.rows);
});

// ======================================================
// TOUREN – Tagestour eines Fahrers
//  - Fahrer darf nur eigene Touren sehen/bearbeiten
// ======================================================
app.get("/touren/:fahrerId/:datum", verifyToken, async (req, res) => {
  const { fahrerId, datum } = req.params;
  if (req.user.role === "fahrer" && String(req.user.fahrer_id) !== String(fahrerId)) {
    return res.status(403).json({ error: "Kein Zugriff auf fremde Touren" });
  }

  let tour = await pool.query("SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2", [fahrerId, datum]);
  if (tour.rows.length === 0) {
    tour = await pool.query("INSERT INTO touren (fahrer_id, datum) VALUES ($1,$2) RETURNING *", [fahrerId, datum]);
  }
  const stopps = await pool.query("SELECT * FROM stopps WHERE tour_id=$1 ORDER BY id ASC", [tour.rows[0].id]);
  res.json({ tour: tour.rows[0], stopps: stopps.rows });
});

// ======================================================
// TOUREN – Wochen-/Gesamtübersicht (mit Rollenfilter)
// ======================================================
app.get("/touren-woche", verifyToken, async (req, res) => {
  let { von, bis, fahrer_id, kunde } = req.query;

  // Fahrer dürfen nur eigene Touren sehen
  if (req.user.role === "fahrer") {
    fahrer_id = req.user.fahrer_id;
  }

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

// ======================================================
// STOPPS – Anlegen (Fahrer nur für eigene Tour)
// ======================================================
app.post("/stopps", verifyToken, async (req, res) => {
  const { fahrer_id, datum, kunde, adresse, kommission, hinweis, telefon, position } = req.body;
  if (!fahrer_id || !datum) return res.status(400).json({ error: "Fehlende Felder" });

  if (req.user.role === "fahrer" && String(req.user.fahrer_id) !== String(fahrer_id)) {
    return res.status(403).json({ error: "Kein Zugriff (falscher Fahrer)" });
  }

  let tour = await pool.query("SELECT * FROM touren WHERE fahrer_id=$1 AND datum=$2", [fahrer_id, datum]);
  if (tour.rows.length === 0) {
    tour = await pool.query("INSERT INTO touren (fahrer_id, datum) VALUES ($1,$2) RETURNING *", [fahrer_id, datum]);
  }

  const r = await pool.query(
    `INSERT INTO stopps (tour_id, kunde, adresse, kommission, hinweis, telefon, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tour.rows[0].id, kunde, adresse, kommission, hinweis, telefon, position]
  );

  res.json(r.rows[0]);
});

// ======================================================
// STOPPS – Löschen (Fahrer nur eigene)
// ======================================================
app.delete("/stopps/:id", verifyToken, async (req, res) => {
  const { id } = req.params;

  if (req.user.role === "fahrer") {
    // prüfen, ob Stopp zur Tour des Fahrers gehört
    const r = await pool.query(
      `SELECT t.fahrer_id
       FROM stopps s
       JOIN touren t ON s.tour_id = t.id
       WHERE s.id = $1`,
      [id]
    );
    if (!r.rowCount || String(r.rows[0].fahrer_id) !== String(req.user.fahrer_id)) {
      return res.status(403).json({ error: "Kein Zugriff (falscher Fahrer)" });
    }
  }

  await pool.query("DELETE FROM stopps WHERE id=$1", [id]);
  res.json({ success: true });
});

// ======================================================
// FOTO-UPLOAD (lokal in /uploads; OneDrive später)
// ======================================================
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

app.post("/upload-foto", verifyToken, upload.single("foto"), async (req, res) => {
  const { stopp_id } = req.body;

  if (req.user.role === "fahrer") {
    // Zugriffsschutz: gehört der Stopp zum Fahrer?
    const r = await pool.query(
      `SELECT t.fahrer_id
       FROM stopps s
       JOIN touren t ON s.tour_id = t.id
       WHERE s.id = $1`,
      [stopp_id]
    );
    if (!r.rowCount || String(r.rows[0].fahrer_id) !== String(req.user.fahrer_id)) {
      return res.status(403).json({ error: "Kein Zugriff (falscher Fahrer)" });
    }
  }

  const filePath = `/uploads/${req.file.filename}`;
  await pool.query("UPDATE stopps SET foto_url=$1 WHERE id=$2", [filePath, stopp_id]);
  res.json({ success: true, foto_url: filePath });
});

app.use("/uploads", express.static(uploadDir));

// Healthcheck
app.get("/", (_, res) => res.send("✅ Tourenplan Backend (Rollen + CRUD + Upload) läuft"));

app.listen(PORT, () => {
  console.log(`🚀 Tourenplan Backend läuft auf Port ${PORT}`);
});
